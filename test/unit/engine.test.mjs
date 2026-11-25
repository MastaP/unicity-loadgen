import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LoadRun, PROOF_POLL_INTERVAL_MS, PROOF_TIMEOUT_MS } from '../../src/engine.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A run on a fake clock with a scripted gateway. `submit` and `poll` decide each
 * outcome from the commitment / state id and the call count.
 */
function harness({ submit, poll, ...options }) {
  const clock = { t: 0 };
  const calls = { polls: [], submits: [] };
  const events = [];
  let n = 0;
  const run = new LoadRun({
    allShards: ['0', '1'],
    intervalMs: 1000,
    max: 1,
    min: 1,
    onEvent: (e) => events.push(e),
    periodMs: 0,
    targets: [],
    transport: {
      build: async () => {
        n++;
        return { params: '00', shard: n % 2 ? '1' : '0', stateId: `s${n}` };
      },
      now: () => clock.t,
      poll: async (stateId, signal) => {
        calls.polls.push({ at: clock.t, stateId });
        return poll ? poll(stateId, calls.polls.filter((p) => p.stateId === stateId).length, signal) : { included: true, kind: 'ok', ms: 5 };
      },
      submit: async (commitment, signal) => {
        calls.submits.push({ at: clock.t, stateId: commitment.stateId });
        return submit ? submit(commitment, signal) : { accepted: true, httpStatus: 200, kind: 'ok', ms: 10, remaining: 99, status: 'SUCCESS' };
      },
    },
    ...options,
  });
  const advance = async (to, step = 100) => {
    while (clock.t < to) {
      clock.t = Math.min(to, clock.t + step);
      run.tick(clock.t);
      await flush();
    }
  };
  return { advance, calls, clock, events, run };
}

test('sends on a fixed schedule with a random count per send, then drains', async () => {
  let picks = 0;
  const h = harness({ max: 5, min: 2, periodMs: 5000, pickCount: () => [2, 5, 3, 4, 2][picks++] });
  h.run.start(0);
  await flush();
  await h.advance(4900);
  assert.deepEqual(
    [...new Set(h.calls.submits.map((s) => s.at))],
    [0, 1000, 2000, 3000, 4000],
    'one send per interval',
  );
  assert.equal(h.calls.submits.length, 16, '2+5+3+4+2');
  assert.equal(h.run.sendCount, 5);
  await h.advance(5000);
  assert.equal(h.run.stopReason, 'period over');
  await h.advance(6100);
  assert.equal(h.run.phase, 'done', 'all proofs in, run over');
  assert.equal(h.run.stats.accepted, 16);
  assert.equal(h.run.stats.included, 16);
  assert.equal(h.run.stats.lastRemaining, 99);
});

test('default count picker stays inside the range', async () => {
  const h = harness({ max: 7, min: 3 });
  for (let i = 0; i < 500; i++) {
    const c = h.run.pickCount();
    assert.ok(c >= 3 && c <= 7 && Number.isInteger(c));
  }
});

test('first proof request comes one interval after acceptance, then once per interval until included', async () => {
  const h = harness({ poll: (_id, nth) => ({ included: nth === 3, kind: 'ok', ms: 5, shard: '1' }) });
  h.run.start(0);
  await flush();
  h.run.stop(0);
  assert.equal(h.run.phase, 'draining');
  await h.advance(5000);
  const polls = h.calls.polls.map((p) => p.at);
  assert.deepEqual(polls, [PROOF_POLL_INTERVAL_MS, 2 * PROOF_POLL_INTERVAL_MS, 3 * PROOF_POLL_INTERVAL_MS]);
  assert.equal(h.run.stats.included, 1);
  assert.equal(h.run.stats.proofLatency.percentile(50), 3000);
  assert.equal(h.run.phase, 'done');
  assert.equal(h.run.stats.shardMismatches, 0);
});

test('a proof that never comes times out after the limit', async () => {
  const h = harness({ poll: () => ({ included: false, kind: 'ok', ms: 5 }) });
  h.run.start(0);
  await flush();
  h.run.stop(0);
  await h.advance(PROOF_TIMEOUT_MS - 100, 500);
  assert.equal(h.run.pending.size, 1);
  await h.advance(PROOF_TIMEOUT_MS + 1000, 500);
  assert.equal(h.run.stats.proofTimeouts, 1);
  assert.equal(h.run.pending.size, 0);
  assert.equal(h.run.phase, 'done');
  assert.ok(h.events.some((e) => e.kind === 'proof-timeout'));
});

