import { execFile } from "child_process"
import { createWriteStream, createReadStream } from "fs"
import { spawn } from "child_process"
import { promisify } from "util"

import mysql from "mysql2/promise"

import { config } from "../config.js"
import { mysqlConnectionOptions } from "./mysql-connectivity.js"
import { assertSafeDatabaseName } from "./staging.js"

const execFileAsync = promisify(execFile)

/**
 * The mysql/mysqldump CLIs are used for bulk dump/import (streaming, battle
 * tested with large databases); mysql2 is used for small metadata queries.
 * The root password travels via MYSQL_PWD so it never appears in argv.
 */

function cliArgs(): string[] {
  return ["-h", config.mysqlHost, "-P", String(config.mysqlPort), "-u", "root"]
}

function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, MYSQL_PWD: config.mysqlRootPassword }
}

export async function dumpDatabaseToFile({
  database,
  destPath,
}: {
  database: string
  destPath: string
}): Promise<void> {
  const db = assertSafeDatabaseName(database)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "mysqldump",
      [
        ...cliArgs(),
        "--single-transaction",
        "--quick",
        "--lock-tables=false",
        db,
      ],
      { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] },
    )

    const out = createWriteStream(destPath)
    let stderr = ""

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.stdout.pipe(out)

    out.on("error", (error) => {
      child.kill()
      reject(error)
    })

    child.on("error", reject)
    child.on("close", (code) => {
      out.close(() => {
        if (code === 0) {
          resolve()
        } else {
          reject(
            new Error(
              `mysqldump exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
            ),
          )
        }
      })
    })
  })
}

/** Drop, recreate and re-import a database from a plain SQL dump file. */
export async function importDatabaseFromFile({
  database,
  sqlPath,
}: {
  database: string
  sqlPath: string
}): Promise<void> {
  const db = assertSafeDatabaseName(database)

  // Grants reference the database by name, so dropping it does not revoke
  // the spot's MySQL user — access is restored with the new database.
  await execFileAsync(
    "mysql",
    [
      ...cliArgs(),
      "-e",
      `DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4;`,
    ],
    { env: cliEnv() },
  )

  await new Promise<void>((resolve, reject) => {
    const child = spawn("mysql", [...cliArgs(), db], {
      env: cliEnv(),
      stdio: ["pipe", "ignore", "pipe"],
    })

    let stderr = ""

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const input = createReadStream(sqlPath)

    input.on("error", (error) => {
      child.kill()
      reject(error)
    })

    input.pipe(child.stdin)

    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `mysql import exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
          ),
        )
      }
    })
  })
}

export async function getMysqlServerVersion(): Promise<string | null> {
  const connection = await mysql.createConnection(mysqlConnectionOptions())

  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT VERSION() AS version",
    )

    return (rows[0]?.version as string | undefined) ?? null
  } catch {
    return null
  } finally {
    await connection.end()
  }
}

/** Best-effort reads from the Ghost database for info.json metadata. */
export async function getGhostSiteMetadata(database: string): Promise<{
  siteTitle: string | null
  ghostMigrationVersion: string | null
}> {
  const db = assertSafeDatabaseName(database)
  const connection = await mysql.createConnection(mysqlConnectionOptions())

  try {
    let siteTitle: string | null = null
    let ghostMigrationVersion: string | null = null

    try {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT value FROM \`${db}\`.settings WHERE \`key\` = 'title' LIMIT 1`,
      )
      siteTitle = (rows[0]?.value as string | undefined) ?? null
    } catch {
      // Table may not exist yet (fresh Ghost install).
    }

    try {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT version FROM \`${db}\`.migrations ORDER BY id DESC LIMIT 1`,
      )
      ghostMigrationVersion = (rows[0]?.version as string | undefined) ?? null
    } catch {
      // Same — informational only.
    }

    return { siteTitle, ghostMigrationVersion }
  } finally {
    await connection.end()
  }
}
