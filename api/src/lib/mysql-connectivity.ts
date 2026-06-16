import mysql from "mysql2/promise"

import { config } from "../config.js"

export function formatMysqlError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Could not connect to MySQL."
  }

  const err = error as NodeJS.ErrnoException & {
    code?: string
    errno?: number
    sqlMessage?: string
  }

  switch (err.code) {
    case "ECONNREFUSED":
      return `Could not connect to MySQL at ${config.mysqlHost}:${config.mysqlPort}. Check MYSQL_HOST and the predefined network.`
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `MySQL host "${config.mysqlHost}" could not be resolved. Set MYSQL_HOST to the shared MySQL stack hostname (Coolify custom name + trailing dash, e.g. mysql-ghost-).`
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
      return `Timed out connecting to MySQL at ${config.mysqlHost}:${config.mysqlPort}. Check MYSQL_HOST and network connectivity.`
    case "ER_ACCESS_DENIED_ERROR":
      return "MySQL root authentication failed. Check MYSQL_ROOT_PASSWORD."
    default:
      break
  }

  if (err.sqlMessage) {
    return err.sqlMessage
  }

  if (err.message) {
    return err.message
  }

  return "Could not connect to MySQL."
}

export async function checkMysqlConnectivity(): Promise<void> {
  const connection = await mysql.createConnection({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: "root",
    password: config.mysqlRootPassword,
    connectTimeout: 5_000,
  })

  try {
    await connection.ping()
  } finally {
    await connection.end()
  }
}

export function mysqlConnectionOptions() {
  return {
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: "root",
    password: config.mysqlRootPassword,
    connectTimeout: 5_000,
    multipleStatements: true,
  } as const
}
