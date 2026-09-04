import { randomUUID } from "crypto"
import { createWriteStream, promises as fs } from "fs"
import path from "path"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"

import { config } from "../config.js"
import { assertSafeName, toStagingRelativePath, uploadsDir } from "./staging.js"

function formatLimit(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024)

  return gib >= 1
    ? `${Math.round(gib * 10) / 10} GB`
    : `${Math.round(bytes / (1024 * 1024))} MB`
}

export class EmptyUploadError extends Error {
  constructor() {
    super("The uploaded file is empty.")
    this.name = "EmptyUploadError"
  }
}

export class UploadTooLargeError extends Error {
  constructor() {
    super(`Restore uploads are limited to ${formatLimit(config.maxUploadBytes)}.`)
    this.name = "UploadTooLargeError"
  }
}

/**
 * Stream a restore archive into uploads/. Returns the staging-relative path
 * the caller passes back as the `upload` restore source; the restore job
 * deletes the file when it is done with it, the sweeper catches the rest.
 */
export async function writeRestoreUpload({
  spotId,
  body,
}: {
  spotId: string
  body: Readable
}): Promise<{ uploadRelPath: string; sizeBytes: number }> {
  const safeId = assertSafeName(spotId, "spot id")
  const dir = uploadsDir()

  await fs.mkdir(dir, { recursive: true })

  const filePath = path.join(dir, `${safeId}-${randomUUID()}.tar.gz`)

  let sizeBytes = 0

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength

      if (sizeBytes > config.maxUploadBytes) {
        callback(new UploadTooLargeError())
        return
      }

      callback(null, chunk)
    },
  })

  try {
    await pipeline(body, limiter, createWriteStream(filePath))
  } catch (error) {
    await fs.rm(filePath, { force: true }).catch(() => undefined)
    throw error
  }

  if (sizeBytes === 0) {
    await fs.rm(filePath, { force: true }).catch(() => undefined)
    throw new EmptyUploadError()
  }

  return { uploadRelPath: toStagingRelativePath(filePath), sizeBytes }
}
