import { Router } from "express"

import {
  dropMysqlDatabase,
  DropDatabaseValidationError,
} from "../lib/drop-mysql-database.js"
import { listMysqlDatabases } from "../lib/list-mysql-databases.js"
import { requireApiToken } from "../middleware/auth.js"

export const databasesRouter = Router()

databasesRouter.get("/", requireApiToken, async (_req, res) => {
  try {
    const databases = await listMysqlDatabases()
    res.json({ ok: true, databases })
  } catch (error) {
    console.error("Failed to list MySQL databases", { error })
    res.status(500).json({ error: "Failed to list databases" })
  }
})

databasesRouter.delete("/:name", requireApiToken, async (req, res) => {
  const name = String(req.params["name"])

  try {
    await dropMysqlDatabase(name)
    res.json({ ok: true })
  } catch (error) {
    if (error instanceof DropDatabaseValidationError) {
      res.status(400).json({ error: error.message })
      return
    }

    console.error("Failed to drop MySQL database", { name, error })
    res.status(500).json({ error: "Failed to drop database" })
  }
})
