import { randomUUID } from "crypto"
import { promises as fs } from "fs"
import path from "path"

import { UserFacingError } from "./errors.js"
import { jobsDir } from "./staging.js"

/**
 * Long-running export/restore jobs. State is kept in memory and mirrored to
 * <staging>/jobs/<id>/job.json so a service restart doesn't lose history —
 * jobs that were still running at boot are marked failed (their worker died
 * with the process).
 *
 * A job can be cancelled until it starts overwriting live data: cancelling
 * aborts the job's signal, which kills whatever child process or wait the
 * worker is in, and the job ends failed with `cancelled: true`. Once
 * `mutationStarted` is set a cancel is refused — stopping a restore halfway
 * through the volume or the database would leave the site broken.
 */

export type DataJobKind = "export" | "restore"

export type ExportJobPhase = "pending" | "staging" | "packaging" | "done" | "failed"

export type RestoreJobPhase =
  | "pending"
  | "staging"
  | "snapshotting"
  | "validating"
  | "applying_files"
  | "applying_db"
  | "done"
  | "failed"

export type DataJobArtifact = {
  /** Path relative to the staging root (shared mount). */
  relPath: string
  /** Suggested download filename. */
  downloadName: string
  sizeBytes: number
  createdAt: string
}

export type DataJob = {
  id: string
  kind: DataJobKind
  spotId: string
  phase: ExportJobPhase | RestoreJobPhase
  /**
   * True once the restore started overwriting live data. When a job fails
   * before this point the site is untouched and can simply be started again.
   */
  mutationStarted: boolean
  /** Ended by a cancel request rather than by finishing or failing. */
  cancelled: boolean
  warnings: string[]
  error: string | null
  artifact: DataJobArtifact | null
  createdAt: string
  updatedAt: string
}

const jobs = new Map<string, DataJob>()
const controllers = new Map<string, AbortController>()

function jobDirFor(jobId: string): string {
  return path.join(jobsDir(), jobId)
}

async function persist(job: DataJob): Promise<void> {
  const dir = jobDirFor(job.id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "job.json"),
    JSON.stringify(job, null, 2),
    "utf8",
  )
}

export function getDataJob(jobId: string): DataJob | null {
  return jobs.get(jobId) ?? null
}

/**
 * The spot's running job, if any. A cancelled job counts until its worker has
 * finished unwinding, so a new job cannot race the old one's cleanup.
 */
export function activeJobForSpot(spotId: string): DataJob | null {
  for (const job of jobs.values()) {
    if (
      job.spotId === spotId &&
      ((job.phase !== "done" && job.phase !== "failed") ||
        controllers.has(job.id))
    ) {
      return job
    }
  }

  return null
}

/** A job for the same spot is still running; `activeJob` says which. */
export class JobConflictError extends Error {
  readonly activeJob: DataJob

  constructor(activeJob: DataJob) {
    super(
      activeJob.kind === "restore"
        ? "A restore is already running for this site."
        : "An export is already running for this site.",
    )
    this.name = "JobConflictError"
    this.activeJob = activeJob
  }
}

/** Thrown inside a worker once its job has been cancelled. */
export class JobCancelledError extends Error {
  constructor() {
    super("Cancelled.")
    this.name = "JobCancelledError"
  }
}

/** The job has started overwriting live data and can no longer be cancelled. */
export class JobNotCancellableError extends Error {
  constructor() {
    super(
      "The restore is already writing the site's data and can't be stopped safely.",
    )
    this.name = "JobNotCancellableError"
  }
}

export type JobHandle = {
  job: DataJob
  /** Work dir for this job under the staging mount. */
  workDir: string
  /** Aborted when the job is cancelled; pass it to child processes and waits. */
  signal: AbortSignal
  setPhase: (phase: ExportJobPhase | RestoreJobPhase) => Promise<void>
  markMutationStarted: () => Promise<void>
  addWarning: (warning: string) => Promise<void>
  setArtifact: (artifact: DataJobArtifact) => Promise<void>
}

/**
 * Create a job and run its worker in the background. The worker owns phase
 * transitions; any thrown error marks the job failed.
 */
