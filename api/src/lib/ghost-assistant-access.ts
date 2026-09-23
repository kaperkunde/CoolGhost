import { randomBytes } from "node:crypto"

import mysql from "mysql2/promise"
import type { Connection, ResultSetHeader, RowDataPacket } from "mysql2/promise"

import { mysqlConnectionOptions } from "./mysql-connectivity.js"
import { assertSafeDatabaseName } from "./staging.js"

/**
 * Access for the plek.je assistant connector inside a site's own Ghost.
 *
 * Ghost's Admin API only lets integration keys reach an allowlist of
 * endpoints (no settings changes, no snippets, …). A staff access token acts
 * with its user's full permissions instead, so the connector gets a dedicated
 * staff user, "Plek.je assistant", with the Administrator role, and a staff
 * token for it. The site owner sees that user under Settings → Staff and can
 * suspend it there to cut assistants off; this module then refuses to hand
 * out its key rather than quietly re-enabling it.
 *
 * Rows follow Ghost 6's schema (ghost/core/core/server/data/schema/schema.js)
 * and what Ghost itself writes for a staff token (ApiKey.add({user_id, type:
 * 'admin'}), which gets the "Admin Integration" role like any admin key).
 * Ghost reads api_keys per request, so the key works without a restart.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/

/** Ghost counts these as active (User model `activeStates`). */
const ACTIVE_STATUSES = new Set(["active", "warn-1", "warn-2", "warn-3", "warn-4"])

const BCRYPT_ALPHABET =
  "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

const NOTIFICATION_COLUMNS = [
  "comment_notifications",
  "free_member_signup_notification",
  "paid_subscription_started_notification",
  "paid_subscription_canceled_notification",
  "mention_notifications",
  "recommendation_notifications",
  "milestone_notifications",
  "donation_notifications",
  "gift_subscription_notifications",
]

export class GhostAccessValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GhostAccessValidationError"
  }
}

/** Ghost has not migrated the database yet, or the user was suspended. */
export class GhostAccessUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GhostAccessUnavailableError"
  }
}

export type EnsureGhostAssistantAccessInput = {
  database: string
  slug: string
  name: string
  email: string
}

export type EnsureGhostAssistantAccessResult = {
  userId: string
  adminKeyId: string
  adminKeySecret: string
  created: boolean
}

function objectId(): string {
  return randomBytes(12).toString("hex")
}

/** A bcrypt-shaped hash nothing hashes to: the user can never sign in. */
function unusablePasswordHash(): string {
  const bytes = randomBytes(53)
  let tail = ""

  for (const byte of bytes) {
    tail += BCRYPT_ALPHABET[byte % BCRYPT_ALPHABET.length]
  }

  return `$2a$10$${tail}`
}

function validateDatabase(database: unknown): string {
  if (typeof database !== "string") {
    throw new GhostAccessValidationError("Invalid database name")
  }

  try {
    return assertSafeDatabaseName(database)
  } catch {
    throw new GhostAccessValidationError("Invalid database name")
  }
}

function validateSlug(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new GhostAccessValidationError(
      "Invalid slug: use 3-64 lowercase letters, digits and dashes",
    )
  }

  return slug
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 191) {
    throw new GhostAccessValidationError("Invalid name: 1-191 characters")
  }

  return name.trim()
}

function validateEmail(email: unknown): string {
  if (
    typeof email !== "string" ||
    email.length > 191 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new GhostAccessValidationError("Invalid email")
  }

  return email.toLowerCase()
}

async function roleId(
  connection: Connection,
  db: string,
  name: string,
): Promise<string> {
  const [roles] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM \`${db}\`.roles WHERE name = ? LIMIT 1`,
    [name],
  )

  const id = roles[0]?.id as string | undefined

  if (!id) {
    throw new GhostAccessUnavailableError(
      "This site's Ghost has not finished setting up its database yet",
    )
  }

  return id
}

async function existingColumns(
  connection: Connection,
  db: string,
  table: string,
): Promise<Set<string>> {
  const [columns] = await connection.query<RowDataPacket[]>(
    `SHOW COLUMNS FROM \`${db}\`.\`${table}\``,
  )

  return new Set(columns.map((column) => String(column.Field)))
}

/**
 * Create (or find) the assistant staff user and its staff token, and return
 * the token. Idempotent on the slug, and it always returns the key as it is
 * now — so after the owner regenerates it in Ghost, or a restore replaces the
 * database, calling again hands back what works.
 */
