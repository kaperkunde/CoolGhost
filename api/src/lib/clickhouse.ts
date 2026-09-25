import { createReadStream, createWriteStream } from "fs"
import { promises as fs } from "fs"
import { Readable, Transform, Writable } from "stream"
import { pipeline } from "stream/promises"

import { config } from "../config.js"

/**
 * Minimal client for the shared analytics ClickHouse over its HTTP interface.
 *
 * Two jobs: reporting storage usage (see storage-usage.ts), and carrying one
 * site's events in and out of export archives. Raw fetch rather than a client
 * library — the api only needs a handful of statements, and the export path
 * wants the response streamed straight to disk.
 */

export class ClickhouseUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClickhouseUnavailableError"
  }
}

/** Metadata queries answer in milliseconds; this only catches a wedged server. */
const QUERY_TIMEOUT_MS = 20 * 1000

/**
 * Dumping or reloading a busy site's events moves hundreds of MB, so it gets
 * its own budget. A job that outlives even this is cancelled by its own
 * signal or by the app's job timeout, not by this one.
 */
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000

/** Analytics tables whose rows are keyed by site_uuid. */
export const SITE_TABLES = ["analytics_events", "mv_hits"]

/**
 * The columns of analytics_events that travel in a dump, as an input()
 * structure. site_uuid is deliberately absent: the reload supplies it itself.
 */
const EVENT_INPUT_STRUCTURE =
  "timestamp DateTime, session_id String, action LowCardinality(String), " +
  "version LowCardinality(String), payload String, inserted_at DateTime64(3)"

export function clickhouseConfigured(): boolean {
  return Boolean(config.clickhouseUrl)
}

function clickhouseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
  }

  // ClickHouse rejects a key without a user ("Got an empty user name from
  // X-ClickHouse HTTP headers"), so a password alone means the default user.
  if (config.clickhouseUser || config.clickhousePassword) {
    headers["X-ClickHouse-User"] = config.clickhouseUser || "default"
  }

  if (config.clickhousePassword) {
    headers["X-ClickHouse-Key"] = config.clickhousePassword
  }

  return headers
}

function clickhouseRequestUrl(params: Record<string, string> = {}): URL {
  const url = new URL(config.clickhouseUrl!)
  url.searchParams.set("database", config.clickhouseDatabase)

  for (const [key, value] of Object.entries(params)) {
    // ClickHouse's HTTP interface binds a `{name:Type}` placeholder in the
    // query text to a `param_<name>` query-string value — this is how the
    // statements below take a site uuid without string-building SQL.
    url.searchParams.set(`param_${key}`, value)
  }

  return url
}

/**
 * One request. Without `body` the statement *is* the body (the ordinary
 * read path); with one, the statement moves into the query string and the
 * body carries the data — which is how ClickHouse takes an INSERT's rows.
 */
