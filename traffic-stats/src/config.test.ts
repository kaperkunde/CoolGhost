import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {ConfigError, loadConfig} from './config.js';

const SECRET = 'a'.repeat(40);
const INGEST = 'i'.repeat(40);

describe('loadConfig', () => {
  it('takes a site secret and an ingest token', () => {
    const config = loadConfig({TINYBIRD_ADMIN_TOKEN: SECRET, TRAFFIC_STATS_INGEST_TOKEN: INGEST});
    assert.equal(config.adminToken, SECRET);
    assert.equal(config.workspaceId, 'DUMMY_WORKSPACE_ID');
    assert.equal(config.ingestToken, INGEST);
    assert.equal(config.allowLegacyToken, false);
  });

  it('refuses to start without a signing secret', () => {
    assert.throws(() => loadConfig({TRAFFIC_STATS_INGEST_TOKEN: INGEST}), ConfigError);
  });

  it('refuses DUMMY_TOKEN unless the legacy flag is on', () => {
    assert.throws(
      () => loadConfig({TINYBIRD_ADMIN_TOKEN: 'DUMMY_TOKEN', TRAFFIC_STATS_INGEST_TOKEN: INGEST}),
      /placeholder/
    );
    const config = loadConfig({
      TINYBIRD_ADMIN_TOKEN: 'DUMMY_TOKEN',
      TRAFFIC_STATS_INGEST_TOKEN: INGEST,
      STATS_ALLOW_LEGACY_DUMMY_TOKEN: 'true'
    });
    assert.equal(config.adminToken, null);
    assert.equal(config.allowLegacyToken, true);
  });

  it('starts on the legacy flag alone', () => {
    const config = loadConfig({TRAFFIC_STATS_INGEST_TOKEN: INGEST, STATS_ALLOW_LEGACY_DUMMY_TOKEN: 'true'});
    assert.equal(config.adminToken, null);
    assert.equal(config.masterKey, null);
  });

  it('refuses short secrets', () => {
    assert.throws(
      () => loadConfig({TINYBIRD_ADMIN_TOKEN: 'short', TRAFFIC_STATS_INGEST_TOKEN: INGEST}),
      /at least 32/
    );
    assert.throws(
      () => loadConfig({STATS_MASTER_KEY: 'short', TRAFFIC_STATS_INGEST_TOKEN: INGEST}),
      /at least 32/
    );
    assert.throws(() => loadConfig({TINYBIRD_ADMIN_TOKEN: SECRET, TRAFFIC_STATS_INGEST_TOKEN: 'short'}), /at least 32/);
  });

  it('refuses to start without an ingest token', () => {
    assert.throws(() => loadConfig({TINYBIRD_ADMIN_TOKEN: SECRET}), /TRAFFIC_STATS_INGEST_TOKEN/);
  });

  it('takes a master key and a site lookup', () => {
    const config = loadConfig({
      STATS_MASTER_KEY: SECRET,
      TRAFFIC_STATS_INGEST_TOKEN: INGEST,
      STATS_SITE_LOOKUP_URL: 'http://api:3000/v1/analytics/sites/',
      STATS_SITE_LOOKUP_TOKEN: 'token'
    });
    assert.equal(config.masterKey, SECRET);
    assert.equal(config.siteLookupUrl, 'http://api:3000/v1/analytics/sites');
  });

  it('refuses a site lookup without a master key', () => {
    assert.throws(
      () =>
        loadConfig({
          TINYBIRD_ADMIN_TOKEN: SECRET,
          TRAFFIC_STATS_INGEST_TOKEN: INGEST,
          STATS_SITE_LOOKUP_URL: 'http://api:3000/v1/analytics/sites'
        }),
      /STATS_MASTER_KEY/
    );
  });
});
