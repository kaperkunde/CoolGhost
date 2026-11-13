import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {createSiteLookup} from './site-lookup.js';

function fakeFetch(answers: Record<string, {status: number; body?: unknown}>) {
  const calls: Array<{url: string; authorization?: string}> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({url, authorization: headers.authorization});
    const answer = answers[url];
    if (!answer) {
      throw new Error('unreachable');
    }
    return new Response(JSON.stringify(answer.body ?? {}), {status: answer.status});
  }) as unknown as typeof fetch;
  return {impl, calls};
}

describe('createSiteLookup', () => {
  it('asks once per minute and sends the token', async () => {
    let now = 0;
    const {impl, calls} = fakeFetch({'http://api/v1/sites/blog_one': {status: 200, body: {siteUuid: 'uuid-1'}}});
    const lookup = createSiteLookup({url: 'http://api/v1/sites', token: 'tok', fetchImpl: impl, now: () => now});
    assert.deepEqual(await lookup('blog_one'), {ok: true, siteUuid: 'uuid-1'});
    assert.deepEqual(await lookup('blog_one'), {ok: true, siteUuid: 'uuid-1'});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, 'Bearer tok');
    now = 61_000;
    await lookup('blog_one');
    assert.equal(calls.length, 2);
  });

  it('says not found on 404, and unavailable otherwise without caching', async () => {
    const {impl, calls} = fakeFetch({
      'http://api/v1/sites/gone': {status: 404},
      'http://api/v1/sites/broken': {status: 500}
    });
    const lookup = createSiteLookup({url: 'http://api/v1/sites', token: null, fetchImpl: impl});
    assert.deepEqual(await lookup('gone'), {ok: false, reason: 'not_found'});
    assert.deepEqual(await lookup('broken'), {ok: false, reason: 'unavailable'});
    assert.deepEqual(await lookup('broken'), {ok: false, reason: 'unavailable'});
    assert.deepEqual(await lookup('nowhere'), {ok: false, reason: 'unavailable'});
    assert.equal(calls.filter((c) => c.url.endsWith('/broken')).length, 2);
  });
});
