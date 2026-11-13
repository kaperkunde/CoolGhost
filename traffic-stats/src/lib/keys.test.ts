import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {bearerMatches, deriveSiteKey, secretsMatch} from './keys.js';

describe('deriveSiteKey', () => {
  it('is stable, per workspace and per master key', () => {
    const master = 'm'.repeat(64);
    const a = deriveSiteKey(master, 'blog_one');
    assert.equal(a, deriveSiteKey(master, 'blog_one'));
    assert.notEqual(a, deriveSiteKey(master, 'blog_two'));
    assert.notEqual(a, deriveSiteKey('n'.repeat(64), 'blog_one'));
    assert.match(a, /^gs1_[A-Za-z0-9_-]{43}$/);
  });

  it('matches the documented derivation', () => {
    // HMAC-SHA256(master, "ghost-stats-v1:" + workspace), base64url, prefixed gs1_.
    assert.equal(
      deriveSiteKey('master-key-for-tests-0123456789abcdef', 'example_blog'),
      'gs1_eHG2g1p2EgqU0iF4x1jjO5ceGyt8TfOTqZAqgkpppeM'
    );
  });

  it('refuses workspace ids that are not identifiers', () => {
    assert.throws(() => deriveSiteKey('m'.repeat(64), 'a/b'));
    assert.throws(() => deriveSiteKey('m'.repeat(64), ''));
    assert.throws(() => deriveSiteKey('m'.repeat(64), 'x'.repeat(65)));
  });
});

describe('bearerMatches', () => {
  it('checks the Bearer value', () => {
    assert.equal(bearerMatches('Bearer secret', 'secret'), true);
    assert.equal(bearerMatches('Bearer other', 'secret'), false);
    assert.equal(bearerMatches('secret', 'secret'), false);
    assert.equal(bearerMatches(undefined, 'secret'), false);
    assert.equal(secretsMatch('a', 'ab'), false);
  });
});
