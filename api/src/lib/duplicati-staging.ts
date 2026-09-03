import { promises as fs } from "fs"
import path from "path"

import { config } from "../config.js"
import {
  duplicatiVersionContainsPath,
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

  // Both pieces must exist in the version before restoring anything. Checking
  // up front gives each miss an accurate error, and guarantees the restore
  // below matches files under both /local and /data — so their largest
  // common prefix is "/" and Duplicati recreates the full directory layout
  // under targetDir. (When only one path matches, Duplicati strips the whole
  // shared prefix — including the volume's _data/ folder — and the restored
  // layout becomes unrecognizable.) Errors from the checks themselves (e.g.
  // Duplicati busy or unreachable) propagate as-is rather than being
  // misreported as a missing-data problem with the chosen version.
  const hasVolume = await duplicatiVersionContainsPath({
    backupId,
    time: versionTime,
    pathPrefix: volumeBackupPath,
  })

  if (!hasVolume) {
    throw new Error(
      "This backup version does not contain data for this site. Pick a version taken while the site was deployed.",
    )
  }

  const dumpFileNameForError = path.posix.basename(dumpBackupPath)

  const hasDump = await duplicatiVersionContainsPath({
    backupId,
    time: versionTime,
    pathPrefix: dumpBackupPath,
  })

  if (!hasDump) {
    throw new Error(
      `This backup version has the site's files but no database dump (${dumpFileNameForError}). It was likely taken before automatic database dumps covered this site — pick a newer version.`,
    )
  }

  await fs.mkdir(targetDir, { recursive: true })

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
