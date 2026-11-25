import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CertificationData } from '@unicitylabs/state-transition-sdk/lib/api/CertificationData.js';
import { CertificationRequest } from '@unicitylabs/state-transition-sdk/lib/api/CertificationRequest.js';
import { StateId } from '@unicitylabs/state-transition-sdk/lib/api/StateId.js';
import { DataHasher } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { Signature } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/Signature.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
import { SignaturePredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/SignaturePredicate.js';
import { PredicateEngine } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngine.js';
import { CborDeserializer } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborDeserializer.js';
import { CborSerializer } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborSerializer.js';
import { HexConverter } from '@unicitylabs/state-transition-sdk/lib/util/HexConverter.js';

import { buildCommitment, hasBitPrefix, matchPrefix } from '../../src/commitment.js';

const TESTNET_SHARDS = ['000', '001', '010', '011', '100', '101', '110', '111'];

/** Decode the request the page sends and check it the way the aggregator does. */
async function decodeAndVerify(commitment) {
  const tag = CborDeserializer.decodeTag(HexConverter.decode(commitment.params));
  assert.equal(tag.tag, CertificationRequest.CBOR_TAG);
  const [version, stateIdCbor, dataCbor, trailer] = CborDeserializer.decodeArray(tag.data, 4);
  assert.equal(CborDeserializer.decodeUnsignedInteger(version), 1n);
  assert.equal(CborDeserializer.decodeUnsignedInteger(trailer), 0n);

  const stateId = StateId.fromCBOR(stateIdCbor);
  const data = CertificationData.fromCBOR(dataCbor);
  assert.equal(HexConverter.encode(stateId.data), commitment.stateId, 'returned stateId is the one in the request');
  assert.ok(stateId.equals(await StateId.fromCertificationData(data)), 'stateId = H(lockScript, sourceStateHash)');

  // Owner predicate: built-in engine, signature type, 33-byte compressed key.
  assert.equal(data.lockScript.engine, PredicateEngine.BUILT_IN);
  const predicate = SignaturePredicate.fromPredicate(data.lockScript);
  assert.ok(SigningService.isPublicKeyValid(predicate.publicKey));

  assert.equal(data.sourceStateHash.data.length, 32);
  assert.equal(data.transactionHash.data.length, 32);
  assert.equal(data.expiresAt, null, 'deadline left to the service');

  // Witness: 65-byte recoverable signature over H([sourceStateHash, transactionHash]).
  assert.equal(data.unlockScript.length, 65);
  const sigHash = await new DataHasher(HashAlgorithm.SHA256)
    .update(
      CborSerializer.encodeArray(
        CborSerializer.encodeByteString(data.sourceStateHash.data),
        CborSerializer.encodeByteString(data.transactionHash.data),
      ),
    )
    .digest();
  assert.ok(await SigningService.verifyWithPublicKey(sigHash, Signature.decode(data.unlockScript), predicate.publicKey));
  return { data, predicate, stateId };
}

test('hasBitPrefix reads bits most significant first', () => {
  const bytes = new Uint8Array([0b01011111, 0x00]);
  assert.ok(hasBitPrefix(bytes, ''));
  assert.ok(hasBitPrefix(bytes, '0'));
  assert.ok(hasBitPrefix(bytes, '010'));
  assert.ok(hasBitPrefix(bytes, '01011111'));
  assert.ok(hasBitPrefix(bytes, '010111110'));
  assert.ok(!hasBitPrefix(bytes, '1'));
  assert.ok(!hasBitPrefix(bytes, '011'));
  assert.ok(!hasBitPrefix(bytes, '010111111'));
  assert.ok(!hasBitPrefix(new Uint8Array([0]), '000000000'), 'longer than the data');
});

test('matchPrefix picks the matching shard or null', () => {
  assert.equal(matchPrefix(new Uint8Array([0b10100000]), TESTNET_SHARDS), '101');
  assert.equal(matchPrefix(new Uint8Array([0b10100000]), ['0', '11']), null);
  assert.equal(matchPrefix(new Uint8Array([0b10100000]), []), null);
});

test('a commitment is a valid, signed certification request', async () => {
  const commitment = await buildCommitment([], TESTNET_SHARDS);
  await decodeAndVerify(commitment);
  assert.ok(TESTNET_SHARDS.includes(commitment.shard));
  assert.ok(hasBitPrefix(HexConverter.decode(commitment.stateId), commitment.shard));
});

test('targeting lands every commitment in a chosen shard', async () => {
  for (const targets of [['010'], ['000', '111'], ['11']]) {
    for (let i = 0; i < 20; i++) {
      const commitment = await buildCommitment(targets, TESTNET_SHARDS);
      assert.ok(targets.includes(commitment.shard), `${commitment.shard} in ${targets}`);
      assert.ok(hasBitPrefix(HexConverter.decode(commitment.stateId), commitment.shard));
    }
  }
  const one = await buildCommitment(['0110'], []);
  await decodeAndVerify(one);
  assert.equal(one.shard, '0110');
});

test('without a shard list the shard is unknown', async () => {
  const commitment = await buildCommitment([], []);
  assert.equal(commitment.shard, null);
  await decodeAndVerify(commitment);
});

test('every commitment has its own key, state and transaction', async () => {
  const keys = new Set();
  const states = new Set();
  const txs = new Set();
  for (let i = 0; i < 50; i++) {
    const { data, predicate, stateId } = await decodeAndVerify(await buildCommitment([], TESTNET_SHARDS));
    keys.add(HexConverter.encode(predicate.publicKey));
    states.add(HexConverter.encode(stateId.data));
    txs.add(HexConverter.encode(data.transactionHash.data));
  }
  assert.equal(keys.size, 50);
  assert.equal(states.size, 50);
  assert.equal(txs.size, 50);
});

test('shards are hit roughly uniformly when not targeting', async () => {
  const counts = new Map();
  for (let i = 0; i < 400; i++) {
    const { shard } = await buildCommitment([], TESTNET_SHARDS);
    counts.set(shard, (counts.get(shard) ?? 0) + 1);
  }
  assert.equal(counts.size, 8);
  for (const n of counts.values()) {
    assert.ok(n > 20 && n < 90, `each shard near 50 of 400, got ${n}`);
  }
});
