import { promises as fs } from "node:fs"
import path from "node:path"

import { Router } from "express"

import { config } from "../config.js"
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
