import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_FAILURE_DETAILS, OVERFLOW_DETAIL, Stats } from '../../src/stats.js';

test('failure details stop growing at the cap', () => {
  const s = new Stats();
  for (let i = 0; i < MAX_FAILURE_DETAILS + 30; i++) {
    s.recordSubmit(1000, '0', { detail: `upstream said ${i}`, httpStatus: 502, kind: 'http', ms: 1 });
  }
  s.recordSubmit(1000, '0', { detail: 'upstream said 3', httpStatus: 502, kind: 'http', ms: 1 });
  assert.equal(s.failureDetails.size, MAX_FAILURE_DETAILS + 1);
  assert.equal(s.failureDetails.get(OVERFLOW_DETAIL), 30);
  assert.equal(s.failureDetails.get('http: upstream said 3'), 2, 'known details keep counting');
  assert.equal(s.failures.get('http'), MAX_FAILURE_DETAILS + 31);
});

test('a date Retry-After is kept as text', () => {
  const s = new Stats();
  s.recordSubmit(1000, '0', { blocked: false, httpStatus: 429, kind: 'rate-limited', ms: 1, retryAfter: null, retryAfterRaw: 'Wed, 25 Nov 2026 12:00:00 GMT' });
  assert.equal(s.lastRetryAfter, 'Wed, 25 Nov 2026 12:00:00 GMT');
  assert.equal(s.keyBlocked, false);
});

test('history is trimmed to the last ten minutes', () => {
  const s = new Stats();
  for (let second = 0; second < 1000; second++) {
    s.recordSubmit(second * 1000, '0', { accepted: true, httpStatus: 200, kind: 'ok', ms: 1, status: 'SUCCESS' });
  }
  assert.ok(s.seconds.size <= 600);
  assert.ok(s.shards.get('0').accepted.size <= 60);
  assert.equal(s.acceptedIn('0', 999_000, 10), 10);
  assert.equal(s.acceptedIn('0', 999_000, 60), 60);
});
