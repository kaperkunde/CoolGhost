import { Router } from "express"

import { config } from "../config.js"
import {
  activeJobForSpot,
  getDataJob,
  JobConflictError,
  startDataJob,
  type DataJob,
} from "../lib/data-jobs.js"
import {
  DuplicatiError,
  duplicatiConfigured,
  duplicatiVersionContainsPath,
  listDuplicatiBackups,
  listDuplicatiFilesets,
  type DuplicatiFileset,
} from "../lib/duplicati.js"
import { runExportJob, type ExportSource } from "../lib/export-job.js"
import { runRestoreJob, type RestoreSource } from "../lib/restore-job.js"
import {
  assertSafeDatabaseName,
  assertSafeName,
  ghostContentVolumeBackupPath,
  StagingUnavailableError,
} from "../lib/staging.js"
import { requireApiToken } from "../middleware/auth.js"

export const dataRouter = Router()

dataRouter.use(requireApiToken)

function jobResponse(job: DataJob) {
  return {
    id: job.id,
    kind: job.kind,
    spotId: job.spotId,
    phase: job.phase,
    mutationStarted: job.mutationStarted,
    warnings: job.warnings,
    error: job.error,
    artifact: job.artifact,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function handleError(res: import("express").Response, error: unknown): void {
  if (error instanceof StagingUnavailableError) {
    res.status(503).json({ error: error.message })
    return
  }

  if (error instanceof JobConflictError) {
    res.status(409).json({ error: error.message })
    return
  }

  if (error instanceof DuplicatiError) {
    res.status(502).json({ error: error.message })
    return
  }

  if (error instanceof Error && error.message.startsWith("Invalid ")) {
    res.status(400).json({ error: error.message })
    return
  }

  console.error("Data route failed", { error })
  res.status(500).json({ error: "Internal error" })
}

type SpotDataBody = {
  database?: unknown
  applicationUuid?: unknown
  source?: Record<string, unknown> | null
}

function parseTarget(spotIdParam: string, body: SpotDataBody) {
  return {
    spotId: assertSafeName(spotIdParam, "spot id"),
    database: assertSafeDatabaseName(String(body.database ?? "")),
    applicationUuid: assertSafeName(
      String(body.applicationUuid ?? ""),
      "application uuid",
    ),
  }
}

function requireString(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${label}`)
  }

  return value.trim()
}

/**
 * Restrict a backup job's filesets to the versions that actually hold this
 * site's data. Each check is a real (~1-2s) call to Duplicati, and a backup
 * job can carry many hourly versions, so checking every version individually
 * doesn't scale — one real run against 12 versions took ~40s.
 *
 * Instead this binary-searches the boundary: versions are newest-first, and
 * in normal operation a site's data is present continuously from the moment
 * it was first deployed onward, so "has data" is monotonic across the list
 * (newest versions have it, versions before first deploy don't). That lets
 * O(log n) checks stand in for O(n). If a site's data flickers in and out
 * (e.g. briefly moved to another server and back), a handful of versions
 * near the boundary could be mis-classified — the export step still
 * re-validates before doing real work, so this is a safe trade-off.
 */
async function filterVersionsForSpot(
  backupId: string,
  versions: DuplicatiFileset[],
  volumeBackupPath: string,
): Promise<DuplicatiFileset[]> {
  if (versions.length === 0) {
    return []
  }

  const hasSpotData = (version: DuplicatiFileset) =>
    duplicatiVersionContainsPath({
      backupId,
      time: version.time,
      pathPrefix: volumeBackupPath,
    }).catch(() => false)

  if (!(await hasSpotData(versions[0]!))) {
    return []
  }

  let newestWithout = versions.length - 1

  if (await hasSpotData(versions[newestWithout]!)) {
    return versions
  }

  let newestWith = 0

  while (newestWithout - newestWith > 1) {
    const mid = Math.floor((newestWith + newestWithout) / 2)

    if (await hasSpotData(versions[mid]!)) {
      newestWith = mid
    } else {
      newestWithout = mid
    }
  }

  return versions.slice(0, newestWith + 1)
}

/** List Duplicati backup jobs with the versions that contain this site's data. */
dataRouter.get("/spots/:spotId/backups", async (req, res) => {
  if (!duplicatiConfigured()) {
    res.json({ ok: true, configured: false, backups: [] })
    return
  }

  try {
    const target = parseTarget(String(req.params["spotId"]), req.query)
    const volumeBackupPath = ghostContentVolumeBackupPath(target.applicationUuid)

    const backups = await listDuplicatiBackups()

    const withVersions = await Promise.all(
      backups.map(async (backup) => {
        const versions = await listDuplicatiFilesets(backup.id).catch((error) => {
          console.error("Failed to list Duplicati filesets", {
            backupId: backup.id,
            error,
          })
          return []
        })

        return {
          ...backup,
          versions: await filterVersionsForSpot(
            backup.id,
            versions,
            volumeBackupPath,
          ),
        }
      }),
    )

    res.json({ ok: true, configured: true, backups: withVersions })
  } catch (error) {
    handleError(res, error)
  }
})

dataRouter.post("/spots/:spotId/export", async (req, res) => {
  try {
    const body = (req.body ?? {}) as SpotDataBody
    const target = parseTarget(String(req.params["spotId"]), body)
    const rawSource = body.source ?? { type: "current" }

    let source: ExportSource

    if (rawSource["type"] === "backup") {
      source = {
        type: "backup",
        backupId: requireString(rawSource["backupId"], "backup id"),
        backupName:
          typeof rawSource["backupName"] === "string"
            ? rawSource["backupName"]
            : "backup",
        versionTime: requireString(rawSource["versionTime"], "version time"),
      }
    } else {
      source = { type: "current" }
    }

    const job = await startDataJob({
      kind: "export",
      spotId: target.spotId,
      worker: (handle) => runExportJob({ handle, target, source }),
    })

    res.status(202).json({ ok: true, job: jobResponse(job) })
  } catch (error) {
    handleError(res, error)
  }
})

dataRouter.post("/spots/:spotId/restore", async (req, res) => {
  try {
    const body = (req.body ?? {}) as SpotDataBody
    const target = parseTarget(String(req.params["spotId"]), body)
    const rawSource = body.source ?? {}

    let source: RestoreSource

    if (rawSource["type"] === "upload") {
      source = {
        type: "upload",
        uploadRelPath: requireString(rawSource["uploadRelPath"], "upload path"),
      }
    } else if (rawSource["type"] === "backup") {
      source = {
        type: "backup",
        backupId: requireString(rawSource["backupId"], "backup id"),
        versionTime: requireString(rawSource["versionTime"], "version time"),
      }
    } else if (rawSource["type"] === "artifact") {
      source = { type: "artifact" }
    } else {
      res.status(400).json({ error: "Invalid restore source" })
      return
    }

    const job = await startDataJob({
      kind: "restore",
      spotId: target.spotId,
      worker: (handle) => runRestoreJob({ handle, target, source }),
    })

    res.status(202).json({ ok: true, job: jobResponse(job) })
  } catch (error) {
    handleError(res, error)
  }
})

dataRouter.get("/jobs/:jobId", (req, res) => {
  const job = getDataJob(String(req.params["jobId"]))

  if (!job) {
    res.status(404).json({ error: "Job not found" })
    return
  }

  res.json({ ok: true, job: jobResponse(job) })
})

dataRouter.get("/spots/:spotId/active-job", (req, res) => {
  try {
    const spotId = assertSafeName(String(req.params["spotId"]), "spot id")
    const job = activeJobForSpot(spotId)

    res.json({ ok: true, job: job ? jobResponse(job) : null })
  } catch (error) {
    handleError(res, error)
  }
})

/** Whether this server has the staging mount + duplicati configured. */
dataRouter.get("/capabilities", (_req, res) => {
  res.json({
    ok: true,
    staging: Boolean(config.stagingDir),
    duplicati: duplicatiConfigured(),
  })
})
