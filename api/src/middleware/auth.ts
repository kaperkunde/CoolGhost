import type { NextFunction, Request, Response } from "express"

import { config } from "../config.js"

function readBearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) {
    return null
  }

  const token = authorization.slice("Bearer ".length).trim()
  return token || null
}

export function requireApiToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = readBearerToken(req.header("authorization"))

  if (!token || token !== config.apiToken) {
    res.status(401).json({ error: "Unauthorized" })
    return
  }

  next()
}
