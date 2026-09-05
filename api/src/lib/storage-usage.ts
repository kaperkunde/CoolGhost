import mysql from "mysql2/promise"

import { config } from "../config.js"
import { EXCLUDED_DATABASES } from "./list-mysql-databases.js"
import { mysqlConnectionOptions } from "./mysql-connectivity.js"

export type MysqlDatabaseUsage = {
  name: string
  /** Data plus index length as reported by information_schema (approximate). */
  sizeBytes: number
  tableCount: number
  /** Ghost's site_uuid setting, which keys its rows in the analytics store. */
  siteUuid: string | null
}

/** Size and Ghost site uuid of every blog database on the shared MySQL. */
export async function listMysqlDatabaseUsage(): Promise<MysqlDatabaseUsage[]> {
  const connection = await mysql.createConnection(mysqlConnectionOptions())

  try {
    const [schemaRows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name",
    )
    const [sizeRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS name,
              COALESCE(SUM(data_length + index_length), 0) AS size_bytes,
              COUNT(*) AS table_count
         FROM information_schema.tables
        GROUP BY table_schema`,
    )

    const sizeByName = new Map(
      sizeRows.map((row) => [
        String(row.name),
        {
          sizeBytes: Number(row.size_bytes ?? 0),
          tableCount: Number(row.table_count ?? 0),
        },
      ]),
    )

    const databases: MysqlDatabaseUsage[] = []

    for (const row of schemaRows) {
      const name = String(row.name)

      if (EXCLUDED_DATABASES.has(name)) continue

      // Not user input, but keep the identifier rule the other routes enforce
      // before it lands inside backticks.
      if (!/^[A-Za-z0-9_]+$/.test(name)) continue

      let siteUuid: string | null = null

      try {
        const [settingRows] = await connection.query<mysql.RowDataPacket[]>(
          `SELECT value FROM \`${name}\`.settings WHERE \`key\` = 'site_uuid' LIMIT 1`,
        )
        const value = settingRows[0]?.value

        siteUuid =
          typeof value === "string" && value.trim() ? value.trim() : null
      } catch {
        // Not a Ghost database (or not migrated yet).
      }

      const size = sizeByName.get(name) ?? { sizeBytes: 0, tableCount: 0 }

      databases.push({ name, ...size, siteUuid })
    }

    return databases
  } finally {
    await connection.end()
  }
}

export type ClickhouseTableUsage = {
  name: string
  bytesOnDisk: number
  rows: number
}

export type ClickhouseSiteUsage = {
  siteUuid: string
  rows: number
  /**
   * Bytes on disk apportioned by the site's share of each table's rows. The
   * analytics tables are shared MergeTrees, so a per-site figure can only be
   * an estimate.
   */
  estimatedBytes: number
}

export type ClickhouseUsage = {
  tables: ClickhouseTableUsage[]
  sites: ClickhouseSiteUsage[]
}

export class ClickhouseUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ClickhouseUnavailableError"
  }
}

const CLICKHOUSE_TIMEOUT_MS = 20 * 1000

async function clickhouseQuery<T>(sql: string): Promise<T[]> {
  if (!config.clickhouseUrl) {
    throw new ClickhouseUnavailableError("CLICKHOUSE_URL is not configured")
  }

  const url = new URL(config.clickhouseUrl)
  url.searchParams.set("database", config.clickhouseDatabase)

  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
  }

  if (config.clickhouseUser) {
    headers["X-ClickHouse-User"] = config.clickhouseUser
  }

  if (config.clickhousePassword) {
    headers["X-ClickHouse-Key"] = config.clickhousePassword
  }

  let response: Response

  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: `${sql} FORMAT JSONEachRow`,
      signal: AbortSignal.timeout(CLICKHOUSE_TIMEOUT_MS),
    })
  } catch (error) {
    throw new ClickhouseUnavailableError(
      `Could not reach ClickHouse at ${url.origin}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const text = await response.text()

  if (!response.ok) {
    throw new Error(`ClickHouse query failed (${response.status}): ${text}`)
  }

  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T)
}

/** Analytics tables whose rows are keyed by site_uuid. */
const SITE_TABLES = ["analytics_events", "mv_hits"]

export async function getClickhouseUsage(): Promise<ClickhouseUsage> {
  const db = config.clickhouseDatabase.replace(/'/g, "\\'")

  const tableRows = await clickhouseQuery<{
    name: string
    bytes_on_disk: string | number
    rows: string | number
  }>(
    `SELECT table AS name, sum(bytes_on_disk) AS bytes_on_disk, sum(rows) AS rows
       FROM system.parts
      WHERE active AND database = '${db}'
      GROUP BY table ORDER BY table`,
  )

  const tables: ClickhouseTableUsage[] = tableRows.map((row) => ({
    name: row.name,
    bytesOnDisk: Number(row.bytes_on_disk),
    rows: Number(row.rows),
  }))

  const tableByName = new Map(tables.map((t) => [t.name, t]))
  const sites = new Map<string, ClickhouseSiteUsage>()

  for (const tableName of SITE_TABLES) {
    const table = tableByName.get(tableName)

    if (!table || table.rows === 0) continue

    const perSite = await clickhouseQuery<{
      site_uuid: string
      rows: string | number
    }>(
      `SELECT site_uuid, count() AS rows FROM ${tableName} GROUP BY site_uuid`,
    )

    for (const row of perSite) {
      const rows = Number(row.rows)
      const share = (table.bytesOnDisk * rows) / table.rows
      const existing = sites.get(row.site_uuid)

      if (existing) {
        existing.rows += rows
        existing.estimatedBytes += share
      } else {
        sites.set(row.site_uuid, {
          siteUuid: row.site_uuid,
          rows,
          estimatedBytes: share,
        })
      }
    }
  }

  return {
    tables,
    sites: [...sites.values()]
      .map((site) => ({
        ...site,
        estimatedBytes: Math.round(site.estimatedBytes),
      }))
      .sort((a, b) => b.estimatedBytes - a.estimatedBytes),
  }
}
