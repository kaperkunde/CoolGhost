import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import jwt from 'jsonwebtoken';
import {createPipeTokenVerifier} from './jwt.js';
import {deriveSiteKey} from './keys.js';
import type {SiteLookup} from './site-lookup.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const NOW_S = NOW / 1000;
const SITE = '17ff4100-9666-41c1-84b1-c52bf9ffad54';
const OTHER = '2a43f1e6-b11a-4226-a1f2-652c3fc701fe';
const SECRET = 's'.repeat(64);
const MASTER = 'm'.repeat(64);

/** A token shaped as Ghost's tinybird-service.js signs it. */
function ghostToken({
  key,
  workspace = 'DUMMY_WORKSPACE_ID',
  site = SITE,
  exp = NOW_S + 3 * 3600,
  pipes = ['api_kpis', 'api_top_pages'],
  sites
}: {
  key: string;
  workspace?: string;
  site?: string;
  exp?: number | null;
  pipes?: string[];
  sites?: string[];
}): string {
  const payload: Record<string, unknown> = {
    workspace_id: workspace,
    name: `tinybird-jwt-${site}`,
    scopes: pipes.map((pipe, i) => ({
      type: 'PIPES:READ',
      resource: pipe,
      fixed_params: {site_uuid: sites?.[i] ?? site}
    }))
  };
  if (exp !== null) {
    payload.exp = exp;
  }
  return jwt.sign(payload, key, {noTimestamp: true});
}

const base = {adminToken: null, workspaceId: 'DUMMY_WORKSPACE_ID', masterKey: null, allowLegacyToken: false};

describe('single-site mode', () => {
  const verify = createPipeTokenVerifier({config: {...base, adminToken: SECRET}, now: () => NOW});

  it('accepts a token signed with the site secret', async () => {
    const result = await verify(`Bearer ${ghostToken({key: SECRET})}`, undefined, 'api_kpis');
    assert.deepEqual(result, {ok: true, siteUuid: SITE});
  });

  it('accepts the token in the query string', async () => {
    const result = await verify(undefined, ghostToken({key: SECRET}), 'api_kpis');
    assert.equal(result.ok, true);
  });

  it('refuses DUMMY_TOKEN', async () => {
    const result = await verify(`Bearer ${ghostToken({key: 'DUMMY_TOKEN'})}`, undefined, 'api_kpis');
    assert.deepEqual(result, {ok: false, status: 403, error: 'Invalid token'});
  });

  it('refuses a missing token', async () => {
    const result = await verify(undefined, undefined, 'api_kpis');
    assert.equal(result.ok, false);
  });

  it('refuses another workspace', async () => {
    const result = await verify(`Bearer ${ghostToken({key: SECRET, workspace: 'other'})}`, undefined, 'api_kpis');
    assert.equal(result.ok, false);
  });

  it('refuses a pipe the token does not name', async () => {
    const result = await verify(`Bearer ${ghostToken({key: SECRET})}`, undefined, 'api_top_sources');
    assert.deepEqual(result, {ok: false, status: 403, error: 'Pipe not in token scope'});
  });

  it('refuses algorithms other than HS256', async () => {
    const payload = jwt.decode(ghostToken({key: SECRET})) as jwt.JwtPayload;
    const hs512 = jwt.sign(payload, SECRET, {algorithm: 'HS512', noTimestamp: true});
    assert.equal((await verify(`Bearer ${hs512}`, undefined, 'api_kpis')).ok, false);
    const none = jwt.sign(payload, '', {algorithm: 'none', noTimestamp: true});
    assert.equal((await verify(`Bearer ${none}`, undefined, 'api_kpis')).ok, false);
  });

  it('requires an expiry, refuses an expired one and caps the lifetime', async () => {
    const noExp = await verify(`Bearer ${ghostToken({key: SECRET, exp: null})}`, undefined, 'api_kpis');
    assert.deepEqual(noExp, {ok: false, status: 403, error: 'Token has no expiry'});
    const expired = await verify(`Bearer ${ghostToken({key: SECRET, exp: NOW_S - 10})}`, undefined, 'api_kpis');
    assert.equal(expired.ok, false);
    const tooLong = await verify(
      `Bearer ${ghostToken({key: SECRET, exp: NOW_S + 30 * 24 * 3600})}`,
      undefined,
      'api_kpis'
    );
    assert.deepEqual(tooLong, {ok: false, status: 403, error: 'Token lasts too long'});
  });

  it('refuses scopes naming different sites', async () => {
    const result = await verify(
      `Bearer ${ghostToken({key: SECRET, sites: [SITE, OTHER]})}`,
      undefined,
      'api_kpis'
    );
    assert.equal(result.ok, false);
  });
});

