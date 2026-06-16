import { Router } from "express"

import { readProvisionCredentials } from "../lib/read-provision-credentials.js"
import {
  formatMysqlError,
  provisionMysqlUser,
  ProvisionValidationError,
} from "../lib/provision-mysql-user.js"
import { requireApiToken } from "../middleware/auth.js"

export const provisionRouter = Router()

provisionRouter.post(
  "/mysql-user",
  requireApiToken,
  async (req, res) => {
    const { username, password } = readProvisionCredentials(req)

    if (!username || !password) {
      res.status(400).json({
        error: "username and password are required",
      })
      return
    }

    try {
      const result = await provisionMysqlUser({ username, password })

      res.json({
        ok: true,
        ...result,
      })
    } catch (error) {
      if (error instanceof ProvisionValidationError) {
        res.status(400).json({ error: error.message })
        return
      }

      console.error("Failed to provision MySQL user", {
        username,
        error,
      })

      res.status(500).json({
        error: formatMysqlError(error),
      })
    }
  },
)
