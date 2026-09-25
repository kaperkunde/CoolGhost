import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"

import { Router } from "express"

import { config } from "../config.js"
import { requireApiToken } from "../middleware/auth.js"

export const proxyRouter = Router()

/**
 * Traefik file-provider names share one namespace across every dynamic file,
 * so the key prefixes all router/middleware/service names. It also becomes
 * part of the filename — validate hard before it touches the filesystem.
 */
const KEY_REGEX = /^[a-z0-9][a-z0-9_-]{0,120}$/

/** RFC 1123-ish hostname: dot-separated alphanumeric/hyphen labels. */
const HOSTNAME_REGEX =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

function dynamicFilePath(fileName: string): string {
  if (!config.proxyDynamicDir) {
    throw new Error("PROXY_DYNAMIC_DIR is not configured")
  }

  return path.join(config.proxyDynamicDir, fileName)
}

function redirectFilePath(key: string): string {
  return dynamicFilePath(`plekje-redirect-${key}.yaml`)
}

/** Write + rename so Traefik's file watcher never sees a half-written file. */
async function writeDynamicFile(filePath: string, contents: string) {
  const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`

  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(tempPath, contents, "utf8")
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

/**
 * A redirect-only router still needs a service, so each file carries a dummy
 * one. `certResolver` matches the name Coolify's generated proxy config uses,
 * so Let's Encrypt issuance works exactly like it does for deployed apps.
 * Priority 3000 sits above the analytics PathPrefix routers (2000) so stats
 * paths on a redirect host redirect instead of proxying; Traefik's internal
 * ACME HTTP-01 router has max priority and is not shadowed.
 */
function buildRedirectYaml({
  key,
  redirectDomain,
  targetDomain,
}: {
  key: string
  redirectDomain: string
  targetDomain: string
}): string {
  const resolver = config.traefikCertResolver

  return `# Managed by the GhostHost API — plek.je redirect domain. Do not edit.
http:
  routers:
    plekje-redirect-${key}-https:
      rule: "Host(\`${redirectDomain}\`)"
      entryPoints:
        - https
      service: plekje-redirect-${key}-noop
      middlewares:
        - plekje-redirect-${key}
      priority: 3000
      tls:
        certResolver: ${resolver}
    plekje-redirect-${key}-http:
      rule: "Host(\`${redirectDomain}\`)"
      entryPoints:
        - http
      service: plekje-redirect-${key}-noop
      middlewares:
        - plekje-redirect-${key}
      priority: 3000
  middlewares:
    plekje-redirect-${key}:
      redirectRegex:
        regex: "^https?://[^/]+/?(.*)"
        replacement: "https://${targetDomain}/\${1}"
        permanent: true
  services:
    plekje-redirect-${key}-noop:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:9"
`
}

function readHostnameField(body: unknown, field: string): string | null {
  if (typeof body !== "object" || body === null) {
    return null
  }

  const value = (body as Record<string, unknown>)[field]

  if (typeof value !== "string") {
    return null
  }

  const hostname = value.trim().toLowerCase()
  return HOSTNAME_REGEX.test(hostname) ? hostname : null
}

function requireProxyDir(res: {
  status: (code: number) => { json: (body: unknown) => void }
}): boolean {
  if (!config.proxyDynamicDir) {
    res.status(503).json({
      error:
        "Proxy redirects are not configured on this server (PROXY_DYNAMIC_DIR is unset).",
    })
    return false
  }

  return true
}

proxyRouter.put("/redirects/:key", requireApiToken, async (req, res) => {
  if (!requireProxyDir(res)) return

  const key = String(req.params["key"])

  if (!KEY_REGEX.test(key)) {
    res.status(400).json({ error: "Invalid redirect key" })
    return
  }

  const redirectDomain = readHostnameField(req.body, "redirectDomain")
  const targetDomain = readHostnameField(req.body, "targetDomain")

  if (!redirectDomain || !targetDomain) {
    res.status(400).json({
      error: "redirectDomain and targetDomain must be valid hostnames",
    })
    return
  }

  try {
    await writeDynamicFile(
      redirectFilePath(key),
      buildRedirectYaml({ key, redirectDomain, targetDomain }),
    )
    res.json({ ok: true, key, redirectDomain, targetDomain })
  } catch (error) {
    console.error("Failed to write redirect proxy config", { key, error })
    res.status(500).json({ error: "Failed to write redirect config" })
  }
})

proxyRouter.delete("/redirects/:key", requireApiToken, async (req, res) => {
  if (!requireProxyDir(res)) return

  const key = String(req.params["key"])

  if (!KEY_REGEX.test(key)) {
    res.status(400).json({ error: "Invalid redirect key" })
    return
  }

  try {
    await unlink(redirectFilePath(key))
    res.json({ ok: true, key, removed: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      res.json({ ok: true, key, removed: false })
      return
    }

    console.error("Failed to remove redirect proxy config", { key, error })
    res.status(500).json({ error: "Failed to remove redirect config" })
  }
})

/**
 * The analytics routes every Ghost site on this server relies on: its tracker
 * posts page hits to /.ghost/analytics and its admin reads stats from
 * /.ghost/stats, on the site's own domain. Priority 2000 wins over each
 * site's Host() router (and loses to a redirect domain's 3000). Same routes
 * as traefik.coolghost.yaml, which is what a server set up by hand carries —
 * the router names match it on purpose, so a server with both files keeps
 * one working copy (Traefik skips a name it has already loaded).
 */
const ANALYTICS_FILE = "coolghost-analytics.yaml"

function buildAnalyticsYaml({
  statsUrl,
  trackerUrl,
}: {
  statsUrl: string
  trackerUrl: string
}): string {
  return `# Managed by the GhostHost API — Ghost analytics routes. Do not edit.
http:
  routers:
    coolghost-stats-https:
      rule: "PathPrefix(\`/.ghost/stats\`)"
      entryPoints:
        - https
      service: coolghost-stats
      middlewares:
        - coolghost-stats-strip
      priority: 2000
      tls: {}
    coolghost-analytics-https:
      rule: "PathPrefix(\`/.ghost/analytics\`)"
      entryPoints:
        - https
      service: coolghost-analytics
      middlewares:
        - coolghost-analytics-strip
      priority: 2000
      tls: {}
    coolghost-stats-http:
      rule: "PathPrefix(\`/.ghost/stats\`)"
      entryPoints:
        - http
      middlewares:
        - redirect-to-https
      service: coolghost-stats
      priority: 2000
    coolghost-analytics-http:
      rule: "PathPrefix(\`/.ghost/analytics\`)"
      entryPoints:
        - http
      middlewares:
        - redirect-to-https
      service: coolghost-analytics
      priority: 2000
  middlewares:
    coolghost-stats-strip:
      stripPrefix:
        prefixes:
          - /.ghost/stats
    coolghost-analytics-strip:
      stripPrefix:
        prefixes:
          - /.ghost/analytics
  services:
    coolghost-stats:
      loadBalancer:
        servers:
          - url: ${JSON.stringify(statsUrl)}
    coolghost-analytics:
      loadBalancer:
        servers:
          - url: ${JSON.stringify(trackerUrl)}
`
}

const UPSTREAM_CHECK_TIMEOUT_MS = 5_000

/** Whether an analytics service answers at the address the routes point to. */
async function upstreamAnswers(url: string, expect: RegExp): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(UPSTREAM_CHECK_TIMEOUT_MS),
    })
    return response.ok && expect.test(await response.text())
  } catch {
    return false
  }
}

/**
 * Install (or refresh) the analytics routes, then check both services answer
 * where the routes send traffic. Idempotent: the GhostHost app calls it each
 * time a server is paired. The file is written even when a check fails — the
 * routes are right, it is the analytics stack that needs looking at — and the
 * failure is reported so pairing does not pass silently.
 */
proxyRouter.put("/analytics", requireApiToken, async (_req, res) => {
  if (!requireProxyDir(res)) return

  const statsUrl = config.analyticsStatsUrl
  const trackerUrl = config.analyticsTrackerUrl

  try {
    await writeDynamicFile(
      dynamicFilePath(ANALYTICS_FILE),
      buildAnalyticsYaml({ statsUrl, trackerUrl }),
    )
  } catch (error) {
    console.error("Failed to write analytics proxy config", { error })
    res.status(500).json({ error: "Failed to write the analytics routes." })
    return
  }

  const [statsOk, trackerOk] = await Promise.all([
    upstreamAnswers(`${statsUrl}/v0/health`, /ok/),
    upstreamAnswers(`${trackerUrl}/`, /Ghost/),
  ])

  const unreachable = [
    ...(statsOk ? [] : [`traffic-stats at ${statsUrl}`]),
    ...(trackerOk ? [] : [`traffic-analytics at ${trackerUrl}`]),
  ]

  if (unreachable.length > 0) {
    res.status(502).json({
      error: `Analytics routes written to ${ANALYTICS_FILE}, but ${unreachable.join(
        " and ",
      )} did not answer. Check the analytics stack is running and on the coolify network (ANALYTICS_STATS_URL / ANALYTICS_TRACKER_URL).`,
    })
    return
  }

  res.json({ ok: true, file: ANALYTICS_FILE, statsUrl, trackerUrl })
})
