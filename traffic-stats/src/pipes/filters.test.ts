import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {buildHitsFilter, dateRange, MAX_RANGE_DAYS} from './filters.js';

const NOW = Date.parse('2026-11-13T15:00:00Z');

describe('dateRange', () => {
  it('defaults to the last days ending today', () => {
    assert.deepEqual(dateRange({}, 7, NOW), {dateFrom: '2026-11-06', dateTo: '2026-11-13'});
  });

  it('keeps a valid range', () => {
    assert.deepEqual(dateRange({date_from: '2026-01-01', date_to: '2026-02-01'}, 7, NOW), {
      dateFrom: '2026-01-01',
      dateTo: '2026-02-01'
    });
  });

  it('caps a long range, keeping its end', () => {
    const range = dateRange({date_from: '0001-01-01', date_to: '2026-11-13'}, 7, NOW);
    assert.equal(range.dateTo, '2026-11-13');
    const days = (Date.parse(range.dateTo) - Date.parse(range.dateFrom)) / 864e5 + 1;
    assert.equal(days, MAX_RANGE_DAYS);
  });

  it('ignores dates that are not YYYY-MM-DD and swaps a reversed range', () => {
    assert.deepEqual(dateRange({date_from: 'yesterday', date_to: '2026-11-13'}, 7, NOW), {
      dateFrom: '2026-11-06',
      dateTo: '2026-11-13'
    });
    assert.deepEqual(dateRange({date_from: '2026-11-13', date_to: '2026-11-01'}, 7, NOW), {
      dateFrom: '2026-11-01',
      dateTo: '2026-11-13'
    });
  });
});

describe('buildHitsFilter', () => {
  it('keeps limit and skip within bounds', () => {
    const filter = buildHitsFilter('site', {limit: '100000', skip: '-5'});
    assert.equal(filter.limit, 500);
    assert.equal(filter.skip, 0);
    assert.equal(buildHitsFilter('site', {limit: 'abc'}).limit, 50);
  });
});
