import type { Request } from "express"

export type ProvisionRequestBody = {
  username?: unknown
  password?: unknown
}

export function readProvisionCredentials(req: Request): {
  username: string | null
  password: string | null
} {
  const body = req.body as ProvisionRequestBody
  const username =
    typeof body.username === "string" ? body.username : null
  const password =
    typeof body.password === "string" ? body.password : null

  return {
    username: username?.trim() || null,
    password: password ?? null,
  }
}