test('proof request failures are counted and polling continues', async () => {
  const outcomes = [{ kind: 'overloaded', ms: 1 }, { kind: 'not-found', ms: 1 }, { included: true, kind: 'ok', ms: 1 }];
  const h = harness({ poll: (_id, nth) => outcomes[nth - 1] });
  h.run.start(0);
  await flush();
  h.run.stop(0);
  await h.advance(4000);
  assert.equal(h.run.stats.included, 1);
  assert.equal(h.run.stats.pollFailures.get('overloaded'), 1);
  assert.equal(h.run.stats.pollFailures.has('not-found'), false, 'not yet certified is not a failure');
  assert.equal(h.run.stats.proofPolls, 3);
});

test('a proof from an unexpected shard is flagged', async () => {
  const h = harness({ poll: () => ({ included: true, kind: 'ok', ms: 1, shard: '0' }) });
  h.run.start(0);
  await flush();
  h.run.stop(0);
  await h.advance(2000);
  assert.equal(h.run.stats.shardMismatches, 1, 'commitment was built for shard 1');
});

test('401 stops the run', async () => {
  const h = harness({ max: 3, min: 3, submit: () => ({ detail: 'Unauthorized', httpStatus: 401, kind: 'unauthorized', ms: 3 }) });
  h.run.start(0);
  await flush();
  assert.equal(h.run.phase, 'done');
  assert.match(h.run.stopReason, /401/);
  assert.equal(h.run.stats.failures.get('unauthorized'), 3);
  await h.advance(3000);
  assert.equal(h.calls.submits.length, 3, 'nothing sent after the stop');
});

test('402 stops the run', async () => {
  const h = harness({ submit: () => ({ httpStatus: 402, kind: 'expired', ms: 3 }) });
  h.run.start(0);
  await flush();
  assert.equal(h.run.phase, 'done');
  assert.match(h.run.stopReason, /402/);
});

test('429s are counted apart from errors; no Retry-After means blocked', async () => {
  const script = [
    { blocked: false, httpStatus: 429, kind: 'rate-limited', ms: 1, retryAfter: 2, retryAfterRaw: '2' },
    { blocked: true, httpStatus: 429, kind: 'rate-limited', ms: 1, retryAfter: null, retryAfterRaw: null },
    { accepted: true, httpStatus: 200, kind: 'ok', ms: 1, remaining: 0, status: 'SUCCESS' },
    { accepted: false, httpStatus: 200, kind: 'ok', ms: 1, status: 'REQUEST_EXPIRED' },
    { detail: 'Service Overloaded', httpStatus: 503, kind: 'overloaded', ms: 1, retryAfter: 1, retryAfterRaw: '1' },
  ];
  let i = 0;
  const h = harness({ poll: () => ({ included: true, kind: 'ok', ms: 1 }), submit: () => script[i++] });
  h.run.start(0);
  await flush();
  assert.equal(h.run.stats.rateLimited, 1);
  assert.equal(h.run.stats.lastRetryAfter, 2);
  assert.equal(h.run.stats.keyBlocked, false);
  await h.advance(1000);
  assert.equal(h.run.stats.rateLimited, 2);
  assert.equal(h.run.stats.keyBlocked, true);
  await h.advance(2000);
  assert.equal(h.run.stats.keyBlocked, false, 'an accepted request clears the block');
  assert.equal(h.run.stats.lastRemaining, 0);
  await h.advance(4000);
  assert.equal(h.run.stats.statuses.get('REQUEST_EXPIRED'), 1);
  assert.equal(h.run.stats.failures.get('overloaded'), 1);
  assert.equal(h.run.stats.errors, 2);
  assert.equal(h.run.stats.rateLimited, 2);
  const series = h.run.stats.series(4000, 5);
  assert.deepEqual(series.map((b) => b.limited), [1, 1, 0, 0, 0]);
});

test('a page that fell behind skips missed sends instead of bursting', async () => {
  const h = harness({});
  h.run.start(0);
  await flush();
  h.clock.t = 3500;
  h.run.tick(3500);
  await flush();
  assert.equal(h.run.stats.missedSends, 2, 'the 1000 and 2000 slots');
  assert.equal(h.calls.submits.length, 2);
  await h.advance(3900);
  assert.equal(h.calls.submits.length, 2);
  await h.advance(4000);
  assert.equal(h.calls.submits.length, 3, 'back on the original schedule');
});

