import { Router } from "express"
import type { Response } from "express"

import {
  ensureGhostAssistantAccess,
  GhostAccessUnavailableError,
  GhostAccessValidationError,
  isMissingDatabaseError,
  revokeGhostAssistantAccess,
} from "../lib/ghost-assistant-access.js"
import { formatMysqlError } from "../lib/mysql-connectivity.js"
import { requireApiToken } from "../middleware/auth.js"

/**
 * Rows inside a site's own Ghost database that the GhostHost app manages on
 * the owner's behalf. Today: the staff user and staff access token the
 * plek.je assistant connector signs its Admin API requests with.
 */
export const ghostRouter = Router()

function handleError(
  res: Response,
  error: unknown,
  context: Record<string, unknown>,
): void {
  if (error instanceof GhostAccessValidationError) {
    res.status(400).json({ error: error.message })
    return
  }

  if (error instanceof GhostAccessUnavailableError) {
    res.status(409).json({ error: error.message })
    return
  }

  if (isMissingDatabaseError(error)) {
    res.status(404).json({ error: "No Ghost database by that name" })
    return
  }

  // Never log bodies: a successful answer here carries a secret.
  console.error("Ghost assistant access request failed", { ...context, error })
  res.status(500).json({ error: formatMysqlError(error) })
}

ghostRouter.post(
  "/:database/assistant-access",
  requireApiToken,
  async (req, res) => {
    const database = String(req.params.database ?? "")
    const body = (req.body ?? {}) as Record<string, unknown>

    try {
      const result = await ensureGhostAssistantAccess({
        database,
        slug: body.slug as string,
        name: body.name as string,
        email: body.email as string,
      })

      res.json({ ok: true, ...result })
    } catch (error) {
      handleError(res, error, { database, slug: body.slug })
    }
  },
)

ghostRouter.delete(
  "/:database/assistant-access/:slug",
  requireApiToken,
  async (req, res) => {
    const database = String(req.params.database ?? "")
    const slug = String(req.params.slug ?? "")

    try {
      const result = await revokeGhostAssistantAccess({ database, slug })
      res.json({ ok: true, ...result })
    } catch (error) {
      handleError(res, error, { database, slug })
    }
  },
)
