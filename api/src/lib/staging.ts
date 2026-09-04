import { promises as fs } from "fs"
import path from "path"

import { config } from "../config.js"

/**
 * Layout of the staging dir. It is local to this server: the api owns it and
 * the duplicati service of the same stack mounts it at the same path so
 * restores can be staged into it. The GhostHost app never touches it directly
 * — artifacts are served and uploads received over the /v1/data routes.
 *
 *   artifacts/<spot>.tar.gz + <spot>.json   one export artifact per spot
 *   uploads/<spot>-<id>.tar.gz              user-provided restore archives
 *   jobs/<jobId>/job.json + work dirs       running/finished job state
 */

export class StagingUnavailableError extends Error {
  constructor() {
    super(
      "Staging is not configured on this server (STAGING_DIR is not set or not mounted).",
    )
    this.name = "StagingUnavailableError"
  }
}

export function stagingRoot(): string {
  if (!config.stagingDir) {
    throw new StagingUnavailableError()
  }

  return config.stagingDir
}

export function artifactsDir(): string {
  return path.join(stagingRoot(), "artifacts")
}

export function uploadsDir(): string {
  return path.join(stagingRoot(), "uploads")
}

export function jobsDir(): string {
  return path.join(stagingRoot(), "jobs")
}

export async function ensureStagingLayout(): Promise<void> {
  for (const dir of [artifactsDir(), uploadsDir(), jobsDir()]) {
    await fs.mkdir(dir, { recursive: true })
  }
}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,190}$/i

/** Validate identifiers that become path segments or shell arguments. */
export function assertSafeName(value: string, label: string): string {
  const trimmed = value.trim()

  if (!SAFE_NAME.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`)
  }

  return trimmed
}

/** MySQL identifiers additionally must not contain dots or dashes. */
export function assertSafeDatabaseName(value: string): string {
  const trimmed = value.trim()

  if (!/^[a-z0-9_]{1,64}$/i.test(trimmed)) {
    throw new Error(`Invalid database name: ${JSON.stringify(value)}`)
  }

  return trimmed
}

/**
 * Resolve a staging-relative path (as stored in job records and handed back to
 * the GhostHost app as an opaque upload handle) to an absolute path, refusing
 * traversal outside the staging root.
 */
export function resolveStagingRelativePath(relPath: string): string {
  const root = stagingRoot()
  const resolved = path.resolve(root, relPath)

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Path escapes the staging directory")
  }

  return resolved
}

export function toStagingRelativePath(absPath: string): string {
  return path.relative(stagingRoot(), absPath)
}

/** Docker volume dir for a spot's Ghost content, as created by Coolify compose deploys. */
export function ghostContentVolumeDataDir(applicationUuid: string): string {
  const uuid = assertSafeName(applicationUuid, "application uuid")

  return path.join(
    config.volumesDir,
    `${uuid}_ghost-content-data`,
    "_data",
  )
}

/** Same path from the duplicati container's point of view (used to pick backup paths). */
export function ghostContentVolumeBackupPath(applicationUuid: string): string {
  const uuid = assertSafeName(applicationUuid, "application uuid")

  return `/local/volumes/${uuid}_ghost-content-data/_data/`
}

export function dbDumpBackupPath(database: string): string {
  return `/data/db_dumps/${assertSafeDatabaseName(database)}.sql.gz`
}

async function removeIfOlderThan(
  entryPath: string,
  cutoffMs: number,
): Promise<void> {
  try {
    const stat = await fs.stat(entryPath)

    if (stat.mtimeMs < cutoffMs) {
      await fs.rm(entryPath, { recursive: true, force: true })
    }
  } catch {
    // Entry disappeared or is unreadable — nothing to sweep.
  }
}

/** Delete artifacts, uploads and job dirs older than the configured TTL. */
export async function sweepStaging(): Promise<void> {
  if (!config.stagingDir) {
    return
  }

  const cutoffMs = Date.now() - config.artifactTtlHours * 60 * 60 * 1000

  for (const dir of [artifactsDir(), uploadsDir(), jobsDir()]) {
    let entries: string[]

    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      await removeIfOlderThan(path.join(dir, entry), cutoffMs)
    }
  }
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export function startStagingSweeper(): void {
  if (!config.stagingDir) {
    return
  }

  const run = () => {
    sweepStaging().catch((error) => {
      console.error("Staging sweep failed", { error })
    })
  }

  run()
  setInterval(run, SWEEP_INTERVAL_MS).unref()
}
