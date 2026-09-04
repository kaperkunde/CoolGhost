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

/**
 * Requests against a backup whose local database is busy (e.g. its backup is
 * currently running) can block server-side for as long as the task runs, so
 * every call carries a timeout — better to fail one job's listing than to
 * hang the whole /backups response behind it.
 */
const REQUEST_TIMEOUT_MS = 30 * 1000

/** Logging in gates every other call, so it gets a shorter leash. */
const LOGIN_TIMEOUT_MS = 15 * 1000

/**
 * A timed-out fetch surfaces as the signal's reason (a TimeoutError
 * DOMException) on some runtimes and as a wrapping error carrying it as
 * `cause` on others — check both.
 */
function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }

  if ((error as { name?: unknown }).name === "TimeoutError") {
    return true
  }

  const cause = (error as { cause?: unknown }).cause

  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "TimeoutError"
  )
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  // Node wraps connect/DNS failures ("fetch failed"); the cause names the
  // actual problem, which is what makes a misconfigured DUPLICATI_URL
  // diagnosable from the caller's error message.
  const cause = error.cause

  return cause instanceof Error
    ? `${error.message}: ${cause.message}`
    : error.message
}

/**
 * One Duplicati HTTP call, always bounded and always failing as a
 * DuplicatiError: an unreachable or wedged web service must surface as a 502
 * with a reason, not as a hung request or a bare 500.
 */
async function duplicatiRequest(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (isTimeout(error)) {
      throw new DuplicatiError(
        `Duplicati request ${path} timed out after ${timeoutMs}ms`,
      )
    }

    throw new DuplicatiError(
      `Duplicati request ${path} failed: ${errorDetail(error)}`,
    )
  }
}

async function readJson<T>(response: Response, path: string): Promise<T> {
  try {
    return (await response.json()) as T
  } catch (error) {
    if (isTimeout(error)) {
      throw new DuplicatiError(`Duplicati response for ${path} timed out`)
    }

    throw new DuplicatiError(
      `Duplicati response for ${path} could not be read: ${errorDetail(error)}`,
    )
  }
}

let pendingLogin: Promise<string> | null = null

/**
 * Endpoints that fan out (one request per backup job) would otherwise open a
 * login per request against an already busy Duplicati — concurrent callers
 * share one attempt.
 */
async function login(): Promise<string> {
  pendingLogin ??= performLogin().finally(() => {
    pendingLogin = null
  })

  return pendingLogin
}

async function performLogin(): Promise<string> {
  if (!config.duplicatiPassword) {
    throw new DuplicatiError("DUPLICATI_PASSWORD is not configured")
  }

  const path = "/api/v1/auth/login"
  const response = await duplicatiRequest(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Password: config.duplicatiPassword }),
    },
    LOGIN_TIMEOUT_MS,
  )

  if (!response.ok) {
    throw new DuplicatiError(
      `Duplicati login failed (${response.status}): ${await safeText(response)}`,
    )
  }

  const payload = await readJson<{ AccessToken?: string }>(response, path)

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

  const request = (bearer: string) =>
    duplicatiRequest(
      path,
      {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...init?.headers,
          Authorization: `Bearer ${bearer}`,
        },
      },
      REQUEST_TIMEOUT_MS,
    )

  let response = await request(token)

  if (response.status === 401) {
    // A cached token the server no longer accepts: force a fresh login rather
    // than reusing the one that just bounced.
    cachedToken = null
    token = await accessToken(true)
    response = await request(token)
  }

  if (!response.ok) {
    throw new DuplicatiError(
      `Duplicati request ${path} failed (${response.status}): ${await safeText(response)}`,
    )
  }

  return readJson<T>(response, path)
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
 * Check whether a fileset version contains the given path — a directory
 * (trailing "/") or an exact file, as recorded at backup time (e.g.
 * /local/volumes/<vol>/_data/ or /data/db_dumps/<db>.sql.gz).
 *
 * The path goes in the "filter" query parameter: Duplicati's REST API
 * exposes a single "/backup/{id}/files" endpoint and matches the filter
 * server-side (a URL path segment 404s). Both "prefix-only" and
 * "folder-contents" must be false — the response then contains exactly the
 * matching entry when the path exists in the version and nothing otherwise.
 * ("prefix-only=true" returns a placeholder entry with an empty Path even
 * for paths the version does not contain, and "folder-contents=true"
 * returns [] for file paths, so neither works as an existence check.)
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
    "prefix-only": "false",
    "folder-contents": "false",
  })

  const payload = await duplicatiFetch<{ Files?: Array<{ Path?: unknown }> }>(
    `/api/v1/backup/${encodeURIComponent(backupId)}/files?${query.toString()}`,
  )

  return (
    Array.isArray(payload.Files) &&
    payload.Files.some(
      (file) => typeof file?.Path === "string" && file.Path.length > 0,
    )
  )
}

/**
 * List a directory as the *duplicati container* sees it, via the web
 * service's folder-browser endpoint.
 *
 * Returns null when the endpoint is unavailable or answers in a shape this
 * client does not recognise: its exact request/response shape varies across
 * Duplicati releases, and this is only used to diagnose a misconfigured
 * staging mount, so "cannot tell" must never be mistaken for "not there".
 */
export async function tryListDuplicatiDirectory(
  dirPath: string,
): Promise<string[] | null> {
  // Sent both ways because releases differ on where the parameter is read
  // from; the unused one is ignored.
  const query = new URLSearchParams({ path: dirPath, onlyfolders: "false" })

  let payload: unknown

  try {
    payload = await duplicatiFetch<unknown>(
      `/api/v1/filesystem?${query.toString()}`,
      { method: "POST", body: JSON.stringify({ path: dirPath }) },
    )
  } catch {
    return null
  }

  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { Files?: unknown })?.Files)
      ? (payload as { Files: unknown[] }).Files
      : null

  if (!entries) {
    return null
  }

  return entries.flatMap((entry) => {
    const record = entry as { Path?: unknown; Text?: unknown }
    const name =
      typeof record?.Text === "string"
        ? record.Text
        : typeof record?.Path === "string"
          ? record.Path
          : null

    return name ? [name] : []
  })
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
