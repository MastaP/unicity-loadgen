// Live checks against the real gateways. Read-only on mainnet.
//
//   node test/live.mjs                              shard routing on both networks, 401 path on testnet
//   LOADGEN_TESTNET_KEY=... node test/live.mjs      also submits a few commitments to testnet and waits for their proofs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCommitment } from '../src/commitment.js';
import { fetchShardConfig, NETWORKS, pollInclusionProof, submitCommitment } from '../src/gateway.js';

const TESTNET_KEY = process.env.LOADGEN_TESTNET_KEY ?? '';

for (const [name, network] of Object.entries(NETWORKS)) {
  test(`${name}: every shard answers for state IDs built for it`, async () => {
    const { mode, prefixes } = await fetchShardConfig(network.url);
    assert.equal(mode, 'bft-shard');
    assert.ok(prefixes.length > 0);
    for (const prefix of prefixes) {
      const commitment = await buildCommitment([prefix], prefixes);
      const outcome = await pollInclusionProof(network.url, '', commitment.stateId);
      assert.equal(outcome.kind, 'ok', `${prefix}: ${outcome.kind} ${outcome.detail ?? ''}`);
      assert.equal(outcome.included, false, 'a fresh random state is not certified');
      assert.equal(outcome.shard, prefix, 'the gateway routed the state ID to the shard the page computed');
    }
    console.log(`  ${name}: ${prefixes.join(' ')} routed as expected`);
  });
}

test('testnet: a bad API key is rejected with 401', async () => {
  const commitment = await buildCommitment([], []);
  const outcome = await submitCommitment(NETWORKS.testnet.url, 'key_00000000-0000-4000-8000-000000000000', commitment);
  assert.equal(outcome.kind, 'unauthorized', `${outcome.kind} ${outcome.httpStatus} ${outcome.detail ?? ''}`);
});

test('testnet: accepted commitments get inclusion proofs', { skip: TESTNET_KEY === '' && 'set LOADGEN_TESTNET_KEY' }, async () => {
  const { prefixes } = await fetchShardConfig(NETWORKS.testnet.url);
  const results = [];
  for (let i = 0; i < 3; i++) {
    const commitment = await buildCommitment([], prefixes);
    const outcome = await submitCommitment(NETWORKS.testnet.url, TESTNET_KEY, commitment);
    console.log(`  submit ${i + 1}: ${outcome.kind} ${outcome.status ?? outcome.httpStatus} remaining=${outcome.remaining} retryAfter=${outcome.retryAfter} ${Math.round(outcome.ms)} ms`);
    results.push({ commitment, outcome });
  }
  const accepted = results.filter((r) => r.outcome.kind === 'ok' && r.outcome.accepted);
  assert.ok(accepted.length > 0, 'at least one commitment accepted (others may be rate limited)');

  for (const { commitment } of accepted) {
    const started = Date.now();
    let outcome;
    do {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      outcome = await pollInclusionProof(NETWORKS.testnet.url, TESTNET_KEY, commitment.stateId);
    } while (!(outcome.kind === 'ok' && outcome.included) && Date.now() - started < 60_000);
    assert.equal(outcome.included, true, `proof for ${commitment.stateId} within 60 s`);
    assert.equal(outcome.shard, commitment.shard);
    console.log(`  included in shard ${outcome.shard} after ${Date.now() - started} ms`);
  }
});
