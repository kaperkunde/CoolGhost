function requireEnv(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} is not set`)
  }

  return value
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.LISTEN_HOST ?? "0.0.0.0",
  apiToken: requireEnv("API_TOKEN"),
  mysqlHost: process.env.MYSQL_HOST?.trim() || "mysql",
  mysqlPort: Number(process.env.MYSQL_PORT ?? 3306),
  mysqlRootPassword: requireEnv("MYSQL_ROOT_PASSWORD"),
}
