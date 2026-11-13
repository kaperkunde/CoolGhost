/** The fixed values Ghost's docs use for a local Tinybird; accepted only behind STATS_ALLOW_LEGACY_DUMMY_TOKEN. */
export const LEGACY_ADMIN_TOKEN = 'DUMMY_TOKEN';
export const LEGACY_WORKSPACE_ID = 'DUMMY_WORKSPACE_ID';

/** The shortest signing secret, ingest token or master key accepted. */
export const MIN_SECRET_LENGTH = 32;

export type Config = {
  port: number;
  host: string;
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUser: string;
  clickhousePassword: string;
  eventsDatasource: string;
  /** Single-site mode: the secret Ghost signs stats tokens with (`tinybird__adminToken`). */
  adminToken: string | null;
  /** The workspace those tokens name (`tinybird__workspaceId`). */
  workspaceId: string;
  /** Multi-site mode: each workspace's secret is derived from this (see lib/keys.ts). */
  masterKey: string | null;
  /** Also accept tokens signed with DUMMY_TOKEN for DUMMY_WORKSPACE_ID, while sites move to their own secret. */
  allowLegacyToken: boolean;
  /** Multi-site mode: where to look up the site_uuid a workspace may read (optional). */
  siteLookupUrl: string | null;
  siteLookupToken: string | null;
  /** Bearer token traffic-analytics sends to POST /v0/events (its TINYBIRD_TRACKER_TOKEN). */
  ingestToken: string;
};

export class ConfigError extends Error {}

function read(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function secret(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = read(env, name);
  if (value === null) {
    return null;
  }
  if (value === LEGACY_ADMIN_TOKEN) {
    return LEGACY_ADMIN_TOKEN;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`${name} must be at least ${MIN_SECRET_LENGTH} characters long.`);
  }
  return value;
}

/**
 * Reads and checks the environment. Throws a ConfigError naming what is
 * missing or wrong, so the service refuses to start rather than serving stats
 * to anyone who knows a placeholder.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const allowLegacyToken = read(env, 'STATS_ALLOW_LEGACY_DUMMY_TOKEN') === 'true';

  let adminToken = secret(env, 'TINYBIRD_ADMIN_TOKEN');
  if (adminToken === LEGACY_ADMIN_TOKEN) {
    if (!allowLegacyToken) {
      throw new ConfigError(
        'TINYBIRD_ADMIN_TOKEN is the placeholder DUMMY_TOKEN. Set a secret of your own (the same value as Ghost\'s tinybird__adminToken).'
      );
    }
    // Accepted through allowLegacyToken below, not as a secret of this site.
    adminToken = null;
  }

  const masterKey = secret(env, 'STATS_MASTER_KEY');
  if (masterKey === LEGACY_ADMIN_TOKEN) {
    throw new ConfigError('STATS_MASTER_KEY must not be DUMMY_TOKEN.');
  }

  if (!adminToken && !masterKey && !allowLegacyToken) {
    throw new ConfigError(
      'Set TINYBIRD_ADMIN_TOKEN (the same value as Ghost\'s tinybird__adminToken) or STATS_MASTER_KEY.'
    );
  }

  const ingestToken = secret(env, 'TRAFFIC_STATS_INGEST_TOKEN');
  if (!ingestToken || ingestToken === LEGACY_ADMIN_TOKEN) {
    throw new ConfigError(
      'Set TRAFFIC_STATS_INGEST_TOKEN (the same value as traffic-analytics\' TINYBIRD_TRACKER_TOKEN).'
    );
  }

  const siteLookupUrl = read(env, 'STATS_SITE_LOOKUP_URL');
  const siteLookupToken = read(env, 'STATS_SITE_LOOKUP_TOKEN');
  if (siteLookupUrl) {
    if (!masterKey) {
      throw new ConfigError('STATS_SITE_LOOKUP_URL only applies with STATS_MASTER_KEY.');
    }
    if (!/^https?:\/\//.test(siteLookupUrl)) {
      throw new ConfigError('STATS_SITE_LOOKUP_URL must be an http(s) URL.');
    }
  }

  return {
    port: Number(env.PORT ?? 3000),
    host: env.LISTEN_HOST ?? '0.0.0.0',
    clickhouseUrl: env.CLICKHOUSE_URL ?? 'http://clickhouse:8123',
    clickhouseDatabase: env.CLICKHOUSE_DATABASE ?? 'ghost_analytics',
    clickhouseUser: env.CLICKHOUSE_USER || 'default',
    clickhousePassword: env.CLICKHOUSE_PASSWORD ?? '',
    eventsDatasource: env.TINYBIRD_EVENTS_DATASOURCE ?? 'analytics_events',
    adminToken,
    workspaceId: read(env, 'TINYBIRD_WORKSPACE_ID') ?? LEGACY_WORKSPACE_ID,
    masterKey,
    allowLegacyToken,
    siteLookupUrl: siteLookupUrl ? siteLookupUrl.replace(/\/+$/, '') : null,
    siteLookupToken,
    ingestToken
  };
}
