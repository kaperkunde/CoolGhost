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
  warnings: string[]
  error: string | null
  artifact: DataJobArtifact | null
  createdAt: string
  updatedAt: string
}

const jobs = new Map<string, DataJob>()

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

export function activeJobForSpot(spotId: string): DataJob | null {
  for (const job of jobs.values()) {
    if (job.spotId === spotId && job.phase !== "done" && job.phase !== "failed") {
      return job
    }
  }

  return null
}

export class JobConflictError extends Error {
  constructor(spotId: string) {
    super(`Another export or restore is already running for ${spotId}.`)
    this.name = "JobConflictError"
  }
}

export type JobHandle = {
  job: DataJob
  /** Work dir for this job under the staging mount. */
  workDir: string
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
  if (activeJobForSpot(spotId)) {
    throw new JobConflictError(spotId)
  }

  const now = new Date().toISOString()
  const job: DataJob = {
    id: randomUUID(),
    kind,
    spotId,
    phase: "pending",
    mutationStarted: false,
    warnings: [],
    error: null,
    artifact: null,
    createdAt: now,
    updatedAt: now,
  }

  jobs.set(job.id, job)
  await persist(job)

  const touch = async () => {
    job.updatedAt = new Date().toISOString()
    await persist(job)
  }

  const handle: JobHandle = {
    job,
    workDir: jobDirFor(job.id),
    setPhase: async (phase) => {
      job.phase = phase
      await touch()
    },
    markMutationStarted: async () => {
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
      if (job.phase !== "failed") {
        job.phase = "done"
        await touch()
      }
    })
    .catch(async (error: unknown) => {
      console.error("Data job failed", { jobId: job.id, kind, spotId, error })
      job.phase = "failed"
      job.error =
        error instanceof UserFacingError
          ? error.message
          : `Something went wrong while ${kind === "export" ? "exporting" : "restoring"} this site's data. Contact support if this keeps happening.`
      await touch()
    })

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
