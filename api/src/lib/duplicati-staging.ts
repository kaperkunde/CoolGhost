import { promises as fs } from "fs"
import path from "path"

import { config } from "../config.js"
import {
  duplicatiVersionContainsPath,
  isDuplicatiMissingDataBlocksError,
  isDuplicatiMissingRemoteFilesError,
  repairDuplicatiBackup,
  startDuplicatiRestore,
  waitForDuplicatiTask,
} from "./duplicati.js"
import {
  dbDumpBackupPath,
  ghostContentVolumeBackupPath,
  stagingRoot,
  toStagingRelativePath,
} from "./staging.js"

/**
 * Materialize one spot's data (content volume + SQL dump) from a Duplicati
 * backup version into a directory under the staging mount. Duplicati writes
 * into the same shared mount, so the result is directly readable here.
 */

function duplicatiPathFor(absStagingPath: string): string {
  const duplicatiRoot = config.duplicatiStagingDir ?? stagingRoot()

  return path.posix.join(
    duplicatiRoot,
    toStagingRelativePath(absStagingPath).split(path.sep).join("/"),
  )
}

async function findFirst({
  rootDir,
  matches,
  maxDepth,
}: {
  rootDir: string
  matches: (entryPath: string, isDirectory: boolean) => boolean
  maxDepth: number
}): Promise<string | null> {
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: rootDir, depth: 0 },
  ]

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!

    let entries: import("fs").Dirent[]

    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)

      if (matches(entryPath, entry.isDirectory())) {
        return entryPath
      }

      if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: entryPath, depth: depth + 1 })
      }
    }
  }

  return null
}

export async function stageDuplicatiVersion({
  backupId,
  versionTime,
  applicationUuid,
  database,
  targetDir,
}: {
  backupId: string
  versionTime: string
  applicationUuid: string
  database: string
  targetDir: string
}): Promise<{ contentDir: string; dbDumpGzPath: string }> {
  const volumeBackupPath = ghostContentVolumeBackupPath(applicationUuid)
  const dumpBackupPath = dbDumpBackupPath(database)

  const hasVolume = await duplicatiVersionContainsPath({
    backupId,
    time: versionTime,
    pathPrefix: volumeBackupPath,
  }).catch(() => false)

  if (!hasVolume) {
    throw new Error(
      "This backup version does not contain data for this site. Pick a version taken while the site was deployed.",
    )
  }

  await fs.mkdir(targetDir, { recursive: true })

  const runRestore = async () => {
    const taskId = await startDuplicatiRestore({
      backupId,
      time: versionTime,
      paths: [volumeBackupPath, dumpBackupPath],
      targetPath: duplicatiPathFor(targetDir),
    })

    await waitForDuplicatiTask({
      taskId,
      timeoutMs: config.duplicatiRestoreTimeoutMinutes * 60 * 1000,
    })
  }

  try {
    await runRestore()
  } catch (error) {
    // Duplicati's local database can drift out of sync with the backup
    // destination (interrupted upload, something external touching the
    // destination, ...) — its own error message points at "repair" as the
    // fix. Run it automatically and retry once instead of dead-ending the
    // export/restore on something the site owner can't act on.
    if (
      !(
        error instanceof Error &&
        isDuplicatiMissingRemoteFilesError(error.message)
      )
    ) {
      throw error
    }

    console.warn(
      "Duplicati reported missing remote files; running repair and retrying",
      { backupId, versionTime, error: error.message },
    )

    try {
      await repairDuplicatiBackup(backupId)
    } catch (repairError) {
      // Repair refused because actual data (not just bookkeeping) is gone.
      // Discarding those index entries is a real, permanent loss call — not
      // something to make silently on the backend. Surface a clear, non-
      // technical message to the site owner and leave the operator-facing
      // detail (which files, that "purge-broken-files" is the fix) in the
      // server log for whoever runs Duplicati's own UI to act on safely
      // (it can resolve the destination + credentials; we'd be guessing).
      if (
        repairError instanceof Error &&
        isDuplicatiMissingDataBlocksError(repairError.message)
      ) {
        console.error(
          "Duplicati backup has permanently missing data blocks; needs a manual purge-broken-files run",
          { backupId, versionTime, error: repairError.message },
        )

        throw new Error(
          "This backup version can no longer be restored — part of its data is permanently missing from storage. Try a different version, or contact support if this keeps happening.",
        )
      }

      throw repairError
    }

    await runRestore()
  }

  // Duplicati strips the largest common prefix when restoring to a new
  // location, so the exact layout under targetDir varies — locate the
  // restored pieces instead of assuming paths.
  const volumeDirName = `${applicationUuid}_ghost-content-data`
  const dumpFileName = `${database}.sql.gz`

  const contentDir =
    (await findFirst({
      rootDir: targetDir,
      maxDepth: 8,
      matches: (entryPath, isDirectory) =>
        isDirectory &&
        path.basename(entryPath) === "_data" &&
        entryPath.includes(volumeDirName),
    })) ??
    (await findFirst({
      rootDir: targetDir,
      maxDepth: 8,
      matches: (entryPath, isDirectory) =>
        isDirectory && path.basename(entryPath) === "_data",
    }))

  if (!contentDir) {
    throw new Error(
      "Duplicati restore finished but the Ghost content folder was not found in the restored files.",
    )
  }

  const dbDumpGzPath = await findFirst({
    rootDir: targetDir,
    maxDepth: 8,
    matches: (entryPath, isDirectory) =>
      !isDirectory && path.basename(entryPath) === dumpFileName,
  })

  if (!dbDumpGzPath) {
    throw new Error(
      `Duplicati restore finished but the database dump (${dumpFileName}) was not found. The hourly pre-backup dump may not have covered this database yet.`,
    )
  }

  return { contentDir, dbDumpGzPath }
}
