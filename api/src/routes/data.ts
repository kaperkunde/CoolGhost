import { createReadStream } from "fs"

import { Router } from "express"

import { config } from "../config.js"
import {
  activeJobForSpot,
  cancelDataJob,
  getDataJob,
  JobConflictError,
  JobNotCancellableError,
  startDataJob,
  type DataJob,
} from "../lib/data-jobs.js"
import {
  DuplicatiError,
  duplicatiConfigured,
  listDuplicatiBackups,
  listDuplicatiFilesets,
} from "../lib/duplicati.js"
import {
  readArtifactSidecar,
  runExportJob,
  type ExportSource,
} from "../lib/export-job.js"
import { runRestoreJob, type RestoreSource } from "../lib/restore-job.js"
import {
  filterVersionsForSite,
  type SiteTarget,
} from "../lib/site-restore-points.js"
import {
  assertSafeDatabaseName,
  assertSafeName,
  resolveStagingRelativePath,
  StagingUnavailableError,
} from "../lib/staging.js"
import {
  appendRestoreUploadChunk,
  completeRestoreUpload,
  EmptyUploadError,
  InsufficientStorageError,
  startRestoreUpload,
  UploadIncompleteError,
  UploadNotFoundError,
  UploadOffsetMismatchError,
  UploadTooLargeError,
  writeRestoreUpload,
} from "../lib/uploads.js"
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
    cancelled: job.cancelled,
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
    res
      .status(409)
      .json({ error: error.message, activeJob: jobResponse(error.activeJob) })
    return
  }

  if (error instanceof JobNotCancellableError) {
    res.status(409).json({ error: error.message, mutationStarted: true })
    return
  }

  if (error instanceof UploadTooLargeError) {
    res.status(413).json({ error: error.message })
    return
  }

  if (error instanceof EmptyUploadError) {
    res.status(400).json({ error: error.message })
    return
  }

  if (error instanceof UploadNotFoundError) {
    res.status(404).json({ error: error.message })
    return
  }

  if (error instanceof UploadOffsetMismatchError) {
    res.status(409).json({ error: error.message, sizeBytes: error.sizeBytes })
    return
  }

  if (error instanceof UploadIncompleteError) {
    res
      .status(409)
      .json({ error: error.message, missingBytes: error.missingBytes })
    return
  }

  if (error instanceof InsufficientStorageError) {
    res.status(507).json({ error: error.message })
    return
  }

  if (error instanceof DuplicatiError) {
    console.error("Duplicati request failed", { error })
    res.status(502).json({ error: "Could not reach the backup service." })
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${label}`)
  }

  return value.trim()
}

const FILESET_RETRY_DELAY_MS = 1500

/**
 * List a job's restore points, retrying once: right after a backup run
 * Duplicati can briefly refuse or time out on the job's local database, and
 * one short retry turns most of those into a normal answer.
 */
async function listFilesetsWithRetry(backupId: string) {
  try {
    return {
      versions: await listDuplicatiFilesets(backupId),
      versionsError: null,
    }
  } catch (firstError) {
    await new Promise((resolve) => setTimeout(resolve, FILESET_RETRY_DELAY_MS))

    try {
      return {
        versions: await listDuplicatiFilesets(backupId),
        versionsError: null,
      }
    } catch (error) {
      console.error("Failed to list Duplicati filesets", {
        backupId,
        firstError,
        error,
      })

      return {
        versions: [],
        versionsError: "Could not list restore points for this backup.",
      }
    }
  }
}

/** The site named by ?applicationUuid=&database=, or null for every version. */
function parseSiteQuery(
  query: import("express").Request["query"],
): SiteTarget | null {
  const applicationUuid = query["applicationUuid"]
  const database = query["database"]

  if (applicationUuid === undefined && database === undefined) {
    return null
  }

  return {
    applicationUuid: assertSafeName(
      typeof applicationUuid === "string" ? applicationUuid : "",
      "application uuid",
    ),
    database: assertSafeDatabaseName(
      typeof database === "string" ? database : "",
    ),
  }
}

/**
 * List Duplicati backup jobs with their restorable versions. A job whose
 * versions could not be listed comes back with an empty list AND a
 * versionsError, so the caller can tell "no restore points" from "unknown".
 *
 * With ?applicationUuid=&database=, only the versions that hold that site's
 * data are listed — the ones an export or restore of it can use.
 */
dataRouter.get("/backups", async (req, res) => {
  if (!duplicatiConfigured()) {
    res.json({ ok: true, configured: false, backups: [] })
    return
  }

  try {
    const site = parseSiteQuery(req.query)
    const backups = await listDuplicatiBackups()

    const withVersions = await Promise.all(
      backups.map(async (backup) => ({
        ...backup,
        ...(await listFilesetsWithRetry(backup.id)),
      })),
    )

    res.json({
      ok: true,
      configured: true,
      backups: site
        ? await filterVersionsForSite(withVersions, site)
        : withVersions,
    })
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

/** Metadata of the spot's current export artifact (null when there is none). */
dataRouter.get("/spots/:spotId/artifact", async (req, res) => {
  try {
    const spotId = assertSafeName(String(req.params["spotId"]), "spot id")
    const artifact = await readArtifactSidecar(spotId)

    res.json({ ok: true, artifact })
  } catch (error) {
    handleError(res, error)
  }
})

/** Stream the spot's current export artifact. */
dataRouter.get("/spots/:spotId/artifact/download", async (req, res) => {
  try {
    const spotId = assertSafeName(String(req.params["spotId"]), "spot id")
    const artifact = await readArtifactSidecar(spotId)

    if (!artifact) {
      res
        .status(404)
        .json({ error: "No export artifact exists for this spot." })
      return
    }

    const fileName = artifact.downloadName.replace(/["\\\r\n]/g, "_")

    res.status(200)
    res.setHeader("Content-Type", "application/gzip")
    res.setHeader("Content-Length", String(artifact.sizeBytes))
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
    res.setHeader("Cache-Control", "no-store")

    const stream = createReadStream(
      resolveStagingRelativePath(artifact.relPath),
    )

    stream.on("error", (error) => {
      console.error("Artifact stream failed", { spotId, error })
      res.destroy(error)
    })

    res.on("close", () => {
      stream.destroy()
    })

    stream.pipe(res)
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * Receive a restore archive as the raw request body, in one request. The
 * returned uploadRelPath is passed back as the `upload` restore source.
 * Only workable when the whole body arrives inside every proxy's request
 * timeout — the session routes below are the general case.
 */
dataRouter.post("/spots/:spotId/uploads", async (req, res) => {
  try {
    const spotId = assertSafeName(String(req.params["spotId"]), "spot id")
    const declaredLength = Number(req.header("content-length") ?? "")

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > config.maxUploadBytes
    ) {
      throw new UploadTooLargeError()
    }

    const upload = await writeRestoreUpload({ spotId, body: req })

    res.json({ ok: true, ...upload })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * Chunked restore upload. One request per chunk keeps every hop — browser to
 * app, app to this api — inside the proxies' request-read timeout (Traefik's
 * default is 60s for the whole request, body included, which a single-request
 * upload of a real archive over a home uplink cannot meet: it dies with a
 * 499). Start a session, PUT chunks, then complete it; the returned
 * uploadRelPath is the `upload` restore source.
 *
 * Starting with `{ "sizeBytes" }` opens a ranged session (answered with
 * `ranged: true`): chunks may then land at any offset, in any order and
 * concurrently. Without it, chunks must arrive in order — see
 * appendRestoreUploadChunk.
 */
dataRouter.post("/spots/:spotId/uploads/sessions", async (req, res) => {
  try {
    const spotId = assertSafeName(String(req.params["spotId"]), "spot id")
    const body = (req.body ?? {}) as { sizeBytes?: unknown }
    const sizeBytes =
      body.sizeBytes === undefined ? undefined : Number(body.sizeBytes)

    res
      .status(201)
      .json({ ok: true, ...(await startRestoreUpload({ spotId, sizeBytes })) })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * Write the raw request body at `offset`. Ranged sessions need the
 * Content-Length and answer receivedBytes; in-order sessions answer the new
 * sizeBytes, or 409 (with sizeBytes) when the file ends elsewhere.
 */
dataRouter.put("/spots/:spotId/uploads/sessions/data", async (req, res) => {
  try {
    const spotId = assertSafeName(String(req.params["spotId"]), "spot id")
    const uploadRelPath = requireString(req.query["upload"], "upload path")
    const offset = Number(req.query["offset"])

    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("Invalid offset")
    }

    const declaredLength = Number(req.header("content-length") ?? "")

    if (
      Number.isFinite(declaredLength) &&
      offset + declaredLength > config.maxUploadBytes
    ) {
      throw new UploadTooLargeError()
    }

    const appended = await appendRestoreUploadChunk({
      spotId,
      uploadRelPath,
      offset,
      lengthBytes: Number.isFinite(declaredLength) ? declaredLength : undefined,
      body: req,
    })

    res.json({ ok: true, ...appended })
  } catch (error) {
    handleError(res, error)
  }
})

dataRouter.post(
  "/spots/:spotId/uploads/sessions/complete",
  async (req, res) => {
    try {
      const spotId = assertSafeName(String(req.params["spotId"]), "spot id")
      const body = (req.body ?? {}) as { uploadRelPath?: unknown }
      const uploadRelPath = requireString(body.uploadRelPath, "upload path")

      res.json({
        ok: true,
        ...(await completeRestoreUpload({ spotId, uploadRelPath })),
      })
    } catch (error) {
      handleError(res, error)
    }
  },
)

dataRouter.get("/jobs/:jobId", (req, res) => {
  const job = getDataJob(String(req.params["jobId"]))

  if (!job) {
    res.status(404).json({ error: "Job not found" })
    return
  }

  res.json({ ok: true, job: jobResponse(job) })
})

/**
 * Cancel a running job. Answers the job as it now stands: cancelled, or
 * unchanged when it had already finished. 409 once a restore has started
 * writing the site's data — it must run to the end.
 */
dataRouter.post("/jobs/:jobId/cancel", async (req, res) => {
  try {
    const job = await cancelDataJob(String(req.params["jobId"]))

    if (!job) {
      res.status(404).json({ error: "Job not found" })
      return
    }

    res.json({ ok: true, job: jobResponse(job) })
  } catch (error) {
    handleError(res, error)
  }
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
