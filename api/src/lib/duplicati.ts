import { config } from "../config.js"

/**
 * Minimal client for the Duplicati web-service JSON API (v2.1+ auth flow).
 * Used to list backup jobs/versions and to materialize files from a backup
 * into the shared staging mount. Duplicati holds the remote-target
 * credentials, so restores work the same for local and remote jobs.
 */

export class DuplicatiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DuplicatiError"
  }
}

export type DuplicatiBackupSummary = {
  id: string
  name: string
  description: string | null
  /** "local" when the target is a file:// URL, "remote" otherwise. */
  targetKind: "local" | "remote" | "unknown"
}

export type DuplicatiFileset = {
  version: number
  /** ISO timestamp of the backup snapshot. */
  time: string
  fileCount: number | null
  fileSizes: number | null
}

export function duplicatiConfigured(): boolean {
  return Boolean(config.duplicatiUrl && config.duplicatiPassword)
}

function baseUrl(): string {
  if (!config.duplicatiUrl) {
    throw new DuplicatiError("DUPLICATI_URL is not configured")
  }

  return config.duplicatiUrl.replace(/\/$/, "")
}

let cachedToken: { token: string; obtainedAt: number } | null = null
const TOKEN_MAX_AGE_MS = 5 * 60 * 1000

async function login(): Promise<string> {
  if (!config.duplicatiPassword) {
    throw new DuplicatiError("DUPLICATI_PASSWORD is not configured")
  }

  const response = await fetch(`${baseUrl()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Password: config.duplicatiPassword }),
  })

  if (!response.ok) {
    throw new DuplicatiError(
      `Duplicati login failed (${response.status}): ${await safeText(response)}`,
    )
  }

  const payload = (await response.json()) as { AccessToken?: string }

  if (!payload.AccessToken) {
    throw new DuplicatiError("Duplicati login returned no access token")
  }

  cachedToken = { token: payload.AccessToken, obtainedAt: Date.now() }
  return payload.AccessToken
}

async function accessToken(forceRefresh = false): Promise<string> {
  if (
    !forceRefresh &&
    cachedToken &&
    Date.now() - cachedToken.obtainedAt < TOKEN_MAX_AGE_MS
  ) {
    return cachedToken.token
  }

  return login()
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return "<unreadable body>"
  }
}

async function duplicatiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let token = await accessToken()

  let response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  })

  if (response.status === 401) {
    token = await accessToken(true)
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    })
  }

  if (!response.ok) {
    throw new DuplicatiError(
      `Duplicati request ${path} failed (${response.status}): ${await safeText(response)}`,
    )
  }

  return (await response.json()) as T
}

type RawBackupListEntry = {
  Backup?: {
    ID?: string | number
    Name?: string
    Description?: string
    TargetURL?: string
  }
}

function targetKindFromUrl(
  targetUrl: string | undefined,
): DuplicatiBackupSummary["targetKind"] {
  if (!targetUrl) {
    return "unknown"
  }

  return targetUrl.trim().toLowerCase().startsWith("file://")
    ? "local"
    : "remote"
}

export async function listDuplicatiBackups(): Promise<
  DuplicatiBackupSummary[]
> {
  const entries = await duplicatiFetch<RawBackupListEntry[]>("/api/v1/backups")

  if (!Array.isArray(entries)) {
    throw new DuplicatiError("Duplicati backup list has unexpected shape")
  }

  return entries
    .map((entry) => entry.Backup)
    .filter(
      (backup): backup is NonNullable<RawBackupListEntry["Backup"]> =>
        backup != null && backup.ID != null,
    )
    .map((backup) => ({
      id: String(backup.ID),
      name: backup.Name?.trim() || `Backup ${backup.ID}`,
      description: backup.Description?.trim() || null,
      targetKind: targetKindFromUrl(backup.TargetURL),
    }))
}

type RawFileset = {
  Version?: number
  Time?: string
  FileCount?: number
  FileSizes?: number
}

export async function listDuplicatiFilesets(
  backupId: string,
): Promise<DuplicatiFileset[]> {
  const entries = await duplicatiFetch<RawFileset[]>(
    `/api/v1/backup/${encodeURIComponent(backupId)}/filesets`,
  )

  if (!Array.isArray(entries)) {
    throw new DuplicatiError("Duplicati fileset list has unexpected shape")
  }

  return entries
    .filter((entry) => entry.Version != null && entry.Time)
    .map((entry) => ({
      version: Number(entry.Version),
      time: String(entry.Time),
      fileCount: entry.FileCount ?? null,
      fileSizes: entry.FileSizes ?? null,
    }))
    .sort((a, b) => (a.time < b.time ? 1 : -1))
}

/**
 * Check whether a fileset version contains any files under the given path
 * prefix (as recorded at backup time, e.g. /local/volumes/<vol>/_data/).
 *
 * The path to search is a query parameter ("filter"), not a URL path segment
 * — Duplicati's REST API exposes a single "/backup/{id}/files" endpoint and
 * matches against "filter" server-side. "prefix-only" skips enumerating the
 * matched folder's contents, which is what makes this a cheap existence
 * check rather than a full (and, for large backups, slow) directory listing.
 */
export async function duplicatiVersionContainsPath({
  backupId,
  time,
  pathPrefix,
}: {
  backupId: string
  time: string
  pathPrefix: string
}): Promise<boolean> {
  const query = new URLSearchParams({
    filter: pathPrefix,
    time,
    "prefix-only": "true",
    "folder-contents": "false",
  })

  const payload = await duplicatiFetch<{ Files?: unknown[] }>(
    `/api/v1/backup/${encodeURIComponent(backupId)}/files?${query.toString()}`,
  )

  return Array.isArray(payload.Files) && payload.Files.length > 0
}

/**
 * Start a restore of the given paths into targetPath (a path valid inside the
 * duplicati container — use the shared staging mount so this service can read
 * the result). Directory paths should end with "/" — a "*" is appended so the
 * filter matches their contents recursively.
 */
export async function startDuplicatiRestore({
  backupId,
  time,
  paths,
  targetPath,
}: {
  backupId: string
  time: string
  paths: string[]
  targetPath: string
}): Promise<number> {
  const filterPaths = paths.map((p) => (p.endsWith("/") ? `${p}*` : p))

  const payload = await duplicatiFetch<{ TaskID?: number; ID?: number }>(
    `/api/v1/backup/${encodeURIComponent(backupId)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({
        paths: filterPaths,
        time,
        "restore-path": targetPath,
        overwrite: true,
        permissions: false,
        skip_metadata: true,
      }),
    },
  )

  const taskId = payload.TaskID ?? payload.ID

  if (taskId == null) {
    throw new DuplicatiError("Duplicati restore returned no task id")
  }

  return Number(taskId)
}

