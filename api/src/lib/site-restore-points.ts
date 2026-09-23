import { locateSiteDataInVersion } from "./duplicati-staging.js"

/**
 * Narrow a server-wide list of backup versions to the ones that hold one
 * site's data. Every site on the server shares the same Duplicati jobs, so
 * without this a site's Backups tab offers versions taken before it was
 * deployed (or after it moved to a new content volume), and picking one fails
 * the export or restore only once it starts.
 *
 * Each version costs Duplicati one or two lookups, so the answers are cached:
 * a version's contents never change, and after the first listing only new
 * versions are checked. The checks are also rate-limited and time-boxed —
 * a version whose check fails or has not finished is kept, since "could not
 * tell" must not hide a good restore point, and staging still checks it.
 */

/** Lookups in flight at once, across all requests: Duplicati is shared. */
const MAX_CONCURRENT_CHECKS = 3

/** Answers kept; well above versions × sites on one server. */
const MAX_CACHED_ANSWERS = 20_000

type Answer = boolean | null

const answers = new Map<string, Promise<Answer>>()

let running = 0
const waiting: Array<() => void> = []

async function withCheckSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_CHECKS) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else {
    running++
  }

  try {
    return await work()
  } finally {
    const next = waiting.shift()

    if (next) {
      next()
    } else {
      running--
    }
  }
}

export type SiteTarget = { applicationUuid: string; database: string }

/** True/false once known; null when the check failed (not cached). */
function versionHasSiteData(
  backupId: string,
  versionTime: string,
  site: SiteTarget,
): Promise<Answer> {
  const key = [backupId, versionTime, site.applicationUuid, site.database].join(
    "\n",
  )
  const cached = answers.get(key)

  if (cached) {
    return cached
  }

  const answer = withCheckSlot(() =>
    locateSiteDataInVersion({
      backupId,
      versionTime,
      applicationUuid: site.applicationUuid,
      database: site.database,
    }),
  ).then(
    (located) => located.found,
    (error: unknown) => {
      answers.delete(key)
      console.error("Could not check a backup version for site data", {
        backupId,
        versionTime,
        applicationUuid: site.applicationUuid,
        error,
      })

      return null
    },
  )

  answers.set(key, answer)

  if (answers.size > MAX_CACHED_ANSWERS) {
    const oldest = answers.keys().next().value

    if (oldest !== undefined) {
      answers.delete(oldest)
    }
  }

  return answer
}

/**
 * The versions of each job that hold the site's data. Checks still running at
 * `deadline` keep their version in the answer and carry on in the background,
 * so the next listing has them.
 */
export async function filterVersionsForSite<
  B extends { id: string; versions: Array<{ time: string }> },
>(backups: B[], site: SiteTarget, deadline: number): Promise<B[]> {
  const checks = backups.map((backup) =>
    backup.versions.map((version) =>
      versionHasSiteData(backup.id, version.time, site),
    ),
  )

  const settled = new Map<Promise<Answer>, Answer>()
  const all = Promise.all(
    checks.flat().map((check) =>
      check.then((answer) => {
        settled.set(check, answer)
      }),
    ),
  )

  let timer: NodeJS.Timeout | undefined

  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
    }),
  ])

  clearTimeout(timer)

  return backups.map((backup, i) => ({
    ...backup,
    versions: backup.versions.filter(
      (_version, j) => settled.get(checks[i]![j]!) !== false,
    ),
  }))
}
