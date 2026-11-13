/**
 * Which site_uuid a workspace may read, asked of a lookup service:
 * `GET <url>/<workspace>` with `Authorization: Bearer <token>` answers
 * `{"siteUuid": "…"}`, or 404 when the workspace has no site.
 */
export type SiteLookup = (workspaceId: string) => Promise<SiteLookupResult>;

export type SiteLookupResult =
  | {ok: true; siteUuid: string}
  | {ok: false; reason: 'not_found' | 'unavailable'};

const FOUND_TTL_MS = 60_000;
const NOT_FOUND_TTL_MS = 15_000;
const TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 10_000;

export function createSiteLookup({
  url,
  token,
  fetchImpl = fetch,
  now = Date.now
}: {
  url: string;
  token: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): SiteLookup {
  const cache = new Map<string, {result: SiteLookupResult; until: number}>();

  return async (workspaceId) => {
    const cached = cache.get(workspaceId);
    if (cached && cached.until > now()) {
      return cached.result;
    }

    let result: SiteLookupResult;
    try {
      const response = await fetchImpl(`${url}/${encodeURIComponent(workspaceId)}`, {
        headers: token ? {authorization: `Bearer ${token}`} : {},
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (response.status === 404) {
        result = {ok: false, reason: 'not_found'};
      } else if (!response.ok) {
        return {ok: false, reason: 'unavailable'};
      } else {
        const body = (await response.json()) as {siteUuid?: unknown};
        if (typeof body.siteUuid !== 'string' || !body.siteUuid) {
          return {ok: false, reason: 'unavailable'};
        }
        result = {ok: true, siteUuid: body.siteUuid};
      }
    } catch {
      return {ok: false, reason: 'unavailable'};
    }

    if (cache.size >= MAX_ENTRIES) {
      cache.clear();
    }
    cache.set(workspaceId, {
      result,
      until: now() + (result.ok ? FOUND_TTL_MS : NOT_FOUND_TTL_MS)
    });
    return result;
  };
}