type RawTask = {
  Status?: string
  ErrorMessage?: string
  Exception?: string
}

export type DuplicatiTaskStatus = {
  status: "waiting" | "running" | "completed" | "failed" | "unknown"
  errorMessage: string | null
}

export async function getDuplicatiTask(
  taskId: number,
): Promise<DuplicatiTaskStatus> {
  const payload = await duplicatiFetch<RawTask>(`/api/v1/task/${taskId}`)
  const raw = payload.Status?.trim().toLowerCase() ?? ""

  let status: DuplicatiTaskStatus["status"] = "unknown"

  if (raw === "waiting") status = "waiting"
  else if (raw === "running") status = "running"
  else if (raw === "completed") status = "completed"
  else if (raw === "failed" || raw === "aborted") status = "failed"

  return {
    status,
    errorMessage: payload.ErrorMessage || payload.Exception || null,
  }
}

const RESTORE_POLL_INTERVAL_MS = 2000

export async function waitForDuplicatiTask({
  taskId,
  timeoutMs,
}: {
  taskId: number
  timeoutMs: number
}): Promise<void> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const task = await getDuplicatiTask(taskId)

    if (task.status === "completed") {
      return
    }

    if (task.status === "failed") {
      throw new DuplicatiError(
        task.errorMessage
          ? `Duplicati restore failed: ${task.errorMessage}`
          : "Duplicati restore failed",
      )
    }

    if (Date.now() > deadline) {
      throw new DuplicatiError(
        `Duplicati task ${taskId} did not finish within ${Math.round(timeoutMs / 1000)}s`,
      )
    }

    await new Promise((resolve) =>
      setTimeout(resolve, RESTORE_POLL_INTERVAL_MS),
    )
  }
}
