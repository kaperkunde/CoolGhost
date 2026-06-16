import mysql from "mysql2/promise"

import { config } from "../config.js"

export const MYSQL_USERNAME_REGEX = /^[A-Za-z0-9_]+$/

export type ProvisionMysqlUserInput = {
  username: string
  password: string
}

export type ProvisionMysqlUserResult = {
  username: string
  database: string
  createdUser: boolean
  updatedPassword: boolean
  createdDatabase: boolean
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, "``")}\``
}

async function userExists(
  connection: mysql.Connection,
  username: string,
): Promise<boolean> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT 1 FROM mysql.user WHERE user = ? AND host = '%' LIMIT 1",
    [username],
  )

  return rows.length > 0
}

async function databaseExists(
  connection: mysql.Connection,
  databaseName: string,
): Promise<boolean> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = ? LIMIT 1",
    [databaseName],
  )

  return rows.length > 0
}

async function passwordMatches(
  username: string,
  password: string,
  databaseName: string,
): Promise<boolean> {
  try {
    const probe = await mysql.createConnection({
      host: config.mysqlHost,
      port: config.mysqlPort,
      user: username,
      password,
      database: databaseName,
    })

    await probe.ping()
    await probe.end()
    return true
  } catch {
    return false
  }
}

export async function provisionMysqlUser({
  username,
  password,
}: ProvisionMysqlUserInput): Promise<ProvisionMysqlUserResult> {
  if (!MYSQL_USERNAME_REGEX.test(username)) {
    throw new ProvisionValidationError(
      "username must contain only letters, numbers, and underscores",
    )
  }

  if (!password) {
    throw new ProvisionValidationError("password is required")
  }

  const databaseName = username
  const connection = await mysql.createConnection({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: "root",
    password: config.mysqlRootPassword,
    multipleStatements: true,
  })

  try {
    const existedBefore = await userExists(connection, username)
    const databaseExistedBefore = await databaseExists(connection, databaseName)
    const passwordAlreadyMatches = existedBefore
      ? await passwordMatches(username, password, databaseName)
      : false

    const escapedPassword = connection.escape(password)
    const quotedDatabase = quoteIdentifier(databaseName)

    await connection.query(
      `CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY ${escapedPassword}`,
    )

    if (!passwordAlreadyMatches) {
      await connection.query(
        `ALTER USER '${username}'@'%' IDENTIFIED BY ${escapedPassword}`,
      )
    }

    await connection.query(`CREATE DATABASE IF NOT EXISTS ${quotedDatabase}`)

    await connection.query(
      `GRANT ALL PRIVILEGES ON ${quotedDatabase}.* TO '${username}'@'%'`,
    )

    await connection.query("FLUSH PRIVILEGES")

    return {
      username,
      database: databaseName,
      createdUser: !existedBefore,
      updatedPassword: existedBefore && !passwordAlreadyMatches,
      createdDatabase: !databaseExistedBefore,
    }
  } finally {
    await connection.end()
  }
}

export class ProvisionValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProvisionValidationError"
  }
}
