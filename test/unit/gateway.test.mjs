import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { classifyHttpStatus, fetchShardConfig, pollInclusionProof, rpc, submitCommitment } from '../../src/gateway.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch with a handler that sees the parsed JSON-RPC request. */
function stub(handler) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const request = init?.body ? JSON.parse(init.body) : null;
    seen.push({ headers: init?.headers, request, url });
    const { status = 200, headers = {}, body } = await handler(request, init);
    const text = typeof body === 'function' ? body(request) : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { headers, status });
  };
  return seen;
}

const ok = (result) => ({ body: (req) => JSON.stringify({ id: req.id, jsonrpc: '2.0', result }) });
const COMMITMENT = { params: 'd99876', shard: '01', stateId: 'ab'.repeat(32) };

test('classifyHttpStatus', () => {
  const h = (o) => new Headers(o);
  assert.equal(classifyHttpStatus(401, h()), 'unauthorized');
  assert.equal(classifyHttpStatus(402, h()), 'expired');
  assert.equal(classifyHttpStatus(404, h()), 'not-found');
  assert.equal(classifyHttpStatus(429, h()), 'rate-limited');
  assert.equal(classifyHttpStatus(503, h()), 'overloaded');
  assert.equal(classifyHttpStatus(503, h({ 'X-Maintenance': '1' })), 'maintenance');
  assert.equal(classifyHttpStatus(500, h()), 'http');
});

test('submit sends the SDK request shape and headers', async () => {
  const seen = stub(() => ({ ...ok({ status: 'SUCCESS' }), headers: { 'X-RateLimit-Remaining': '41' } }));
  const outcome = await submitCommitment('https://gw.example', 'key_1', COMMITMENT);
  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.status, 'SUCCESS');
  assert.equal(outcome.remaining, 41);
  assert.equal(seen[0].request.method, 'certification_request');
  assert.equal(seen[0].request.params, COMMITMENT.params);
  assert.equal(seen[0].request.jsonrpc, '2.0');
  assert.equal(seen[0].headers['X-API-Key'], 'key_1');
  assert.equal(seen[0].headers['X-State-ID'], COMMITMENT.stateId);
  assert.equal(seen[0].headers['Content-Type'], 'application/json');
});

test('other aggregator statuses are not accepted', async () => {
  stub(() => ok({ status: 'SIGNATURE_VERIFICATION_FAILED' }));
  const outcome = await submitCommitment('https://gw.example', 'k', COMMITMENT);
  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.status, 'SIGNATURE_VERIFICATION_FAILED');
});

test('429 with and without Retry-After', async () => {
  stub(() => ({ body: 'Too Many Requests', headers: { 'Retry-After': '3' }, status: 429 }));
  let outcome = await submitCommitment('https://gw.example', 'k', COMMITMENT);
  assert.equal(outcome.kind, 'rate-limited');
  assert.equal(outcome.retryAfter, 3);
  assert.equal(outcome.blocked, false);
  stub(() => ({ body: 'Too Many Requests', status: 429 }));
  outcome = await submitCommitment('https://gw.example', 'k', COMMITMENT);
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.retryAfter, null);
  // An HTTP-date Retry-After is still a Retry-After: throttled, not blocked.
  stub(() => ({ body: 'Too Many Requests', headers: { 'Retry-After': 'Wed, 25 Nov 2026 12:00:00 GMT' }, status: 429 }));
  outcome = await submitCommitment('https://gw.example', 'k', COMMITMENT);
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.retryAfter, null);
  assert.equal(outcome.retryAfterRaw, 'Wed, 25 Nov 2026 12:00:00 GMT');
});

test('HTTP failures carry status, detail and kind', async () => {
  for (const [status, kind, headers] of [
    [401, 'unauthorized', {}],
    [402, 'expired', {}],
    [503, 'overloaded', { 'Retry-After': '1' }],
    [503, 'maintenance', { 'X-Maintenance': 'true' }],
    [502, 'http', {}],
  ]) {
    stub(() => ({ body: `status ${status}`, headers, status }));
    const outcome = await submitCommitment('https://gw.example', 'k', COMMITMENT);
    assert.equal(outcome.kind, kind, `${status}`);
    assert.equal(outcome.httpStatus, status);
    assert.equal(outcome.detail, `status ${status}`);
  }
});

