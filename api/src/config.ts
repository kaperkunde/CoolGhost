function requireEnv(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is not set`)
  }

  return value
}

function optionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.LISTEN_HOST ?? "0.0.0.0",
  apiToken: requireEnv("API_TOKEN"),
  mysqlHost: process.env.MYSQL_HOST?.trim() || "mysql",
  mysqlPort: Number(process.env.MYSQL_PORT ?? 3306),
  mysqlRootPassword: requireEnv("MYSQL_ROOT_PASSWORD"),

  // Backup/export/restore support. All optional — when the mounts/env are
  // absent the data routes respond 503 instead of failing at boot.
  /** Staging dir for export artifacts, restore uploads and job state; also mounted into duplicati. */
  stagingDir: optionalEnv("STAGING_DIR"),
  /** Host docker volumes dir (usually /var/lib/docker/volumes) as mounted in this container. */
  volumesDir: optionalEnv("VOLUMES_DIR") ?? "/local/volumes",
  /** Duplicati web service, e.g. http://duplicati:8200 */
  duplicatiUrl: optionalEnv("DUPLICATI_URL"),
  duplicatiPassword: optionalEnv("DUPLICATI_PASSWORD"),
  /** Where the staging mount lives inside the duplicati container (defaults to STAGING_DIR). */
  duplicatiStagingDir: optionalEnv("DUPLICATI_STAGING_DIR"),
  duplicatiRestoreTimeoutMinutes: Number(
    process.env.DUPLICATI_RESTORE_TIMEOUT_MINUTES ?? 60,
  ),
  /** How long export artifacts, uploads and finished job dirs are kept. */
  artifactTtlHours: Number(process.env.ARTIFACT_TTL_HOURS ?? 24),
  /** Largest restore archive accepted by POST /v1/data/spots/:spot/uploads. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 4 * 1024 * 1024 * 1024),
  /** uid/gid the Ghost container runs as — restored content is chowned to this. */
  ghostContentUid: Number(process.env.GHOST_CONTENT_UID ?? 1000),
  ghostContentGid: Number(process.env.GHOST_CONTENT_GID ?? 1000),

  // Redirect-domain support. Optional — when the proxy dynamic dir is not
  // mounted the proxy routes respond 503 instead of failing at boot.
  /** Coolify's Traefik file-provider dir (host /data/coolify/proxy/dynamic) as mounted here. */
  proxyDynamicDir: optionalEnv("PROXY_DYNAMIC_DIR"),
  /** Cert resolver name in the Coolify-generated Traefik config. */
  traefikCertResolver: optionalEnv("TRAEFIK_CERT_RESOLVER") ?? "letsencrypt",

  // Analytics storage reporting. Optional — without CLICKHOUSE_URL the
  // /v1/storage/analytics route responds 503.
  /** Shared ClickHouse HTTP interface, e.g. http://clickhouse:8123 */
  clickhouseUrl: optionalEnv("CLICKHOUSE_URL"),
  clickhouseDatabase: optionalEnv("CLICKHOUSE_DATABASE") ?? "ghost_analytics",
  clickhouseUser: optionalEnv("CLICKHOUSE_USER"),
  clickhousePassword: optionalEnv("CLICKHOUSE_PASSWORD"),
}