export async function startDataJob({
  kind,
  spotId,
  worker,
}: {
  kind: DataJobKind
  spotId: string
  worker: (handle: JobHandle) => Promise<void>
}): Promise<DataJob> {
  const active = activeJobForSpot(spotId)

  if (active) {
    throw new JobConflictError(active)
  }

  const now = new Date().toISOString()
  const job: DataJob = {
    id: randomUUID(),
    kind,
    spotId,
    phase: "pending",
    mutationStarted: false,
    cancelled: false,
    warnings: [],
    error: null,
    artifact: null,
    createdAt: now,
    updatedAt: now,
  }

  const controller = new AbortController()
  jobs.set(job.id, job)
  controllers.set(job.id, controller)
  await persist(job)

  const touch = async () => {
    job.updatedAt = new Date().toISOString()
    await persist(job)
  }

  const throwIfCancelled = () => {
    if (controller.signal.aborted) {
      throw new JobCancelledError()
    }
  }

  const handle: JobHandle = {
    job,
    workDir: jobDirFor(job.id),
    signal: controller.signal,
    // Every phase change is a cancellation point, so a worker that is
    // between steps when the cancel lands stops at the next one.
    setPhase: async (phase) => {
      throwIfCancelled()
      job.phase = phase
      await touch()
    },
    // Check and set in the same tick: cancelDataJob reads mutationStarted
    // synchronously too, so exactly one of them wins.
    markMutationStarted: async () => {
      throwIfCancelled()
      job.mutationStarted = true
      await touch()
    },
    addWarning: async (warning) => {
      job.warnings.push(warning)
      await touch()
    },
    setArtifact: async (artifact) => {
      job.artifact = artifact
      await touch()
    },
  }

  void worker(handle)
    .then(async () => {
      // A cancel that landed after the last cancellation point has already
      // ended the job; the worker finishing its tail does not undo that.
      if (job.phase !== "failed") {
        job.phase = "done"
        await touch()
      }
    })
    .catch(async (error: unknown) => {
      if (job.cancelled) {
        return
      }

      console.error("Data job failed", { jobId: job.id, kind, spotId, error })
      job.phase = "failed"
      job.error =
        error instanceof UserFacingError
          ? error.message
          : `Something went wrong while ${kind === "export" ? "exporting" : "restoring"} this site's data. Contact support if this keeps happening.`
      await touch()
    })
    .finally(() => {
      controllers.delete(job.id)
    })

  return job
}

/**
 * Cancel a running job. The job ends at once — failed, `cancelled: true` —
 * so the spot is free for a new job, and its worker is aborted and unwinds
 * in the background (its cleanup only touches the job's own work dir).
 * Terminal jobs are returned unchanged; unknown ids return null.
 */
export async function cancelDataJob(jobId: string): Promise<DataJob | null> {
  const job = jobs.get(jobId)

  if (!job) {
    return null
  }

  if (job.phase === "done" || job.phase === "failed") {
    return job
  }

  if (job.mutationStarted) {
    throw new JobNotCancellableError()
  }

  job.cancelled = true
  job.phase = "failed"
  job.error = "Cancelled."
  job.updatedAt = new Date().toISOString()
  controllers.get(jobId)?.abort(new JobCancelledError())
  await persist(job)

  return job
}

/** Load persisted jobs at boot; anything non-terminal was orphaned by a restart. */
export async function loadPersistedJobs(): Promise<void> {
  let entries: string[]

  try {
    entries = await fs.readdir(jobsDir())
  } catch {
    return
  }

  for (const entry of entries) {
    try {
      const raw = await fs.readFile(
        path.join(jobsDir(), entry, "job.json"),
        "utf8",
      )
      const job = JSON.parse(raw) as DataJob

      if (!job.id || jobs.has(job.id)) {
        continue
      }

      // Jobs persisted before cancelling existed.
      job.cancelled ??= false

      if (job.phase !== "done" && job.phase !== "failed") {
        job.phase = "failed"
        job.error = "The backup service restarted while this job was running."
        job.updatedAt = new Date().toISOString()
        await persist(job)
      }

      jobs.set(job.id, job)
    } catch {
      // Skip unreadable job dirs; the sweeper will collect them eventually.
    }
  }
}
