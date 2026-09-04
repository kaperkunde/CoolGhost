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

function redirectFilePath(key: string): string {
  if (!config.proxyDynamicDir) {
    throw new Error("PROXY_DYNAMIC_DIR is not configured")
  }

  return path.join(config.proxyDynamicDir, `plekje-redirect-${key}.yaml`)
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

  const filePath = redirectFilePath(key)
  const tempPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`

  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    // Write + rename so Traefik's file watcher never sees a half-written file.
    await writeFile(
      tempPath,
      buildRedirectYaml({ key, redirectDomain, targetDomain }),
      "utf8",
    )
    await rename(tempPath, filePath)
    res.json({ ok: true, key, redirectDomain, targetDomain })
  } catch (error) {
    console.error("Failed to write redirect proxy config", { key, error })
    await unlink(tempPath).catch(() => {})
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
