import { promises as fs } from "fs"
import path from "path"

import {
  clickhouseConfigured,
  replaceSiteAnalytics,
} from "./clickhouse.js"
import type { JobHandle } from "./data-jobs.js"
import { stageDuplicatiVersion } from "./duplicati-staging.js"
import { UserFacingError } from "./errors.js"
import {
  artifactPathForSpot,
  buildCurrentExportArtifact,
  type SpotDataTarget,
} from "./export-job.js"
import { getGhostSiteMetadata, importDatabaseFromFile } from "./mysql-data.js"
import {
  ANALYTICS_MEMBER,
  extractSpotArchive,
  gunzipFile,
  readArchiveInfo,
  replaceVolumeContents,
  validateStagedRestore,
  type StagedRestore,
} from "./spot-archive.js"
import {
  assertSafeDatabaseName,
  assertSafeName,
  ghostContentVolumeDataDir,
  resolveStagingRelativePath,
  uploadsDir,
} from "./staging.js"

export type RestoreSource =
  | { type: "upload"; uploadRelPath: string }
  | { type: "backup"; backupId: string; versionTime: string }
  /** The spot's current export artifact — used to undo a bad restore. */
  | { type: "artifact" }

async function stageFromArchive({
  archivePath,
  extractDir,
}: {
  archivePath: string
  extractDir: string
}): Promise<StagedRestore> {
  const stat = await fs.stat(archivePath).catch(() => null)

  if (!stat?.isFile() || stat.size === 0) {
    throw new UserFacingError("The archive to restore from was not found.")
  }

  await extractSpotArchive({ archivePath, destDir: extractDir })

  const analyticsJsonlPath = path.join(extractDir, ANALYTICS_MEMBER)
  const hasAnalytics = await fs
    .stat(analyticsJsonlPath)
    .then((entry) => entry.isFile())
    .catch(() => false)

  return {
    contentDir: path.join(extractDir, "content"),
    dbSqlPath: path.join(extractDir, "db.sql"),
    analyticsJsonlPath: hasAnalytics ? analyticsJsonlPath : null,
    info: await readArchiveInfo(extractDir),
  }
}

function resolveUploadPath(uploadRelPath: string): string {
  const resolved = resolveStagingRelativePath(uploadRelPath)

  if (!resolved.startsWith(uploadsDir() + path.sep)) {
    throw new Error("Upload path must be inside the uploads directory.")
  }

  return resolved
}

/**
 * Load the staged analytics over the site's current ones.
 *
 * Runs after the database, so the site_uuid it keys on is the *restored*
 * one — a site restored from another site's archive gets that archive's
 * events under its own new uuid, and nothing is written outside it.
 *
 * Never throws: by this point the volume and the database are already
 * replaced, and failing the job here would flag it as needing attention
 * (offering the undo snapshot) over analytics alone. Problems become
 * warnings on an otherwise successful restore.
 */
async function applyStagedAnalytics({
  handle,
  target,
  staged,
}: {
  handle: JobHandle
  target: SpotDataTarget
  staged: StagedRestore
}): Promise<void> {
  if (!staged.analyticsJsonlPath) {
    // validateStagedRestore already warned that there were none to apply.
    return
  }

  if (!clickhouseConfigured()) {
    await handle.addWarning(
      "This server has no analytics store, so the backup's visitor analytics were not restored.",
    )
    return
  }

  try {
    const { siteUuid } = await getGhostSiteMetadata(target.database)

    if (!siteUuid) {
      await handle.addWarning(
        "The restored site has no analytics id yet, so its visitor analytics were not restored.",
      )
      return
    }

    const { rows } = await replaceSiteAnalytics({
      siteUuid,
      sourcePath: staged.analyticsJsonlPath,
    })

    console.info("Restored site analytics", {
      spotId: target.spotId,
      siteUuid,
      rows,
    })
  } catch (error) {
    console.error("Failed to restore site analytics", {
      spotId: target.spotId,
      error,
    })

    await handle.addWarning(
      "The site's files and database were restored, but its visitor analytics could not be. The analytics that were there before are unchanged.",
    )
  }
}

