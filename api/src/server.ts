import express from "express"

import { config } from "./config.js"
import { provisionRouter } from "./routes/provision.js"

const JSON_BODY_LIMIT = "1kb"

const app = express()

app.use(express.json({ limit: JSON_BODY_LIMIT }))

app.get("/", (_req, res) => {
  res.json({
    service: "ghosthost-api",
    provision: "POST /v1/provision/mysql-user",
  })
})

app.get("/health", (_req, res) => {
  res.json({ ok: true })
})

app.use("/v1/provision", provisionRouter)

app.listen(config.port, config.host, () => {
  console.info(`ghosthost-api listening on ${config.host}:${config.port}`)
})
