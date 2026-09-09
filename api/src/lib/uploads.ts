import { randomUUID } from "crypto"
import { createWriteStream, promises as fs } from "fs"
import path from "path"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"

import { config } from "../config.js"
import {
  assertSafeName,
  resolveStagingRelativePath,
  toStagingRelativePath,
  uploadsDir,
} from "./staging.js"

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
    super(
      `Restore uploads are limited to ${formatLimit(config.maxUploadBytes)}.`,
    )
    this.name = "UploadTooLargeError"
  }
}

export class UploadNotFoundError extends Error {
  constructor() {
    super(
      "The upload session was not found — it may have expired. Start the upload again.",
    )
    this.name = "UploadNotFoundError"
  }
}

/**
 * The chunk's offset is not where the file currently ends. Carries the real
 * size so the client can resume from it (a retried chunk that did land).
 */
export class UploadOffsetMismatchError extends Error {
  readonly sizeBytes: number

  constructor(sizeBytes: number) {
    super("Chunk offset does not match the bytes received so far.")
    this.name = "UploadOffsetMismatchError"
    this.sizeBytes = sizeBytes
  }
}

/** Counts the bytes passing through and fails the stream past the upload limit. */
function limitedCounter(startBytes: number) {
  let sizeBytes = startBytes

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength

      if (sizeBytes > config.maxUploadBytes) {
        callback(new UploadTooLargeError())
        return
      }

      callback(null, chunk)
    },
  })

  return { stream, size: () => sizeBytes }
}

/**
 * Stream a restore archive into uploads/ in one request. Returns the
 * staging-relative path the caller passes back as the `upload` restore
 * source; the restore job deletes the file when it is done with it, the
 * sweeper catches the rest.
 *
 * Only workable when the whole body arrives inside every proxy's request
 * timeout — see the chunked session below for the general case.
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
  const counter = limitedCounter(0)

  try {
    await pipeline(body, counter.stream, createWriteStream(filePath))
  } catch (error) {
    await fs.rm(filePath, { force: true }).catch(() => undefined)
    throw error
  }

  if (counter.size() === 0) {
    await fs.rm(filePath, { force: true }).catch(() => undefined)
    throw new EmptyUploadError()
  }

  return {
    uploadRelPath: toStagingRelativePath(filePath),
    sizeBytes: counter.size(),
  }
}

/**
 * Chunked upload session. A restore archive sent as one request has to
 * arrive within the proxies' request-read timeout on every hop (Traefik's
 * default is 60s for the whole request, body included), which a real archive
 * on an ordinary uplink cannot do. Sent as a session of short appends it
 * can: start, append chunks at increasing offsets, complete. Until completion
 * the file carries a .part suffix so a restore can never pick up a
 * half-received archive; the sweeper reaps abandoned sessions like any other
 * upload.
 */
const PART_SUFFIX = ".tar.gz.part"

export async function startRestoreUpload({
  spotId,
}: {
  spotId: string
}): Promise<{ uploadRelPath: string }> {
  const safeId = assertSafeName(spotId, "spot id")
  const dir = uploadsDir()

  await fs.mkdir(dir, { recursive: true })

  const filePath = path.join(dir, `${safeId}-${randomUUID()}${PART_SUFFIX}`)
  await fs.writeFile(filePath, "", { flag: "wx" })

  return { uploadRelPath: toStagingRelativePath(filePath) }
}

/**
 * Resolve a session's .part file, refusing anything outside uploads/, a
 * completed archive, or another spot's session.
 */
function resolvePartialUploadPath(
  spotId: string,
  uploadRelPath: string,
): string {
  const safeId = assertSafeName(spotId, "spot id")
  const resolved = resolveStagingRelativePath(uploadRelPath)
  const base = path.basename(resolved)

  if (
    path.dirname(resolved) !== uploadsDir() ||
    !base.startsWith(`${safeId}-`) ||
    !base.endsWith(PART_SUFFIX)
  ) {
    throw new Error("Invalid upload path")
  }

  return resolved
}

export async function appendRestoreUploadChunk({
  spotId,
  uploadRelPath,
  offset,
  body,
}: {
  spotId: string
  uploadRelPath: string
  offset: number
  body: Readable
}): Promise<{ sizeBytes: number }> {
  const filePath = resolvePartialUploadPath(spotId, uploadRelPath)
  const stat = await fs.stat(filePath).catch(() => null)

  if (!stat?.isFile()) {
    throw new UploadNotFoundError()
  }

  if (stat.size !== offset) {
    throw new UploadOffsetMismatchError(stat.size)
  }

  const counter = limitedCounter(stat.size)

  try {
    await pipeline(
      body,
      counter.stream,
      createWriteStream(filePath, { flags: "a" }),
    )
  } catch (error) {
    // Drop whatever this chunk managed to append, so a retry from the
    // acknowledged offset finds the file exactly as it was.
    await fs.truncate(filePath, stat.size).catch(() => undefined)
    throw error
  }

  return { sizeBytes: counter.size() }
}

export async function completeRestoreUpload({
  spotId,
  uploadRelPath,
}: {
  spotId: string
  uploadRelPath: string
}): Promise<{ uploadRelPath: string; sizeBytes: number }> {
  const partPath = resolvePartialUploadPath(spotId, uploadRelPath)
  const stat = await fs.stat(partPath).catch(() => null)

  if (!stat?.isFile()) {
    throw new UploadNotFoundError()
  }

  if (stat.size === 0) {
    await fs.rm(partPath, { force: true }).catch(() => undefined)
    throw new EmptyUploadError()
  }

  const finalPath = `${partPath.slice(0, -PART_SUFFIX.length)}.tar.gz`
  await fs.rename(partPath, finalPath)

  return {
    uploadRelPath: toStagingRelativePath(finalPath),
    sizeBytes: stat.size,
  }
}