/**
 * Restore a spot's data. The caller (GhostHost app) is responsible for
 * stopping the Ghost container before starting this job and starting it
 * again afterwards — this pipeline only touches the volume and the database.
 *
 * Order matters: staging (slow, read-only) runs before the undo snapshot so
 * a bad source fails the job before anything is written; the snapshot runs
 * before any mutation so a failed apply can always be rolled back from it.
 */
export async function runRestoreJob({
  handle,
  target,
  source,
}: {
  handle: JobHandle
  target: SpotDataTarget
  source: RestoreSource
}): Promise<void> {
  assertSafeDatabaseName(target.database)
  assertSafeName(target.applicationUuid, "application uuid")

  const extractDir = path.join(handle.workDir, "extract")
  const restoreDir = path.join(handle.workDir, "restore")
  const snapshotWorkDir = path.join(handle.workDir, "snapshot-work")
  let uploadToCleanUp: string | null = null

  try {
    await handle.setPhase("staging")

    let staged: StagedRestore

    if (source.type === "upload") {
      const uploadPath = resolveUploadPath(source.uploadRelPath)
      uploadToCleanUp = uploadPath
      staged = await stageFromArchive({ archivePath: uploadPath, extractDir })
    } else if (source.type === "artifact") {
      // Copy first: the snapshot phase below overwrites the artifact slot,
      // and it must not clobber the archive we are restoring from.
      const artifactCopy = path.join(handle.workDir, "artifact.tar.gz")
      await fs.copyFile(artifactPathForSpot(target.spotId), artifactCopy)
      staged = await stageFromArchive({ archivePath: artifactCopy, extractDir })
    } else {
      const restored = await stageDuplicatiVersion({
        backupId: source.backupId,
        versionTime: source.versionTime,
        applicationUuid: target.applicationUuid,
        database: target.database,
        targetDir: restoreDir,
        signal: handle.signal,
      })

      const dbSqlPath = path.join(handle.workDir, "db.sql")

      if (restored.dbDumpCompressed) {
        await gunzipFile({
          sourcePath: restored.dbDumpPath,
          destPath: dbSqlPath,
          signal: handle.signal,
        })
      } else {
        await fs.copyFile(restored.dbDumpPath, dbSqlPath)
      }

      staged = {
        contentDir: restored.contentDir,
        dbSqlPath,
        analyticsJsonlPath: restored.analyticsDumpPath,
        info: null,
      }
    }

    await handle.setPhase("snapshotting")
    await buildCurrentExportArtifact({
      target,
      workDir: snapshotWorkDir,
      source: { type: "pre-restore-snapshot" },
      signal: handle.signal,
    })

    await handle.setPhase("validating")
    const warnings = await validateStagedRestore({
      staged,
      expectedSpotId: target.spotId,
    })

    for (const warning of warnings) {
      await handle.addWarning(warning)
    }

    // Last cancellation point. From here on nothing gets the abort signal:
    // the volume and database writes must run to the end once begun.
    await handle.setPhase("applying_files")
    await handle.markMutationStarted()
    await replaceVolumeContents({
      volumeDataDir: ghostContentVolumeDataDir(target.applicationUuid),
      sourceContentDir: staged.contentDir,
    })

    await handle.setPhase("applying_db")
    await importDatabaseFromFile({
      database: target.database,
      sqlPath: staged.dbSqlPath,
    })

    await handle.setPhase("applying_analytics")
    await applyStagedAnalytics({ handle, target, staged })
  } finally {
    for (const dir of [extractDir, restoreDir, snapshotWorkDir]) {
      await fs.rm(dir, { recursive: true, force: true })
    }

    await fs.rm(path.join(handle.workDir, "artifact.tar.gz"), { force: true })
    await fs.rm(path.join(handle.workDir, "db.sql"), { force: true })

    if (uploadToCleanUp) {
      await fs.rm(uploadToCleanUp, { force: true })
    }
  }
}
