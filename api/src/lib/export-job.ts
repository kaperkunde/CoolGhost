import { promises as fs } from "fs"
import path from "path"

import type { DataJobArtifact, JobHandle } from "./data-jobs.js"
import { stageDuplicatiVersion } from "./duplicati-staging.js"
import { UserFacingError } from "./errors.js"
import {
  dumpDatabaseToFile,
  getGhostSiteMetadata,
  getMysqlServerVersion,
} from "./mysql-data.js"
import {
  gunzipFile,
  packageSpotArchive,
  SPOT_ARCHIVE_FORMAT_VERSION,
  type SpotArchiveInfo,
} from "./spot-archive.js"
import {
  artifactsDir,
  assertSafeDatabaseName,
  assertSafeName,
  ghostContentVolumeDataDir,
  resolveStagingRelativePath,
  toStagingRelativePath,
} from "./staging.js"

export type ExportSource =
  | { type: "current" }
  | { type: "backup"; backupId: string; backupName: string; versionTime: string }

export type SpotDataTarget = {
  spotId: string
  database: string
  applicationUuid: string
}

function compactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-")
}

export function artifactPathForSpot(spotId: string): string {
  return path.join(artifactsDir(), `${assertSafeName(spotId, "spot id")}.tar.gz`)
}

export function artifactMetaPathForSpot(spotId: string): string {
  return path.join(artifactsDir(), `${assertSafeName(spotId, "spot id")}.json`)
}

/** Metadata written next to each artifact; served via GET /v1/data/spots/:spot/artifact. */
export type ArtifactSidecar = DataJobArtifact & {
  spotId: string
  info: SpotArchiveInfo
}

/**
 * The spot's current export artifact, or null when there is none (never
 * exported, swept by the TTL, or the archive file is missing/partial).
 */
export async function readArtifactSidecar(
  spotId: string,
): Promise<ArtifactSidecar | null> {
  const safeId = assertSafeName(spotId, "spot id")

  let sidecar: ArtifactSidecar

  try {
    sidecar = JSON.parse(
      await fs.readFile(artifactMetaPathForSpot(safeId), "utf8"),
    ) as ArtifactSidecar
  } catch {
    return null
  }

  if (!sidecar?.relPath || sidecar.spotId !== safeId) {
    return null
  }

  const stat = await fs
    .stat(resolveStagingRelativePath(sidecar.relPath))
    .catch(() => null)

  if (!stat?.isFile() || stat.size === 0) {
    return null
  }

  return { ...sidecar, sizeBytes: stat.size }
}

async function writeArtifact({
  target,
  workDir,
  contentDir,
  source,
  siteMetadataDatabase,
}: {
  target: SpotDataTarget
  workDir: string
  contentDir: string
  source: SpotArchiveInfo["source"]
  /** When set, siteTitle/ghost version are read live from this database. */
  siteMetadataDatabase: string | null
}): Promise<DataJobArtifact> {
  const now = new Date()

  const metadata = siteMetadataDatabase
    ? await getGhostSiteMetadata(siteMetadataDatabase)
    : { siteTitle: null, ghostMigrationVersion: null }

  const info: SpotArchiveInfo = {
    formatVersion: SPOT_ARCHIVE_FORMAT_VERSION,
    spotId: target.spotId,
    database: target.database,
    siteTitle: metadata.siteTitle,
    mysqlVersion: await getMysqlServerVersion(),
    ghostMigrationVersion: metadata.ghostMigrationVersion,
    createdAt: now.toISOString(),
    source,
  }

  await fs.writeFile(
    path.join(workDir, "info.json"),
    JSON.stringify(info, null, 2),
    "utf8",
  )

  const artifactPath = artifactPathForSpot(target.spotId)
  await fs.rm(artifactPath, { force: true })

  await packageSpotArchive({ workDir, contentDir, artifactPath })

  const stat = await fs.stat(artifactPath)

  const artifact: DataJobArtifact = {
    relPath: toStagingRelativePath(artifactPath),
    downloadName: `${target.spotId}-export-${compactTimestamp(now)}.tar.gz`,
    sizeBytes: stat.size,
    createdAt: now.toISOString(),
  }

  const sidecar: ArtifactSidecar = { ...artifact, spotId: target.spotId, info }

  await fs.writeFile(
    artifactMetaPathForSpot(target.spotId),
    JSON.stringify(sidecar, null, 2),
    "utf8",
  )

  return artifact
}

/**
 * Build an export artifact of the spot's *current* data (live volume + fresh
 * dump). Also used as the pre-restore undo snapshot.
 */
export async function buildCurrentExportArtifact({
  target,
  workDir,
  source,
}: {
  target: SpotDataTarget
  workDir: string
  source: Extract<
    SpotArchiveInfo["source"],
    { type: "current" } | { type: "pre-restore-snapshot" }
  >
}): Promise<DataJobArtifact> {
  await fs.mkdir(workDir, { recursive: true })

  const contentDir = ghostContentVolumeDataDir(target.applicationUuid)
  const contentStat = await fs.stat(contentDir).catch(() => null)

  if (!contentStat?.isDirectory()) {
    throw new UserFacingError(
      "The Ghost content volume for this site was not found on the server.",
    )
  }

  await dumpDatabaseToFile({
    database: target.database,
    destPath: path.join(workDir, "db.sql"),
  })

  return writeArtifact({
    target,
    workDir,
    contentDir,
    source,
    siteMetadataDatabase: target.database,
  })
}

export async function runExportJob({
  handle,
  target,
  source,
}: {
  handle: JobHandle
  target: SpotDataTarget
  source: ExportSource
}): Promise<void> {
  assertSafeDatabaseName(target.database)
  assertSafeName(target.applicationUuid, "application uuid")

  const workDir = path.join(handle.workDir, "work")
  await fs.mkdir(workDir, { recursive: true })

  try {
    if (source.type === "current") {
      await handle.setPhase("staging")

      const artifact = await buildCurrentExportArtifact({
        target,
        workDir,
        source: { type: "current" },
      })

      await handle.setPhase("packaging")
      await handle.setArtifact(artifact)
      return
    }

    await handle.setPhase("staging")

    const restoreDir = path.join(handle.workDir, "restore")
    const { contentDir, dbDumpGzPath } = await stageDuplicatiVersion({
      backupId: source.backupId,
      versionTime: source.versionTime,
      applicationUuid: target.applicationUuid,
      database: target.database,
      targetDir: restoreDir,
    })

    await handle.setPhase("packaging")

    await gunzipFile({
      sourcePath: dbDumpGzPath,
      destPath: path.join(workDir, "db.sql"),
    })

    const artifact = await writeArtifact({
      target,
      workDir,
      contentDir,
      source: {
        type: "backup",
        backupName: source.backupName,
        versionTime: source.versionTime,
      },
      siteMetadataDatabase: null,
    })

    await handle.setArtifact(artifact)
  } finally {
    // Keep job.json, drop the bulky work data regardless of outcome.
    await fs.rm(workDir, { recursive: true, force: true })
    await fs.rm(path.join(handle.workDir, "restore"), {
      recursive: true,
      force: true,
    })
  }
}
