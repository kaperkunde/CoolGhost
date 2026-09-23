import type { DuplicatiFileset } from "./duplicati.js"
import { findSiteDataVersions } from "./duplicati-staging.js"

/**
 * Narrow a server-wide list of backup versions to the ones that hold one
 * site's data. Every site on the server shares the same Duplicati jobs, so
 * without this a site's Backups tab offers versions taken before it was
 * deployed (or after it was removed), and picking one fails the export or
 * restore only once it starts.
 */

export type SiteTarget = { applicationUuid: string; database: string }

/**
 * A job whose versions could not be checked comes back like one whose
 * versions could not be listed: no versions and a versionsError. Listing them
 * unchecked would offer exactly the restore points this exists to hide.
 */
export async function filterVersionsForSite<
  B extends { id: string; versions: DuplicatiFileset[] },
>(
  backups: B[],
  site: SiteTarget,
): Promise<Array<B & { versionsError?: string | null }>> {
  return Promise.all(
    backups.map(async (backup) => {
      if (backup.versions.length === 0) {
        return backup
      }

      try {
        const inVersions = await findSiteDataVersions({
          backupId: backup.id,
          ...site,
          versions: backup.versions,
        })

        // A version missing from the answer was pruned while being checked.
        return {
          ...backup,
          versions: backup.versions.filter((version) => {
            const inVersion = inVersions.get(version.time)

            return Boolean(inVersion?.hasContent && inVersion.dumpBackupPath)
          }),
        }
      } catch (error) {
        console.error("Could not check backup versions for site data", {
          backupId: backup.id,
          applicationUuid: site.applicationUuid,
          error,
        })

        return {
          ...backup,
          versions: [],
          versionsError: "Could not check which restore points hold this site.",
        }
      }
    }),
  )
}