describe('legacy flag', () => {
  it('accepts DUMMY_TOKEN only while it is on', async () => {
    const on = createPipeTokenVerifier({config: {...base, masterKey: MASTER, allowLegacyToken: true}, now: () => NOW});
    const token = ghostToken({key: 'DUMMY_TOKEN'});
    assert.deepEqual(await on(`Bearer ${token}`, undefined, 'api_kpis'), {ok: true, siteUuid: SITE});
    const ownWorkspace = ghostToken({key: 'DUMMY_TOKEN', workspace: 'blog_one'});
    assert.deepEqual(await on(`Bearer ${ownWorkspace}`, undefined, 'api_kpis'), {ok: true, siteUuid: SITE});
    const off = createPipeTokenVerifier({config: {...base, masterKey: MASTER}, now: () => NOW});
    assert.equal((await off(`Bearer ${token}`, undefined, 'api_kpis')).ok, false);
    assert.equal((await off(`Bearer ${ownWorkspace}`, undefined, 'api_kpis')).ok, false);
  });
});

describe('derived keys', () => {
  const sites: Record<string, string> = {blog_one: SITE, blog_two: OTHER};
  const lookup: SiteLookup = async (workspace) =>
    sites[workspace] ? {ok: true, siteUuid: sites[workspace]} : {ok: false, reason: 'not_found'};
  const verify = createPipeTokenVerifier({config: {...base, masterKey: MASTER}, lookupSite: lookup, now: () => NOW});
  const keyOne = deriveSiteKey(MASTER, 'blog_one');

  it('accepts a site signing with its own derived key', async () => {
    const result = await verify(`Bearer ${ghostToken({key: keyOne, workspace: 'blog_one'})}`, undefined, 'api_kpis');
    assert.deepEqual(result, {ok: true, siteUuid: SITE});
  });

  it('refuses a site key used for another site_uuid', async () => {
    const result = await verify(
      `Bearer ${ghostToken({key: keyOne, workspace: 'blog_one', site: OTHER})}`,
      undefined,
      'api_kpis'
    );
    assert.deepEqual(result, {ok: false, status: 403, error: 'Token not valid for this site'});
  });

  it('refuses a site key under another workspace', async () => {
    const result = await verify(`Bearer ${ghostToken({key: keyOne, workspace: 'blog_two', site: OTHER})}`, undefined, 'api_kpis');
    assert.deepEqual(result, {ok: false, status: 403, error: 'Invalid token'});
  });

  it('refuses the master key itself', async () => {
    const result = await verify(`Bearer ${ghostToken({key: MASTER, workspace: 'blog_one'})}`, undefined, 'api_kpis');
    assert.equal(result.ok, false);
  });

  it('refuses a workspace the lookup does not know', async () => {
    const key = deriveSiteKey(MASTER, 'gone');
    const result = await verify(`Bearer ${ghostToken({key, workspace: 'gone'})}`, undefined, 'api_kpis');
    assert.deepEqual(result, {ok: false, status: 403, error: 'Unknown workspace'});
  });

  it('answers 503 while the lookup is unavailable', async () => {
    const down = createPipeTokenVerifier({
      config: {...base, masterKey: MASTER},
      lookupSite: async () => ({ok: false, reason: 'unavailable'}),
      now: () => NOW
    });
    const result = await down(`Bearer ${ghostToken({key: keyOne, workspace: 'blog_one'})}`, undefined, 'api_kpis');
    assert.deepEqual(result, {ok: false, status: 503, error: 'Site lookup unavailable'});
  });

  it('trusts the token without a lookup configured', async () => {
    const unbound = createPipeTokenVerifier({config: {...base, masterKey: MASTER}, now: () => NOW});
    const result = await unbound(
      `Bearer ${ghostToken({key: keyOne, workspace: 'blog_one', site: OTHER})}`,
      undefined,
      'api_kpis'
    );
    assert.deepEqual(result, {ok: true, siteUuid: OTHER});
  });
});
