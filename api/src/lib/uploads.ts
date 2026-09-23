import { randomUUID } from "crypto"
import { constants as fsConstants, createWriteStream, promises as fs } from "fs"
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

/** A ranged session was completed before every byte of the archive arrived. */
export class UploadIncompleteError extends Error {
  readonly missingBytes: number

  constructor(missingBytes: number) {
    super("Parts of the file never arrived. Start the upload again.")
    this.name = "UploadIncompleteError"
    this.missingBytes = missingBytes
  }
}

/**
 * The staging disk cannot hold the archive plus its unpacked copy, which is
 * what the restore needs next. Refused at the start, not after hours of
 * uploading.
 */
export class InsufficientStorageError extends Error {
  constructor(requiredBytes: number) {
    super(
      `This plekje's server does not have enough free disk space for a restore this size (it needs about ${formatLimit(requiredBytes)}).`,
    )
    this.name = "InsufficientStorageError"
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
 * on an ordinary uplink cannot do. Sent as a session of short chunks it can:
 * start, write chunks, complete. Until completion the file carries a .part
 * suffix so a restore can never pick up a half-received archive; the sweeper
 * reaps abandoned sessions like any other upload.
 *
 * A session started with the archive's size is ranged: the .part file is
 * created at full size (sparse) and chunks may land at any offset, in any
 * order and several at once, so one slow chunk never holds up the rest and
 * each chunk's hop from the app to this api overlaps the next one's upload
 * from the browser. Every chunk that arrives in full is recorded as a line in
 * a sidecar .ranges file; a chunk cut off midway is not, and its retry
 * rewrites the same bytes. Completion checks the recorded ranges cover the
 * whole archive.
 *
 * A session started without a size appends chunks strictly in order — the
 * protocol of apps released before ranged sessions.
 */
const PART_SUFFIX = ".tar.gz.part"
const RANGES_SUFFIX = ".ranges"

/**
 * Free space asked of the staging disk per archive byte: the archive itself,
 * plus the copy the restore unpacks next to it.
 */
const RESTORE_SPACE_FACTOR = 2

async function assertRoomForRestore(dir: string, sizeBytes: number) {
  const requiredBytes = sizeBytes * RESTORE_SPACE_FACTOR
  const stats = await fs.statfs(dir)

  if (stats.bavail * stats.bsize < requiredBytes) {
    throw new InsufficientStorageError(requiredBytes)
  }
}

export async function startRestoreUpload({
  spotId,
  sizeBytes,
}: {
  spotId: string
  /** The archive's full size; makes the session ranged. */
  sizeBytes?: number
}): Promise<{ uploadRelPath: string; ranged: boolean }> {
  const safeId = assertSafeName(spotId, "spot id")
  const dir = uploadsDir()

  if (sizeBytes !== undefined) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error("Invalid upload size")
    }

    if (sizeBytes === 0) {
      throw new EmptyUploadError()
    }

    if (sizeBytes > config.maxUploadBytes) {
      throw new UploadTooLargeError()
    }
  }

  await fs.mkdir(dir, { recursive: true })

  if (sizeBytes !== undefined) {
    await assertRoomForRestore(dir, sizeBytes)
  }

  const filePath = path.join(dir, `${safeId}-${randomUUID()}${PART_SUFFIX}`)
  await fs.writeFile(filePath, "", { flag: "wx" })

  if (sizeBytes === undefined) {
    return { uploadRelPath: toStagingRelativePath(filePath), ranged: false }
  }

  try {
    await fs.truncate(filePath, sizeBytes)
    await fs.writeFile(`${filePath}${RANGES_SUFFIX}`, "", { flag: "wx" })
  } catch (error) {
    await fs.rm(filePath, { force: true }).catch(() => undefined)
    throw error
  }

  return { uploadRelPath: toStagingRelativePath(filePath), ranged: true }
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

function isMissingFileError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT"
}

/** Counts a chunk's bytes and fails the stream past its declared length. */
function chunkCounter(lengthBytes: number) {
  let received = 0

  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength

      if (received > lengthBytes) {
        callback(new Error("Invalid chunk: longer than its declared length"))
        return
      }

      callback(null, chunk)
    },
  })

  return { stream, received: () => received }
}

