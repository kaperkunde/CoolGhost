import mysql from "mysql2/promise"

import { mysqlConnectionOptions } from "./mysql-connectivity.js"

const EXCLUDED_DATABASES = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
  "plekje",
])

export async function listMysqlDatabases(): Promise<string[]> {
  const connection = await mysql.createConnection(mysqlConnectionOptions())

  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name",
    )

    return rows
      .map((row) => row.name as string)
      .filter((name) => typeof name === "string" && !EXCLUDED_DATABASES.has(name))
  } finally {
    await connection.end()
  }
}