async function clickhouseRequest({
  sql,
  params = {},
  settings = {},
  body,
  timeoutMs = QUERY_TIMEOUT_MS,
  signal,
}: {
  sql: string
  params?: Record<string, string>
  settings?: Record<string, string>
  body?: BodyInit
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<Response> {
  if (!config.clickhouseUrl) {
    throw new ClickhouseUnavailableError("CLICKHOUSE_URL is not configured")
  }

  const url = clickhouseRequestUrl(params)

  for (const [key, value] of Object.entries(settings)) {
    url.searchParams.set(key, value)
  }

  if (body !== undefined) {
    url.searchParams.set("query", sql)
  }

  const timeout = AbortSignal.timeout(timeoutMs)

  try {
    return await fetch(url, {
      method: "POST",
      headers: clickhouseHeaders(),
      body: body ?? sql,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      // Required by undici whenever the body is a stream.
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit)
  } catch (error) {
    // A cancelled job aborts its own signal; that is not ClickHouse's fault
    // and must stay the error the worker recognises.
    if (signal?.aborted) {
      throw error
    }

    throw new ClickhouseUnavailableError(
      `Could not reach ClickHouse at ${url.origin}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function assertOk(response: Response, what: string): Promise<void> {
  if (response.ok) {
    return
  }

  const text = await response.text().catch(() => "")

  throw new Error(`ClickHouse ${what} failed (${response.status}): ${text}`)
}

export async function clickhouseQuery<T>(sql: string): Promise<T[]> {
  const response = await clickhouseRequest({ sql: `${sql} FORMAT JSONEachRow` })
  const text = await response.text()

  if (!response.ok) {
    throw new Error(`ClickHouse query failed (${response.status}): ${text}`)
  }

  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T)
}

/** Runs a statement with no result rows (a DELETE or an ALTER here). */
export async function clickhouseCommand(
  sql: string,
  params: Record<string, string> = {},
): Promise<void> {
  await assertOk(await clickhouseRequest({ sql, params }), "command")
}

/** Counts the newline-terminated rows passing through, without buffering. */
function rowCounter(): Transform & { rows: number } {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        if (byte === 0x0a) {
          ;(counter as Transform & { rows: number }).rows += 1
        }
      }

      callback(null, chunk)
    },
  }) as Transform & { rows: number }

  counter.rows = 0

  return counter
}

/**
 * Write one site's events to `destPath` as JSONEachRow, newest last.
 *
 * Ordered by inserted_at so the file is append-only between runs: the hourly
 * backup then stores just the new tail rather than a whole new copy of a
 * file whose every block shifted (see pre-backup.sh).
 */
export async function dumpSiteAnalytics({
  siteUuid,
  destPath,
  signal,
}: {
  siteUuid: string
  destPath: string
  signal?: AbortSignal
}): Promise<{ rows: number }> {
  const response = await clickhouseRequest({
    sql:
      `SELECT * FROM analytics_events WHERE site_uuid = {site_uuid:String} ` +
      `ORDER BY inserted_at, timestamp, session_id FORMAT JSONEachRow`,
    params: { site_uuid: siteUuid },
    timeoutMs: TRANSFER_TIMEOUT_MS,
    signal,
  })

  await assertOk(response, "analytics dump")

  if (!response.body) {
    throw new Error("ClickHouse analytics dump returned no body")
  }

  const counter = rowCounter()

  await pipeline(
    Readable.fromWeb(response.body as never),
    counter,
    createWriteStream(destPath),
    { signal },
  )

  return { rows: counter.rows }
}

/** Rows in a JSONEachRow file, counted without loading it into memory. */
export async function countJsonlRows(filePath: string): Promise<number> {
  const counter = rowCounter()

  await pipeline(
    createReadStream(filePath),
    counter,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    }),
  )

  return counter.rows
}

/** The site_uuid the rows in a dump carry, or null for an empty/unreadable file. */
export async function readSiteUuidFromDump(
  filePath: string,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>

  try {
    handle = await fs.open(filePath, "r")
  } catch {
    return null
  }

  try {
    // One line of JSONEachRow, generously bounded — a Ghost page_hit payload
    // is a few hundred bytes.
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]

    if (!firstLine?.trim()) {
      return null
    }

    const parsed = JSON.parse(firstLine) as { site_uuid?: unknown }

    return typeof parsed.site_uuid === "string" && parsed.site_uuid
      ? parsed.site_uuid
      : null
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Delete every row one site has in the analytics tables.
 *
 * A lightweight DELETE, which ClickHouse applies before answering, so a
 * reload that follows cannot have its fresh rows swept up by a mutation
 * still running behind it. mv_hits is cleared too: it is fed by a
 * materialized view on insert, not on delete, so it does not follow
 * analytics_events on its own.
 */
async function deleteSiteAnalytics(siteUuid: string): Promise<void> {
  for (const table of SITE_TABLES) {
    await clickhouseCommand(
      `DELETE FROM ${table} WHERE site_uuid = {site_uuid:String}`,
      { site_uuid: siteUuid },
    )
  }
}

/**
 * Replace one site's analytics with the rows in a JSONEachRow dump.
 *
 * The site_uuid is *supplied here*, not taken from the file: an archive is
 * something a site owner can upload, and a row's own site_uuid would let one
 * write into another site's analytics. The dump's column is skipped instead
 * (input_format_skip_unknown_fields) and every row lands under `siteUuid`.
 * mv_hits repopulates itself from the insert through its materialized view.
 */
export async function replaceSiteAnalytics({
  siteUuid,
  sourcePath,
}: {
  siteUuid: string
  sourcePath: string
}): Promise<{ rows: number }> {
  const stat = await fs.stat(sourcePath).catch(() => null)

  await deleteSiteAnalytics(siteUuid)

  if (!stat?.isFile() || stat.size === 0) {
    return { rows: 0 }
  }

  const counter = rowCounter()
  const rows = Readable.toWeb(
    createReadStream(sourcePath).pipe(counter),
  ) as ReadableStream

  const response = await clickhouseRequest({
    sql:
      `INSERT INTO analytics_events SELECT timestamp, session_id, action, ` +
      `version, payload, {site_uuid:String} AS site_uuid, inserted_at ` +
      `FROM input('${EVENT_INPUT_STRUCTURE}') FORMAT JSONEachRow`,
    params: { site_uuid: siteUuid },
    settings: {
      // The dump carries site_uuid, which input() above does not declare.
      input_format_skip_unknown_fields: "1",
      // Accepts both ClickHouse's own "YYYY-MM-DD hh:mm:ss" and ISO stamps,
      // so an archive written by another tool still loads.
      date_time_input_format: "best_effort",
    },
    body: rows,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  })

  await assertOk(response, "analytics reload")

  return { rows: counter.rows }
}
