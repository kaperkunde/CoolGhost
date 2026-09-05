import { promises as fs } from "node:fs"
import path from "node:path"

import { Router } from "express"

import { config } from "../config.js"
import {
  ClickhouseUnavailableError,
  deleteClickhouseSite,
  getClickhouseUsage,
  listMysqlDatabaseUsage,
} from "../lib/storage-usage.js"
import { requireApiToken } from "../middleware/auth.js"

export const storageRouter = Router()

/** Docker volume dir name Coolify creates for each blog's Ghost content. */
const CONTENT_VOLUME_REGEX = /^([A-Za-z0-9._-]+)_ghost-content-data$/

export type ContentVolumeUsage = {
  applicationUuid: string
  volumeName: string
  /** Apparent size: the sum of every regular file's byte length. */
  sizeBytes: number
  fileCount: number
  /** Set when part of the tree could not be read (permissions, races). */
  partial: boolean
}

type WalkTotals = { sizeBytes: number; fileCount: number; partial: boolean }

/**
 * Sums regular files under `dir` without following symlinks, so a link
 * inside a content volume can neither escape it nor be counted twice.
 * Unreadable entries mark the result partial instead of failing the walk.
 */
async function walkDirectory(dir: string, totals: WalkTotals): Promise<void> {
  let entries: import("node:fs").Dirent[]

  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    totals.partial = true
    return
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      await walkDirectory(entryPath, totals)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    try {
      const stat = await fs.lstat(entryPath)
      totals.sizeBytes += stat.size
      totals.fileCount += 1
    } catch {
      totals.partial = true
    }
  }
}

async function measureContentVolume(
  volumeName: string,
  applicationUuid: string,
): Promise<ContentVolumeUsage> {
  const totals: WalkTotals = { sizeBytes: 0, fileCount: 0, partial: false }

  await walkDirectory(path.join(config.volumesDir, volumeName, "_data"), totals)

  return { applicationUuid, volumeName, ...totals }
}

/**
 * Sizes every Ghost content volume on this server. Orphaned volumes (no
 * matching application any more) are included on purpose — the GhostHost
 * admin uses this listing to find them.
 */
storageRouter.get("/content", requireApiToken, async (_req, res) => {
  let entries: import("node:fs").Dirent[]

  try {
    entries = await fs.readdir(config.volumesDir, { withFileTypes: true })
  } catch (error) {
    console.error("Failed to read the docker volumes dir", {
      volumesDir: config.volumesDir,
      error,
    })
    res.status(503).json({
      error:
        "Docker volumes are not mounted into this container (VOLUMES_DIR is unreadable).",
    })
    return
  }

  const volumes: ContentVolumeUsage[] = []

  // Sequential on purpose: content volumes hold many small image files and
  // parallel walks on one disk only add seek contention.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const match = CONTENT_VOLUME_REGEX.exec(entry.name)
    if (!match) continue

    volumes.push(await measureContentVolume(entry.name, match[1]))
  }

  res.json({ ok: true, volumes })
})

/** Size of every blog database on the shared MySQL, with its Ghost site uuid. */
storageRouter.get("/databases", requireApiToken, async (_req, res) => {
  try {
    const databases = await listMysqlDatabaseUsage()
    res.json({ ok: true, databases })
  } catch (error) {
    console.error("Failed to measure MySQL databases", { error })
    res.status(500).json({ error: "Failed to measure databases" })
  }
})

/**
 * Analytics storage: bytes on disk per ClickHouse table, and an estimate
 * per site_uuid so the GhostHost admin can attribute it to a blog (or spot
 * a site uuid no blog owns any more).
 */
storageRouter.get("/analytics", requireApiToken, async (_req, res) => {
  if (!config.clickhouseUrl) {
    res.status(503).json({
      error:
        "Analytics storage is not configured on this server (CLICKHOUSE_URL is unset).",
    })
    return
  }

  try {
    const usage = await getClickhouseUsage()
    res.json({ ok: true, ...usage })
  } catch (error) {
    if (error instanceof ClickhouseUnavailableError) {
      console.error("ClickHouse unreachable", { error })
      res.status(502).json({ error: error.message })
      return
    }

    console.error("Failed to measure analytics storage", { error })
    res.status(500).json({ error: "Failed to measure analytics storage" })
  }
})

/** Same charset the volume-name regex above accepts for the uuid segment. */
const APPLICATION_UUID_REGEX = /^[A-Za-z0-9._-]+$/

/**
 * Removes an orphaned Ghost content volume outright. Only meant for volumes
 * with no Coolify application any more — deleting a live site's content
 * would break it, so this is a raw directory removal, not a docker call.
 * Idempotent: a volume that is already gone still reports success.
 */
storageRouter.delete(
  "/content/:applicationUuid",
  requireApiToken,
  async (req, res) => {
    const applicationUuid = String(req.params["applicationUuid"])

    if (!APPLICATION_UUID_REGEX.test(applicationUuid)) {
      res.status(400).json({ error: "Invalid application uuid" })
      return
    }

    const volumesRoot = path.resolve(config.volumesDir)
    const volumeDir = path.resolve(
      volumesRoot,
      `${applicationUuid}_ghost-content-data`,
    )

    // Belt-and-braces: the regex above already forbids path separators and
    // "..", but never let a resolved path outside the volumes root through.
    if (
      volumeDir !== volumesRoot &&
      !volumeDir.startsWith(`${volumesRoot}${path.sep}`)
    ) {
      res.status(400).json({ error: "Invalid application uuid" })
      return
    }

    const existed = await fs
      .stat(volumeDir)
      .then((stat) => stat.isDirectory())
      .catch(() => false)

    try {
      await fs.rm(volumeDir, { recursive: true, force: true })
      res.json({ ok: true, applicationUuid, removed: existed })
    } catch (error) {
      console.error("Failed to remove content volume", {
        applicationUuid,
        error,
      })
      res.status(500).json({ error: "Failed to remove content volume" })
    }
  },
)

/**
 * Deletes every analytics row for one site uuid. Idempotent — a site uuid
 * with no rows left still reports success.
 */
storageRouter.delete(
  "/analytics/:siteUuid",
  requireApiToken,
  async (req, res) => {
    const siteUuid = String(req.params["siteUuid"])

    if (!siteUuid || siteUuid.length > 191) {
      res.status(400).json({ error: "Invalid site uuid" })
      return
    }

    if (!config.clickhouseUrl) {
      res.status(503).json({
        error:
          "Analytics storage is not configured on this server (CLICKHOUSE_URL is unset).",
      })
      return
    }

    try {
      await deleteClickhouseSite(siteUuid)
      res.json({ ok: true, siteUuid })
    } catch (error) {
      if (error instanceof ClickhouseUnavailableError) {
        console.error("ClickHouse unreachable", { error })
        res.status(502).json({ error: error.message })
        return
      }

      console.error("Failed to delete analytics data for site", {
        siteUuid,
        error,
      })
      res.status(500).json({ error: "Failed to delete analytics data" })
    }
  },
)