/**
 * Write one chunk of a ranged session at `offset`. The range is recorded only
 * once every declared byte is on disk, so a chunk cut off midway leaves no
 * claim that its bytes arrived.
 */
async function writeRangedChunk({
  partPath,
  totalBytes,
  offset,
  lengthBytes,
  body,
}: {
  partPath: string
  totalBytes: number
  offset: number
  lengthBytes: number | undefined
  body: Readable
}): Promise<{ receivedBytes: number }> {
  if (
    lengthBytes === undefined ||
    !Number.isSafeInteger(lengthBytes) ||
    lengthBytes <= 0 ||
    offset + lengthBytes > totalBytes
  ) {
    throw new Error("Invalid chunk range")
  }

  const counter = chunkCounter(lengthBytes)

  try {
    await pipeline(
      body,
      counter.stream,
      createWriteStream(partPath, { flags: "r+", start: offset }),
    )
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new UploadNotFoundError()
    }

    throw error
  }

  if (counter.received() !== lengthBytes) {
    throw new Error("Invalid chunk: shorter than its declared length")
  }

  // Append without creating: a session completed or swept meanwhile must
  // not get a fresh, stray ranges file.
  let ranges: fs.FileHandle

  try {
    ranges = await fs.open(
      `${partPath}${RANGES_SUFFIX}`,
      fsConstants.O_WRONLY | fsConstants.O_APPEND,
    )
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new UploadNotFoundError()
    }

    throw error
  }

  try {
    await ranges.write(`${offset} ${lengthBytes}\n`)
  } finally {
    await ranges.close()
  }

  return { receivedBytes: lengthBytes }
}

/** Bytes of [0, totalBytes) that no recorded range covers. */
function missingBytes(rangesText: string, totalBytes: number): number {
  const ranges = rangesText
    .split("\n")
    .map((line) => line.trim().split(" ").map(Number))
    .filter(
      ([start, length]) =>
        Number.isSafeInteger(start) && Number.isSafeInteger(length),
    )
    .map(([start, length]) => [start!, start! + length!] as const)
    .sort((a, b) => a[0] - b[0])

  let covered = 0
  let missing = 0

  for (const [start, end] of ranges) {
    if (start > covered) {
      missing += start - covered
    }

    covered = Math.max(covered, end)
  }

  return missing + Math.max(0, totalBytes - covered)
}

/**
 * Write one chunk. Ranged sessions take it at any offset inside the archive
 * (`lengthBytes` is required there) and answer the bytes received; in-order
 * sessions append it at the end of the file and answer the new size, or
 * refuse an offset that is not the end with the real size.
 */
export async function appendRestoreUploadChunk({
  spotId,
  uploadRelPath,
  offset,
  lengthBytes,
  body,
}: {
  spotId: string
  uploadRelPath: string
  offset: number
  lengthBytes?: number
  body: Readable
}): Promise<{ sizeBytes: number } | { receivedBytes: number }> {
  const filePath = resolvePartialUploadPath(spotId, uploadRelPath)
  const stat = await fs.stat(filePath).catch(() => null)

  if (!stat?.isFile()) {
    throw new UploadNotFoundError()
  }

  if (await isRangedSession(filePath)) {
    return writeRangedChunk({
      partPath: filePath,
      totalBytes: stat.size,
      offset,
      lengthBytes,
      body,
    })
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

async function isRangedSession(partPath: string): Promise<boolean> {
  return fs
    .stat(`${partPath}${RANGES_SUFFIX}`)
    .then((stat) => stat.isFile())
    .catch(() => false)
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

  const rangesPath = `${partPath}${RANGES_SUFFIX}`
  const ranged = await isRangedSession(partPath)

  if (ranged) {
    const missing = missingBytes(
      await fs.readFile(rangesPath, "utf8"),
      stat.size,
    )

    if (missing > 0) {
      throw new UploadIncompleteError(missing)
    }
  }

  const finalPath = `${partPath.slice(0, -PART_SUFFIX.length)}.tar.gz`
  await fs.rename(partPath, finalPath)

  if (ranged) {
    await fs.rm(rangesPath, { force: true }).catch(() => undefined)
  }

  return {
    uploadRelPath: toStagingRelativePath(finalPath),
    sizeBytes: stat.size,
  }
}