test('JSON-RPC errors and malformed bodies', async () => {
  stub(() => ({ body: (req) => JSON.stringify({ error: { code: -32602, message: 'bad params' }, id: req.id, jsonrpc: '2.0' }) }));
  let outcome = await rpc('https://gw.example', 'm', {}, {});
  assert.equal(outcome.kind, 'rpc-error');
  assert.equal(outcome.detail, 'bad params');
  assert.equal(outcome.code, -32602);

  stub(() => ({ body: 'not json' }));
  assert.equal((await rpc('https://gw.example', 'm', {}, {})).kind, 'bad-response');

  stub(() => ({ body: { id: 'someone-else', jsonrpc: '2.0', result: 1 } }));
  outcome = await rpc('https://gw.example', 'm', {}, {});
  assert.equal(outcome.kind, 'bad-response');
  assert.match(outcome.detail, /does not match/);

  stub(() => ok({ nostatus: true }));
  assert.equal((await submitCommitment('https://gw.example', 'k', COMMITMENT)).kind, 'bad-response');
});

test('network failure and abort', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  let outcome = await rpc('https://gw.example', 'm', {}, {});
  assert.equal(outcome.kind, 'network');
  assert.equal(outcome.detail, 'Failed to fetch');

  globalThis.fetch = (url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const controller = new AbortController();
  const pending = rpc('https://gw.example', 'm', {}, {}, controller.signal);
  controller.abort();
  outcome = await pending;
  assert.equal(outcome.kind, 'aborted');
});

test('inclusion proof poll tells certified from not yet certified', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/not-certified.json', import.meta.url), 'utf8'));
  const seen = stub(() => ok(fixture.result));
  const outcome = await pollInclusionProof('https://gw.example', 'k', fixture.stateId);
  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.included, false);
  assert.equal(outcome.shard, '011');
  assert.equal(seen[0].request.method, 'get_inclusion_proof.v2');
  assert.deepEqual(seen[0].request.params, { stateId: fixture.stateId });
  assert.equal(seen[0].headers['X-API-Key'], 'k');

  const certified = JSON.parse(readFileSync(new URL('../fixtures/certified.json', import.meta.url), 'utf8'));
  stub(() => ok(certified.result));
  const included = await pollInclusionProof('https://gw.example', 'k', certified.stateId);
  assert.equal(included.kind, 'ok');
  assert.equal(included.included, true);
  assert.equal(included.shard, certified.shard);

  stub(() => ok('deadbeef'));
  const bad = await pollInclusionProof('https://gw.example', 'k', fixture.stateId);
  assert.equal(bad.kind, 'bad-response');
  assert.match(bad.detail, /undecodable/);
});

test('shard config', async () => {
  stub(() => ({ body: { bftShardPrefixes: ['00', '01', '10', '11', 'x2'], mode: 'bft-shard', version: 1 } }));
  assert.deepEqual(await fetchShardConfig('https://gw.example'), { mode: 'bft-shard', prefixes: ['00', '01', '10', '11'] });
  stub(() => ({ body: { mode: 'app-shard', shardIds: [1], version: 3 } }));
  assert.deepEqual(await fetchShardConfig('https://gw.example'), { mode: 'app-shard', prefixes: [] });
  stub(() => ({ body: { error: 'x' }, status: 503 }));
  await assert.rejects(fetchShardConfig('https://gw.example'), /503/);
});

test('a stalled shard config request gives up', async () => {
  globalThis.fetch = (url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  // AbortSignal.timeout does not hold Node's event loop open; this timer does, until the timeout has fired.
  const keepAlive = setTimeout(() => {}, 5000);
  await assert.rejects(fetchShardConfig('https://gw.example', 50));
  clearTimeout(keepAlive);
});
