import { promises as fs } from "fs"
import path from "path"

import type { JobHandle } from "./data-jobs.js"
import { stageDuplicatiVersion } from "./duplicati-staging.js"
import {
  artifactPathForSpot,
  buildCurrentExportArtifact,
  type SpotDataTarget,
} from "./export-job.js"
import { importDatabaseFromFile } from "./mysql-data.js"
import {
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
    throw new Error("The archive to restore from was not found.")
  }

  await extractSpotArchive({ archivePath, destDir: extractDir })

  return {
    contentDir: path.join(extractDir, "content"),
    dbSqlPath: path.join(extractDir, "db.sql"),
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
      })

      const dbSqlPath = path.join(handle.workDir, "db.sql")
      await gunzipFile({
        sourcePath: restored.dbDumpGzPath,
        destPath: dbSqlPath,
      })

      staged = { contentDir: restored.contentDir, dbSqlPath, info: null }
    }

    await handle.setPhase("snapshotting")
    await buildCurrentExportArtifact({
      target,
      workDir: snapshotWorkDir,
      source: { type: "pre-restore-snapshot" },
    })

    await handle.setPhase("validating")
    const warnings = await validateStagedRestore({
      staged,
      expectedSpotId: target.spotId,
      expectedDatabase: target.database,
    })

    for (const warning of warnings) {
      await handle.addWarning(warning)
    }

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