test('period 0 keeps going until stopped', async () => {
  const h = harness({ periodMs: 0 });
  h.run.start(0);
  await h.advance(30_000, 500);
  assert.equal(h.run.phase, 'running');
  assert.equal(h.run.sendCount, 31);
  h.run.stop(30_000);
  await h.advance(32_000);
  assert.equal(h.run.phase, 'done');
  assert.equal(h.run.stopReason, 'stopped');
});

test('stopping twice drops pending proofs and aborts requests', async () => {
  let seenSignal = null;
  const h = harness({
    poll: (_id, _nth, signal) => {
      seenSignal = signal;
      return { included: false, kind: 'ok', ms: 1 };
    },
  });
  h.run.start(0);
  await h.advance(2500);
  h.run.stop(2500);
  assert.equal(h.run.phase, 'draining');
  assert.ok(h.run.pending.size > 0);
  const pending = h.run.pending.size;
  h.run.stop(2600);
  assert.equal(h.run.phase, 'done');
  assert.equal(h.run.pending.size, 0);
  assert.equal(h.run.stats.abandoned, pending);
  assert.equal(seenSignal.aborted, true);
});

test('the proof deadline holds while a proof request is still open; a late answer is ignored', async () => {
  let answer = null;
  const h = harness({ poll: () => new Promise((resolve) => (answer = resolve)) });
  h.run.start(0);
  await flush();
  h.run.stop(0);
  await h.advance(PROOF_TIMEOUT_MS - 100, 500);
  assert.equal(h.calls.polls.length, 1, 'the first poll never answered');
  await h.advance(PROOF_TIMEOUT_MS, 100);
  assert.equal(h.run.stats.proofTimeouts, 1);
  assert.equal(h.run.phase, 'done', 'the run does not wait on the open request');
  h.clock.t = PROOF_TIMEOUT_MS + 20_000;
  answer({ included: true, kind: 'ok', ms: 20_000 });
  await flush();
  assert.equal(h.run.stats.included, 0);
  assert.equal(h.run.stats.proofTimeouts, 1);
});

test('a proof that answers after the deadline counts as a timeout', async () => {
  let answer = null;
  let polls = 0;
  const h = harness({
    poll: () => {
      polls++;
      return polls < 3 ? { included: false, kind: 'ok', ms: 1 } : new Promise((resolve) => (answer = resolve));
    },
  });
  h.run.start(0);
  await flush();
  h.run.stop(0);
  await h.advance(3500);
  assert.equal(polls, 3);
  // The deadline passes between ticks, and the answer arrives before the next tick sees it.
  h.clock.t = PROOF_TIMEOUT_MS + 5;
  answer({ included: true, kind: 'ok', ms: 1 });
  await flush();
  assert.equal(h.run.stats.included, 0);
  assert.equal(h.run.stats.proofTimeouts, 1);
  assert.equal(h.run.phase, 'done');
});

test('"Stop now" ends the run only after open submissions settle, with them counted', async () => {
  const settle = [];
  const snapshots = [];
  const h = harness({
    onPhase: (run) => snapshots.push({ abandoned: run.stats.abandoned, inFlight: run.inFlightSubmits, phase: run.phase }),
    submit: (_c, signal) =>
      new Promise((resolve) => {
        settle.push(resolve);
        signal.addEventListener('abort', () => resolve({ kind: 'aborted', ms: 0 }));
      }),
  });
  h.run.start(0);
  await flush();
  h.run.stop(0);
  h.run.stop(1);
  assert.equal(h.run.phase, 'draining', 'still settling the aborted submission');
  await flush();
  assert.equal(h.run.phase, 'done');
  assert.deepEqual(snapshots.at(-1), { abandoned: 1, inFlight: 0, phase: 'done' });
});

test('a submission accepted just as "Stop now" lands is not waited for', async () => {
  let resolveSubmit = null;
  const h = harness({ submit: () => new Promise((resolve) => (resolveSubmit = resolve)) });
  h.run.start(0);
  await flush();
  h.run.stop(0);
  h.run.stop(1);
  resolveSubmit({ accepted: true, httpStatus: 200, kind: 'ok', ms: 1, status: 'SUCCESS' });
  await flush();
  assert.equal(h.run.phase, 'done');
  assert.equal(h.run.pending.size, 0);
  assert.equal(h.run.stats.accepted, 1);
  assert.equal(h.run.stats.abandoned, 1);
});

test('a page error while building is counted, not thrown', async () => {
  const h = harness({});
  h.run.transport.build = async () => {
    throw new Error('boom');
  };
  h.run.start(0);
  await flush();
  assert.equal(h.run.stats.failures.get('client-error'), 1);
  assert.equal(h.run.phase, 'running');
});
