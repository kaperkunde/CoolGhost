import jwt from 'jsonwebtoken';
import {LEGACY_ADMIN_TOKEN, LEGACY_WORKSPACE_ID, type Config} from '../config.js';
import {DERIVED_WORKSPACE_PATTERN, deriveSiteKey} from './keys.js';
import type {SiteLookup} from './site-lookup.js';

/** Pipe names Ghost may request (from tinybird-service.js). */
export const GHOST_PIPE_NAMES = [
  'api_kpis',
  'api_active_visitors',
  'api_post_visitor_counts',
  'api_top_locations',
  'api_top_pages',
  'api_top_sources',
  'api_top_utm_sources',
  'api_top_utm_mediums',
  'api_top_utm_campaigns',
  'api_top_utm_contents',
  'api_top_utm_terms',
  'api_top_devices',
  'api_kpis_v2',
  'api_active_visitors_v2',
  'api_post_visitor_counts_v2',
  'api_top_locations_v2',
  'api_top_pages_v2',
  'api_top_sources_v2',
  'api_top_utm_sources_v2',
  'api_top_utm_mediums_v2',
  'api_top_utm_campaigns_v2',
  'api_top_utm_contents_v2',
  'api_top_utm_terms_v2',
  'api_top_devices_v2'
] as const;

export type GhostPipeName = (typeof GHOST_PIPE_NAMES)[number];

/** Ghost asks for tokens that last three hours; anything much longer is not one of its own. */
export const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

export type PipeTokenCheck =
  | {ok: true; siteUuid: string}
  | {ok: false; status: 403 | 503; error: string};

export type PipeTokenVerifier = (
  authorization: string | undefined,
  queryToken: unknown,
  pipeName: string
) => Promise<PipeTokenCheck>;

type KeyMode = 'site' | 'derived' | 'legacy';

type Scope = {
  type?: unknown;
  resource?: unknown;
  fixed_params?: {site_uuid?: unknown};
};

function extractJwtToken(authorization: string | undefined, queryToken: unknown): string | null {
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice(7).trim() || null;
  }
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }
  return null;
}

function refuse(error: string, status: 403 | 503 = 403): PipeTokenCheck {
  return {ok: false, status, error};
}

/** The secrets a token naming this workspace may be signed with, in the order tried. */
function candidateKeys(
  config: Pick<Config, 'adminToken' | 'workspaceId' | 'masterKey' | 'allowLegacyToken'>,
  workspaceId: string
): Array<{key: string; mode: KeyMode}> {
  const keys: Array<{key: string; mode: KeyMode}> = [];
  if (config.adminToken && workspaceId === config.workspaceId) {
    keys.push({key: config.adminToken, mode: 'site'});
  }
  if (config.masterKey && DERIVED_WORKSPACE_PATTERN.test(workspaceId)) {
    keys.push({key: deriveSiteKey(config.masterKey, workspaceId), mode: 'derived'});
  }
  if (config.allowLegacyToken && workspaceId === LEGACY_WORKSPACE_ID) {
    keys.push({key: LEGACY_ADMIN_TOKEN, mode: 'legacy'});
  }
  return keys;
}

/**
 * Checks the stats token Ghost signs (tinybird-service.js: HS256 over
 * `{workspace_id, name, exp, scopes: [{type: 'PIPES:READ', resource, fixed_params: {site_uuid}}]}`)
 * and answers the one site it may read.
 */
export function createPipeTokenVerifier({
  config,
  lookupSite = null,
  now = Date.now
}: {
  config: Pick<Config, 'adminToken' | 'workspaceId' | 'masterKey' | 'allowLegacyToken'>;
  lookupSite?: SiteLookup | null;
  now?: () => number;
}): PipeTokenVerifier {
  return async (authorization, queryToken, pipeName) => {
    const token = extractJwtToken(authorization, queryToken);
    if (!token) {
      return refuse('Missing Bearer token');
    }

    const decoded = jwt.decode(token, {complete: true});
    if (!decoded || typeof decoded.payload !== 'object' || decoded.header.alg !== 'HS256') {
      return refuse('Invalid token');
    }
    const workspaceId = (decoded.payload as jwt.JwtPayload).workspace_id;
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return refuse('Invalid token');
    }

    const nowSeconds = Math.floor(now() / 1000);
    let payload: jwt.JwtPayload | null = null;
    let mode: KeyMode | null = null;
    for (const candidate of candidateKeys(config, workspaceId)) {
      try {
        const verified = jwt.verify(token, candidate.key, {
          algorithms: ['HS256'],
          clockTimestamp: nowSeconds
        });
        if (typeof verified === 'object') {
          payload = verified;
          mode = candidate.mode;
          break;
        }
      } catch {
        // Try the next secret this workspace may use.
      }
    }
    if (!payload || !mode) {
      return refuse('Invalid token');
    }

    if (typeof payload.exp !== 'number') {
      return refuse('Token has no expiry');
    }
    if (payload.exp > nowSeconds + MAX_TOKEN_LIFETIME_SECONDS) {
      return refuse('Token lasts too long');
    }

    const scopes: Scope[] = Array.isArray(payload.scopes) ? payload.scopes : [];
    const allowed = scopes.some((s) => s.type === 'PIPES:READ' && s.resource === pipeName);
    if (!allowed) {
      return refuse('Pipe not in token scope');
    }

    const siteUuids = new Set(scopes.map((s) => s.fixed_params?.site_uuid));
    const [siteUuid] = siteUuids;
    if (siteUuids.size !== 1 || typeof siteUuid !== 'string' || !siteUuid) {
      return refuse('Token must name one site_uuid in every scope');
    }

    if (mode === 'derived' && lookupSite) {
      const site = await lookupSite(workspaceId);
      if (!site.ok) {
        return site.reason === 'not_found'
          ? refuse('Unknown workspace')
          : refuse('Site lookup unavailable', 503);
      }
      if (site.siteUuid !== siteUuid) {
        return refuse('Token not valid for this site');
      }
    }

    return {ok: true, siteUuid};
  };
}
