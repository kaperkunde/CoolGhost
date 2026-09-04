import { promises as fs } from "fs"
import path from "path"

import { config } from "../config.js"
import {
  duplicatiVersionContainsPath,
  startDuplicatiRestore,
  tryListDuplicatiDirectory,
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

function duplicatiStagingRoot(): string {
  return config.duplicatiStagingDir ?? stagingRoot()
}

function duplicatiPathFor(absStagingPath: string): string {
  return path.posix.join(
    duplicatiStagingRoot(),
    toStagingRelativePath(absStagingPath).split(path.sep).join("/"),
  )
}

/**
 * Marker directory in the staging root. A directory rather than a file so it
 * shows up in a folder-only listing too.
 */
const MOUNT_PROBE_DIR_NAME = ".coolghost-mount-probe"

function stagingMountAdvice(): string {
  return (
    `The api's staging directory is "${stagingRoot()}" and Duplicati is told ` +
    `to restore into "${duplicatiStagingRoot()}". Those are paths inside two ` +
    "different containers and they must resolve to the same directory on the " +
    "host: mount the same host directory (STAGING_HOST_DIR) into both the api " +
    "and the duplicati service, and set DUPLICATI_STAGING_DIR to the path it " +
    "has inside the duplicati container."
  )
}

function entryName(entry: string): string {
  return entry.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? entry
}

/**
 * The api and duplicati must have the *same host directory* mounted: the api
 * creates the job's restore dir in it and duplicati writes the restored files
 * there. When only one side is wired up — the per-resource production stacks
 * deploy no duplicati of their own, so its mounts are configured by hand —
 * every restore still reports success, because duplicati happily creates the
 * path inside its own container and the api is left looking at an empty
 * directory. Catch that here rather than after an hour-long restore.
 *
 * Advisory: Duplicati's folder-browser endpoint is not part of the documented
 * surface this client otherwise relies on, so an unusable answer means "could
 * not check" and the restore goes ahead — the post-restore checks below still
 * name the problem.
 */
async function assertStagingMountShared(): Promise<void> {
  const probeDir = path.join(stagingRoot(), MOUNT_PROBE_DIR_NAME)

  await fs.mkdir(probeDir, { recursive: true })

  const seen = await tryListDuplicatiDirectory(duplicatiStagingRoot())

  if (seen === null) {
    return
  }

  if (!seen.some((entry) => entryName(entry) === MOUNT_PROBE_DIR_NAME)) {
    throw new Error(
      `Duplicati cannot see the api's staging directory. ${stagingMountAdvice()}`,
    )
  }
}

/** A few restored paths (relative to targetDir) to show in an error message. */
async function describeRestoreOutput(targetDir: string): Promise<string[]> {
  const found: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: targetDir, depth: 0 },
  ]

  while (queue.length > 0 && found.length < 20) {
    const { dir, depth } = queue.shift()!

    let entries: import("fs").Dirent[]

    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)

      found.push(
        path.relative(targetDir, entryPath) + (entry.isDirectory() ? "/" : ""),
      )

      if (entry.isDirectory() && depth < 4) {
        queue.push({ dir: entryPath, depth: depth + 1 })
      }
    }
  }

  return found
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
  await assertStagingMountShared()

  const restorePath = duplicatiPathFor(targetDir)

  const taskId = await startDuplicatiRestore({
    backupId,
    time: versionTime,
    paths: [volumeBackupPath, dumpBackupPath],
    targetPath: restorePath,
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
    const restored = await describeRestoreOutput(targetDir)

    // Nothing at all arrived: the restore ran against a directory this
    // container cannot see, which is almost always the unshared staging mount.
    if (restored.length === 0) {
      throw new Error(
        `Duplicati reported the restore finished, but nothing appeared in ${targetDir} — ` +
          `it most likely restored into its own container's copy of ${restorePath}. ` +
          stagingMountAdvice(),
      )
    }

    throw new Error(
      `Duplicati restore finished but the Ghost content folder (${volumeDirName}/_data) was not found in the restored files. Restored instead: ${restored.join(", ")}`,
    )
  }

  const dbDumpGzPath = await findFirst({
    rootDir: targetDir,
    maxDepth: 8,
    matches: (entryPath, isDirectory) =>
      !isDirectory && path.basename(entryPath) === dumpFileName,
  })

  if (!dbDumpGzPath) {
    const restored = await describeRestoreOutput(targetDir)

    throw new Error(
      `Duplicati restore finished but the database dump (${dumpFileName}) was not found. The hourly pre-backup dump may not have covered this database yet. Restored: ${restored.join(", ")}`,
    )
  }

  console.info("Staged Duplicati version", {
    backupId,
    versionTime,
    restorePath,
    targetDir,
    contentDir,
    dbDumpGzPath,
  })

  return { contentDir, dbDumpGzPath }
}
