import jwt from 'jsonwebtoken';
import {config} from '../config.js';

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

function extractJwtToken(authorization: string | undefined, queryToken: unknown): string | null {
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice(7);
  }
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }
  return null;
}

export function verifyPipeToken(
  authorization: string | undefined,
  queryToken: unknown,
  pipeName: string
): {
  ok: boolean;
  siteUuid?: string;
  error?: string;
} {
  const token = extractJwtToken(authorization, queryToken);
  if (!token) {
    return {ok: false, error: 'Missing Bearer token'};
  }

  try {
    const decoded = jwt.verify(token, config.tinybirdAdminToken) as jwt.JwtPayload;

    if (decoded.workspace_id !== config.tinybirdWorkspaceId) {
      return {ok: false, error: 'Invalid workspace'};
    }

    const scopes = decoded.scopes as Array<{
      type: string;
      resource: string;
      fixed_params?: {site_uuid?: string};
    }> | undefined;

    const allowed = scopes?.some(
      (s) => s.type === 'PIPES:READ' && s.resource === pipeName
    );

    if (!allowed) {
      return {ok: false, error: 'Pipe not in token scope'};
    }

    const siteUuid = scopes?.find((s) => s.resource === pipeName)?.fixed_params?.site_uuid;
    if (!siteUuid) {
      return {ok: false, error: 'Missing site_uuid in token'};
    }

    return {ok: true, siteUuid};
  } catch {
    return {ok: false, error: 'Invalid token'};
  }
}
