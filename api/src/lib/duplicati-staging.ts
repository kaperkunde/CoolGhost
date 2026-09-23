import { promises as fs } from "fs"
import path from "path"

import { config } from "../config.js"
import {
  duplicatiVersionContainsPath,
  startDuplicatiRestore,
  tryListDuplicatiDirectory,
  waitForDuplicatiTask,
} from "./duplicati.js"
import { UserFacingError } from "./errors.js"
import {
  analyticsDumpBackupPath,
  dbDumpBackupPath,
  ghostContentVolumeBackupPath,
  legacyDbDumpBackupPath,
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
 * shows up in a folder-only listing too. Must not start with "." — Duplicati's
 * filesystem-browse endpoint silently omits dotfiles/dot-directories from its
 * listing, which made this check report a shared mount as broken even when
 * correctly configured (it never saw its own probe entry).
 */
const MOUNT_PROBE_DIR_NAME = "coolghost-mount-probe"

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

export type StagedDuplicatiVersion = {
  contentDir: string
  /** The site's database dump; gunzip it first when `dbDumpCompressed`. */
  dbDumpPath: string
  dbDumpCompressed: boolean
  /** The site's analytics events (JSONEachRow), when the version carries them. */
  analyticsDumpPath: string | null
}

export type SiteDataInVersion =
  | { found: true; dumpBackupPath: string }
  | { found: false; missing: "content" | "dump" }

/**
 * Whether a backup version holds what staging needs for one site: its Ghost
 * content volume and a database dump. The Backups list filters on this too,
 * so the restore points it offers are exactly the ones staging accepts.
 *
 * Errors from the checks themselves (e.g. Duplicati busy or unreachable)
 * propagate as-is rather than being reported as missing data.
 */
export async function locateSiteDataInVersion({
  backupId,
  versionTime,
  applicationUuid,
  database,
}: {
  backupId: string
  versionTime: string
  applicationUuid: string
  database: string
}): Promise<SiteDataInVersion> {
  const hasVolume = await duplicatiVersionContainsPath({
    backupId,
    time: versionTime,
    pathPrefix: ghostContentVolumeBackupPath(applicationUuid),
  })

  if (!hasVolume) {
    return { found: false, missing: "content" }
  }

  // Dumps are plain SQL since analytics joined the backups; versions taken
  // before that carry a gzipped one. Whichever this version has is the one
  // restored and unpacked.
  for (const dumpBackupPath of [
    dbDumpBackupPath(database),
    legacyDbDumpBackupPath(database),
  ]) {
    if (
      await duplicatiVersionContainsPath({
        backupId,
        time: versionTime,
        pathPrefix: dumpBackupPath,
      })
    ) {
      return { found: true, dumpBackupPath }
    }
  }

  return { found: false, missing: "dump" }
}

export async function stageDuplicatiVersion({
  backupId,
  versionTime,
  applicationUuid,
  database,
  targetDir,
  signal,
}: {
  backupId: string
  versionTime: string
  applicationUuid: string
  database: string
  targetDir: string
  /** Aborts the Duplicati restore and the wait for it (a cancelled job). */
  signal?: AbortSignal
}): Promise<StagedDuplicatiVersion> {
  const volumeBackupPath = ghostContentVolumeBackupPath(applicationUuid)
  const analyticsBackupPath = analyticsDumpBackupPath(database)

  // Both pieces must exist in the version before restoring anything. Checking
  // up front gives each miss an accurate error, and guarantees the restore
  // below matches files under both /local and /data — so their largest
  // common prefix is "/" and Duplicati recreates the full directory layout
  // under targetDir. (When only one path matches, Duplicati strips the whole
  // shared prefix — including the volume's _data/ folder — and the restored
  // layout becomes unrecognizable.)
  const located = await locateSiteDataInVersion({
    backupId,
    versionTime,
    applicationUuid,
    database,
  })

  if (!located.found) {
    throw new UserFacingError(
      located.missing === "content"
        ? "This backup version does not contain data for this site. Pick a version taken while the site was deployed."
        : "This backup version has the site's files but no database dump. It was likely taken before automatic database dumps covered this site — pick a newer version.",
    )
  }

  const { dumpBackupPath } = located

  // Analytics are a bonus, not a requirement: versions taken before they were
  // dumped, and servers with no analytics stack, simply have none. The export
  // and restore jobs warn in that case rather than failing.
  const hasAnalytics = await duplicatiVersionContainsPath({
    backupId,
    time: versionTime,
    pathPrefix: analyticsBackupPath,
  })

  signal?.throwIfAborted()
  await fs.mkdir(targetDir, { recursive: true })
  await assertStagingMountShared()

  const restorePath = duplicatiPathFor(targetDir)

  const taskId = await startDuplicatiRestore({
    backupId,
    time: versionTime,
    paths: [
      volumeBackupPath,
      dumpBackupPath,
      ...(hasAnalytics ? [analyticsBackupPath] : []),
    ],
    targetPath: restorePath,
  })

  await waitForDuplicatiTask({
    taskId,
    timeoutMs: config.duplicatiRestoreTimeoutMinutes * 60 * 1000,
    signal,
  })

  // Duplicati strips the largest common prefix when restoring to a new
  // location, so the exact layout under targetDir varies — locate the
  // restored pieces instead of assuming paths.
  const volumeDirName = `${applicationUuid}_ghost-content-data`
  const dumpFileName = path.posix.basename(dumpBackupPath)
  const dumpCompressed = dumpFileName.endsWith(".gz")

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

  const dbDumpPath = await findFirst({
    rootDir: targetDir,
    maxDepth: 8,
    matches: (entryPath, isDirectory) =>
      !isDirectory && path.basename(entryPath) === dumpFileName,
  })

  if (!dbDumpPath) {
    const restored = await describeRestoreOutput(targetDir)

    throw new Error(
      `Duplicati restore finished but the database dump (${dumpFileName}) was not found. The hourly pre-backup dump may not have covered this database yet. Restored: ${restored.join(", ")}`,
    )
  }

  const analyticsDumpPath = hasAnalytics
    ? await findFirst({
        rootDir: targetDir,
        maxDepth: 8,
        matches: (entryPath, isDirectory) =>
          !isDirectory &&
          path.basename(entryPath) === path.posix.basename(analyticsBackupPath),
      })
    : null

  console.info("Staged Duplicati version", {
    backupId,
    versionTime,
    restorePath,
    targetDir,
    contentDir,
    dbDumpPath,
    dumpCompressed,
    analyticsDumpPath,
  })

  return {
    contentDir,
    dbDumpPath,
    dbDumpCompressed: dumpCompressed,
    analyticsDumpPath,
  }
}
