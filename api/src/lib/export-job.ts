import { promises as fs } from "fs"
import path from "path"

import {
  clickhouseConfigured,
  countJsonlRows,
  dumpSiteAnalytics,
  readSiteUuidFromDump,
} from "./clickhouse.js"
import type { DataJobArtifact, JobHandle } from "./data-jobs.js"
import { stageDuplicatiVersion } from "./duplicati-staging.js"
import { UserFacingError } from "./errors.js"
import {
  dumpDatabaseToFile,
  getGhostSiteMetadata,
  getMysqlServerVersion,
} from "./mysql-data.js"
import {
  ANALYTICS_MEMBER,
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
  analytics,
  signal,
}: {
  target: SpotDataTarget
  workDir: string
  contentDir: string
  source: SpotArchiveInfo["source"]
  /** When set, siteTitle/ghost version are read live from this database. */
  siteMetadataDatabase: string | null
  /** Describes the analytics.jsonl already written into workDir, if any. */
  analytics: SpotArchiveInfo["analytics"]
  signal?: AbortSignal
}): Promise<DataJobArtifact> {
  const now = new Date()

  const metadata = siteMetadataDatabase
    ? await getGhostSiteMetadata(siteMetadataDatabase)
    : { siteTitle: null, ghostMigrationVersion: null, siteUuid: null }

  const info: SpotArchiveInfo = {
    formatVersion: SPOT_ARCHIVE_FORMAT_VERSION,
    spotId: target.spotId,
    database: target.database,
    siteTitle: metadata.siteTitle,
    mysqlVersion: await getMysqlServerVersion(),
    ghostMigrationVersion: metadata.ghostMigrationVersion,
    createdAt: now.toISOString(),
    source,
    analytics,
  }

  await fs.writeFile(
    path.join(workDir, "info.json"),
    JSON.stringify(info, null, 2),
    "utf8",
  )

  const artifactPath = artifactPathForSpot(target.spotId)
  await fs.rm(artifactPath, { force: true })

  await packageSpotArchive({ workDir, contentDir, artifactPath, signal })

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
/**
 * Dump the site's analytics into the archive's work dir.
 *
 * Never fatal: a site with no analytics stack, no site_uuid yet or an
 * unreachable ClickHouse still gets a complete database + content export.
 * The caller turns the returned message into a job warning.
 */
async function dumpAnalyticsForArchive({
  database,
  workDir,
  signal,
}: {
  database: string
  workDir: string
  signal?: AbortSignal
}): Promise<{
  analytics: SpotArchiveInfo["analytics"]
  warning: string | null
}> {
  if (!clickhouseConfigured()) {
    return {
      analytics: null,
      warning:
        "This server has no analytics store, so the export contains no visitor analytics.",
    }
  }

  const { siteUuid } = await getGhostSiteMetadata(database)

  if (!siteUuid) {
    return {
      analytics: null,
      warning:
        "This site has not recorded any visitor analytics yet, so the export contains none.",
    }
  }

  try {
    const { rows } = await dumpSiteAnalytics({
      siteUuid,
      destPath: path.join(workDir, ANALYTICS_MEMBER),
      signal,
    })

    return { analytics: { siteUuid, rows }, warning: null }
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }

    console.error("Failed to dump site analytics", { database, error })
    await fs.rm(path.join(workDir, ANALYTICS_MEMBER), { force: true })

    return {
      analytics: null,
      warning:
        "The site's visitor analytics could not be read, so the export contains none.",
    }
  }
}

export async function buildCurrentExportArtifact({
  target,
  workDir,
  source,
  onWarning,
  signal,
}: {
  target: SpotDataTarget
  workDir: string
  source: Extract<
    SpotArchiveInfo["source"],
    { type: "current" } | { type: "pre-restore-snapshot" }
  >
  /** Called for anything the archive could not include (analytics, so far). */
  onWarning?: (warning: string) => Promise<void> | void
  /** Aborts the dump and packaging (a cancelled job). */
  signal?: AbortSignal
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
    signal,
  })

  const { analytics, warning } = await dumpAnalyticsForArchive({
    database: target.database,
    workDir,
    signal,
  })

  if (warning) {
    await onWarning?.(warning)
  }

  return writeArtifact({
    target,
    workDir,
    contentDir,
    source,
    siteMetadataDatabase: target.database,
    analytics,
    signal,
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
        onWarning: (warning) => handle.addWarning(warning),
        signal: handle.signal,
      })

      await handle.setPhase("packaging")
      await handle.setArtifact(artifact)
      return
    }

    await handle.setPhase("staging")

    const restoreDir = path.join(handle.workDir, "restore")
    const { contentDir, dbDumpPath, dbDumpCompressed, analyticsDumpPath } =
      await stageDuplicatiVersion({
        backupId: source.backupId,
        versionTime: source.versionTime,
        applicationUuid: target.applicationUuid,
        database: target.database,
        targetDir: restoreDir,
        signal: handle.signal,
      })

    await handle.setPhase("packaging")

    const dbSqlPath = path.join(workDir, "db.sql")

    if (dbDumpCompressed) {
      await gunzipFile({
        sourcePath: dbDumpPath,
        destPath: dbSqlPath,
        signal: handle.signal,
      })
    } else {
      await fs.copyFile(dbDumpPath, dbSqlPath)
    }

    // The backup holds the analytics as they were at that restore point —
    // taken by the same pre-backup hook that wrote the SQL dump, so the
    // archive is one consistent moment rather than old data beside live
    // analytics. Live ClickHouse is deliberately not consulted here.
    let analytics: SpotArchiveInfo["analytics"] = null

    if (analyticsDumpPath) {
      const destPath = path.join(workDir, ANALYTICS_MEMBER)
      await fs.copyFile(analyticsDumpPath, destPath)

      const siteUuid = await readSiteUuidFromDump(destPath)
      const rows = await countJsonlRows(destPath)

      if (siteUuid) {
        analytics = { siteUuid, rows }
      } else {
        // No rows, so nothing identifies the site — an empty member would
        // tell a restore to wipe the site's analytics, which this export
        // cannot vouch for.
        await fs.rm(destPath, { force: true })
      }
    }

    if (!analytics) {
      await handle.addWarning(
        "This backup version has no visitor analytics, so the export contains none.",
      )
    }

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
      analytics,
      signal: handle.signal,
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
