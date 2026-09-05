import express from "express"

import { config } from "./config.js"
import { loadPersistedJobs } from "./lib/data-jobs.js"
import { checkMysqlConnectivity, formatMysqlError } from "./lib/mysql-connectivity.js"
import { ensureStagingLayout, startStagingSweeper } from "./lib/staging.js"
import { dataRouter } from "./routes/data.js"
import { databasesRouter } from "./routes/databases.js"
import { provisionRouter } from "./routes/provision.js"
import { proxyRouter } from "./routes/proxy.js"
import { storageRouter } from "./routes/storage.js"

const JSON_BODY_LIMIT = "1kb"

const app = express()

app.use(express.json({ limit: JSON_BODY_LIMIT }))

app.get("/", (_req, res) => {
  res.json({
    service: "ghosthost-api",
    health: "GET /health",
    provision: "POST /v1/provision/mysql-user",
    storage: "GET /v1/storage/content",
  })
})

app.get("/health", async (_req, res) => {
  try {
    await checkMysqlConnectivity()
    res.json({ ok: true, mysql: true })
  } catch (error) {
    console.error("MySQL health check failed", {
      host: config.mysqlHost,
      port: config.mysqlPort,
      error,
    })

    res.status(503).json({
      ok: false,
      mysql: false,
      error: formatMysqlError(error),
    })
  }
})

app.use("/v1/provision", provisionRouter)
app.use("/v1/databases", databasesRouter)
app.use("/v1/data", dataRouter)
app.use("/v1/proxy", proxyRouter)
app.use("/v1/storage", storageRouter)

if (!config.proxyDynamicDir) {
  console.info(
    "PROXY_DYNAMIC_DIR not set — proxy redirect routes will respond 503.",
  )
}

async function bootstrapStaging(): Promise<void> {
  if (!config.stagingDir) {
    console.info(
      "STAGING_DIR not set — export/restore routes will respond 503.",
    )
    return
  }

  await ensureStagingLayout()
  await loadPersistedJobs()
  startStagingSweeper()
}

bootstrapStaging().catch((error) => {
  console.error("Failed to initialize staging", { error })
})

app.listen(config.port, config.host, () => {
  console.info(`ghosthost-api listening on ${config.host}:${config.port}`)
})
