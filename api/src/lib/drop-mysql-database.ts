import mysql from "mysql2/promise"

import { mysqlConnectionOptions } from "./mysql-connectivity.js"

const SAFE_DB_NAME_REGEX = /^[a-zA-Z0-9_]+$/

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, "``")}\``
}

export class DropDatabaseValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DropDatabaseValidationError"
  }
}

export async function dropMysqlDatabase(name: string): Promise<void> {
  if (!SAFE_DB_NAME_REGEX.test(name)) {
    throw new DropDatabaseValidationError(
      "database name must contain only letters, numbers, and underscores",
    )
  }

  const connection = await mysql.createConnection(mysqlConnectionOptions())

  try {
    await connection.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`)
  } finally {
    await connection.end()
  }
}
