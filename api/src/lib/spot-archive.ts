import { execFile } from "child_process"
import { createReadStream, createWriteStream } from "fs"
import { promises as fs } from "fs"
import path from "path"
import { pipeline } from "stream/promises"
import { promisify } from "util"
import { createGunzip } from "zlib"

import * as tar from "tar"

import { config } from "../config.js"

const execFileAsync = promisify(execFile)

export const SPOT_ARCHIVE_FORMAT_VERSION = 1

/** Contents of info.json inside an export archive. */
export type SpotArchiveInfo = {
  formatVersion: number
  spotId: string
  database: string
  siteTitle: string | null
  mysqlVersion: string | null
  ghostMigrationVersion: string | null
  createdAt: string
  source:
    | { type: "current" }
    | { type: "backup"; backupName: string; versionTime: string }
    | { type: "pre-restore-snapshot" }
}

/**
 * Package info.json + db.sql (in workDir) and a Ghost content directory into
 * a gzipped tarball with the layout: info.json, db.sql, content/…
 * Uses GNU tar so the content dir can be renamed without copying it first.
 */
export async function packageSpotArchive({
  workDir,
  contentDir,
  artifactPath,
}: {
  workDir: string
  contentDir: string
  artifactPath: string
}): Promise<void> {
  const contentParent = path.dirname(contentDir)
  const contentBase = path.basename(contentDir)

  if (!/^[A-Za-z0-9._-]+$/.test(contentBase)) {
    throw new Error(`Unexpected content directory name: ${contentBase}`)
  }

  const escapedBase = contentBase.replace(/\./g, "\\.")

  await execFileAsync(
    "tar",
    [
      "-czf",
      artifactPath,
      "--transform",
      `s,^${escapedBase}$,content,`,
      "--transform",
      `s,^${escapedBase}/,content/,`,
      "-C",
      workDir,
      "info.json",
      "db.sql",
      "-C",
      contentParent,
      contentBase,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  )
}

/**
 * Extract an uploaded/exported archive. node-tar refuses absolute paths and
 * ".." members by default, so a hostile archive cannot escape destDir.
 */
export async function extractSpotArchive({
  archivePath,
  destDir,
}: {
  archivePath: string
  destDir: string
}): Promise<void> {
  await fs.mkdir(destDir, { recursive: true })
  await tar.extract({ file: archivePath, cwd: destDir })
}

export async function gunzipFile({
  sourcePath,
  destPath,
}: {
  sourcePath: string
  destPath: string
}): Promise<void> {
  await pipeline(
    createReadStream(sourcePath),
    createGunzip(),
    createWriteStream(destPath),
  )
}

export async function readArchiveInfo(
  extractDir: string,
): Promise<SpotArchiveInfo | null> {
  try {
    const raw = await fs.readFile(path.join(extractDir, "info.json"), "utf8")
    return JSON.parse(raw) as SpotArchiveInfo
  } catch {
    return null
  }
}

export type StagedRestore = {
  /** Directory whose contents become the Ghost content volume. */
  contentDir: string
  /** Plain SQL dump to import. */
  dbSqlPath: string
  /** info.json when the source was an export archive. */
  info: SpotArchiveInfo | null
}

export class RestoreValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RestoreValidationError"
  }
}

/** Sanity-check staged restore data; returns non-fatal warnings. */
export async function validateStagedRestore({
  staged,
  expectedSpotId,
  expectedDatabase,
}: {
  staged: StagedRestore
  expectedSpotId: string
  expectedDatabase: string
}): Promise<string[]> {
  const warnings: string[] = []

  const contentStat = await fs.stat(staged.contentDir).catch(() => null)

  if (!contentStat?.isDirectory()) {
    throw new RestoreValidationError(
      "The backup does not contain a Ghost content folder.",
    )
  }

  const contentEntries = await fs.readdir(staged.contentDir)

  if (contentEntries.length === 0) {
    warnings.push("The Ghost content folder in this backup is empty.")
  }

  const sqlStat = await fs.stat(staged.dbSqlPath).catch(() => null)

  if (!sqlStat?.isFile() || sqlStat.size === 0) {
    throw new RestoreValidationError(
      "The backup does not contain a database dump.",
    )
  }

  const head = Buffer.alloc(512)
  const file = await fs.open(staged.dbSqlPath, "r")

  try {
    await file.read(head, 0, head.length, 0)
  } finally {
    await file.close()
  }

  const headText = head.toString("utf8")

  if (!/--|\/\*|CREATE|INSERT|DROP/i.test(headText)) {
    warnings.push("The database dump does not look like a MySQL dump file.")
  }

  if (staged.info) {
    if (
      staged.info.spotId &&
      staged.info.spotId.toLowerCase() !== expectedSpotId.toLowerCase()
    ) {
      warnings.push(
        `This archive was exported from ${staged.info.spotId}, not ${expectedSpotId}.`,
      )
    }

    if (
      staged.info.formatVersion &&
      staged.info.formatVersion > SPOT_ARCHIVE_FORMAT_VERSION
    ) {
      warnings.push(
        "This archive was created by a newer export format and may not restore cleanly.",
      )
    }

    if (staged.info.database && staged.info.database !== expectedDatabase) {
      warnings.push(
        `The archive's database name (${staged.info.database}) differs from this plekje's (${expectedDatabase}).`,
      )
    }
  }

  return warnings
}

/**
 * Replace the contents of a Ghost content volume with the staged content.
 * The volume directory itself stays in place (it is a bind/volume mount);
 * ownership is normalized to the uid/gid the Ghost container runs as.
 */
export async function replaceVolumeContents({
  volumeDataDir,
  sourceContentDir,
}: {
  volumeDataDir: string
  sourceContentDir: string
}): Promise<void> {
  const volumeStat = await fs.stat(volumeDataDir).catch(() => null)

  if (!volumeStat?.isDirectory()) {
    throw new Error(
      `Ghost content volume not found at ${volumeDataDir} — is the volume mounted into this container?`,
    )
  }

  for (const entry of await fs.readdir(volumeDataDir)) {
    await fs.rm(path.join(volumeDataDir, entry), {
      recursive: true,
      force: true,
    })
  }

  await execFileAsync("cp", ["-a", `${sourceContentDir}/.`, volumeDataDir])

  await execFileAsync("chown", [
    "-R",
    `${config.ghostContentUid}:${config.ghostContentGid}`,
    volumeDataDir,
  ])
}
