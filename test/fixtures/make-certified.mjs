// Writes test/fixtures/certified.json: a certified get_inclusion_proof.v2 answer for a
// commitment built by the page, wrapped around the real testnet unicity certificate from
// not-certified.json. Structurally real (it decodes with the SDK); not meant to verify.
import { readFileSync, writeFileSync } from 'node:fs';

import { CertificationData } from '@unicitylabs/state-transition-sdk/lib/api/CertificationData.js';
import { CertificationRequest } from '@unicitylabs/state-transition-sdk/lib/api/CertificationRequest.js';
import { InclusionCertificate } from '@unicitylabs/state-transition-sdk/lib/api/InclusionCertificate.js';
import { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProof.js';
import { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
import { calculateLeafValue } from '@unicitylabs/state-transition-sdk/lib/api/LeafValue.js';
import { DataHasher } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasher.js';
import { DataHasherFactory } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHasherFactory.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { CborDeserializer } from '@unicitylabs/state-transition-sdk/lib/serialization/cbor/CborDeserializer.js';
import { SparseMerkleTree } from '@unicitylabs/state-transition-sdk/lib/smt/radix/SparseMerkleTree.js';
import { HexConverter } from '@unicitylabs/state-transition-sdk/lib/util/HexConverter.js';

import { buildCommitment } from '../../src/commitment.js';

const notCertified = JSON.parse(readFileSync(new URL('./not-certified.json', import.meta.url), 'utf8'));
const { unicityCertificate } = InclusionProofResponse.fromCBOR(HexConverter.decode(notCertified.result));
const shard = unicityCertificate.shardTreeCertificate.shard.toString();

const commitment = await buildCommitment([shard], [shard]);
const tag = CborDeserializer.decodeTag(HexConverter.decode(commitment.params));
const data = CertificationData.fromCBOR(CborDeserializer.decodeArray(tag.data, 4)[2]);
if (tag.tag !== CertificationRequest.CBOR_TAG) {
  throw new Error('unexpected request tag');
}

const referenceTime = 1_795_000_000n;
const smt = new SparseMerkleTree(new DataHasherFactory(HashAlgorithm.SHA256, DataHasher));
const stateId = HexConverter.decode(commitment.stateId);
await smt.addLeaf(stateId, (await calculateLeafValue(data.transactionHash, referenceTime)).data);
const root = await smt.calculateRoot();
const proof = new InclusionProof(data, referenceTime, InclusionCertificate.create(root, stateId), unicityCertificate);
const response = InclusionProofResponse.certified(1n, proof);

writeFileSync(
  new URL('./certified.json', import.meta.url),
  `${JSON.stringify({ result: HexConverter.encode(response.toCBOR()), shard, stateId: commitment.stateId }, null, 1)}\n`,
);
console.log(`certified.json written (shard ${shard})`);