export async function ensureGhostAssistantAccess(
  input: EnsureGhostAssistantAccessInput,
): Promise<EnsureGhostAssistantAccessResult> {
  const db = validateDatabase(input.database)
  const slug = validateSlug(input.slug)
  const name = validateName(input.name)
  const email = validateEmail(input.email)

  const connection = await mysql.createConnection(mysqlConnectionOptions())

  try {
    await connection.beginTransaction()

    const administratorRoleId = await roleId(connection, db, "Administrator")
    const adminKeyRoleId = await roleId(connection, db, "Admin Integration")

    let created = false

    const [users] = await connection.query<RowDataPacket[]>(
      `SELECT id, status FROM \`${db}\`.users WHERE slug = ? LIMIT 1 FOR UPDATE`,
      [slug],
    )

    let userId = users[0]?.id as string | undefined

    if (userId && !ACTIVE_STATUSES.has(String(users[0]?.status))) {
      throw new GhostAccessUnavailableError(
        "The Plek.je assistant is suspended in this site's staff settings",
      )
    }

    if (!userId) {
      const [emailTaken] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM \`${db}\`.users WHERE email = ? LIMIT 1`,
        [email],
      )

      if (emailTaken.length) {
        throw new GhostAccessValidationError(
          "Another staff user already has the assistant's email address",
        )
      }

      userId = objectId()
      created = true

      const columns = await existingColumns(connection, db, "users")
      const values: Record<string, unknown> = {
        id: userId,
        name,
        slug,
        password: unusablePasswordHash(),
        email,
        status: "active",
        visibility: "public",
        bio: "Acts for the assistants the owner connected on plek.je.",
        website: "https://plek.je",
      }

      for (const column of NOTIFICATION_COLUMNS) {
        if (columns.has(column)) {
          values[column] = 0
        }
      }

      const names = Object.keys(values)

      await connection.query(
        `INSERT INTO \`${db}\`.users (${names.map((n) => `\`${n}\``).join(", ")}, created_at, updated_at)
         VALUES (${names.map(() => "?").join(", ")}, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        names.map((n) => values[n]),
      )

      await connection.query(
        `INSERT INTO \`${db}\`.roles_users (id, role_id, user_id) VALUES (?, ?, ?)`,
        [objectId(), administratorRoleId, userId],
      )
    }

    const [keys] = await connection.query<RowDataPacket[]>(
      `SELECT id, secret FROM \`${db}\`.api_keys
        WHERE user_id = ? AND type = 'admin'
        ORDER BY created_at ASC LIMIT 1`,
      [userId],
    )

    let adminKeyId = keys[0]?.id as string | undefined
    let adminKeySecret = keys[0]?.secret as string | undefined

    if (!adminKeyId || !adminKeySecret) {
      adminKeyId = objectId()
      adminKeySecret = randomBytes(32).toString("hex")
      created = true

      await connection.query(
        `INSERT INTO \`${db}\`.api_keys
           (id, type, secret, role_id, integration_id, user_id, created_at, updated_at)
         VALUES (?, 'admin', ?, ?, NULL, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [adminKeyId, adminKeySecret, adminKeyRoleId, userId],
      )
    }

    await connection.commit()

    return { userId, adminKeyId, adminKeySecret, created }
  } catch (error) {
    await connection.rollback().catch(() => undefined)
    throw error
  } finally {
    await connection.end()
  }
}

/**
 * Take the assistant's key away. The staff user stays (it is the author of
 * whatever it wrote); without a key it can do nothing. Idempotent.
 */
export async function revokeGhostAssistantAccess({
  database,
  slug,
}: {
  database: string
  slug: string
}): Promise<{ revoked: boolean }> {
  const db = validateDatabase(database)
  const validSlug = validateSlug(slug)

  const connection = await mysql.createConnection(mysqlConnectionOptions())

  try {
    const [users] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM \`${db}\`.users WHERE slug = ? LIMIT 1`,
      [validSlug],
    )

    const userId = users[0]?.id as string | undefined

    if (!userId) {
      return { revoked: false }
    }

    const [result] = await connection.query<ResultSetHeader>(
      `DELETE FROM \`${db}\`.api_keys WHERE user_id = ?`,
      [userId],
    )

    return { revoked: result.affectedRows > 0 }
  } finally {
    await connection.end()
  }
}

/** MySQL's "no such database" / "no such table" as a 404 for the caller. */
export function isMissingDatabaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code

  return code === "ER_BAD_DB_ERROR" || code === "ER_NO_SUCH_TABLE"
}
