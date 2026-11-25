import { CertificationData } from '@unicitylabs/state-transition-sdk/lib/api/CertificationData.js';
import { CertificationRequest } from '@unicitylabs/state-transition-sdk/lib/api/CertificationRequest.js';
import { StateId } from '@unicitylabs/state-transition-sdk/lib/api/StateId.js';
import { DataHash } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/crypto/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/SigningService.js';
import { SignaturePredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/SignaturePredicate.js';
import { SignaturePredicateUnlockScript } from '@unicitylabs/state-transition-sdk/lib/predicate/builtin/SignaturePredicateUnlockScript.js';
import { EncodedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/EncodedPredicate.js';
import { HexConverter } from '@unicitylabs/state-transition-sdk/lib/util/HexConverter.js';

/** Re-rolls allowed per commitment before giving up on hitting a targeted shard. */
const MAX_SHARD_TRIES = 4096;

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function randomBytes(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Whether `bytes` starts with the bit string `prefix` (e.g. "010"), most
 * significant bit of the first byte first. This is how a BFT shard prefix
 * selects state IDs (the SDK's ShardId.isPrefixOf).
 *
 * @param {Uint8Array} bytes
 * @param {string} prefix
 * @returns {boolean}
 */
export function hasBitPrefix(bytes, prefix) {
  if (prefix.length > bytes.length * 8) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    if (bit !== (prefix.charCodeAt(i) === 49 ? 1 : 0)) {
      return false;
    }
  }
  return true;
}

/**
 * The first prefix in `prefixes` that `bytes` starts with, or null.
 *
 * @param {Uint8Array} bytes
 * @param {string[]} prefixes
 * @returns {string|null}
 */
export function matchPrefix(bytes, prefixes) {
  for (const prefix of prefixes) {
    if (hasBitPrefix(bytes, prefix)) {
      return prefix;
    }
  }
  return null;
}

/**
 * @typedef {object} Commitment
 * @property {string} stateId   State ID, hex.
 * @property {string|null} shard Shard prefix the state ID falls in, or null when no shards are known.
 * @property {string} params    The `certification_request` JSON-RPC params: the request's CBOR, hex.
 */

/**
 * Build one signed certification request for a fresh random key pair, a random
 * source state and a random transaction hash.
 *
 * When `targets` is non-empty, the source state is re-rolled until the state ID
 * falls in one of those shard prefixes. `allShards` is used to name the shard
 * when no targeting is requested.
 *
 * @param {string[]} targets   Shard prefixes to aim at; empty for any shard.
 * @param {string[]} allShards Every shard prefix of the network; may be empty.
 * @returns {Promise<Commitment>}
 */
export async function buildCommitment(targets, allShards) {
  const signingService = SigningService.generate();
  const lockScript = EncodedPredicate.fromPredicate(SignaturePredicate.fromSigningService(signingService));
  const transactionHash = new DataHash(HashAlgorithm.SHA256, randomBytes(32));

  let transaction = null;
  let stateId = null;
  let shard = null;
  for (let tries = 0; ; tries++) {
    transaction = {
      calculateTransactionHash: () => Promise.resolve(transactionHash),
      expiresAt: null,
      lockScript,
      sourceStateHash: new DataHash(HashAlgorithm.SHA256, randomBytes(32)),
    };
    stateId = await StateId.fromTransaction(transaction);
    if (targets.length === 0) {
      shard = matchPrefix(stateId.data, allShards);
      break;
    }
    shard = matchPrefix(stateId.data, targets);
    if (shard !== null) {
      break;
    }
    if (tries >= MAX_SHARD_TRIES) {
      throw new Error(`No state ID landed in shards ${targets.join(', ')} after ${MAX_SHARD_TRIES} tries.`);
    }
  }

  const unlockScript = await SignaturePredicateUnlockScript.create(transaction, signingService);
  const certificationData = await CertificationData.fromTransaction(transaction, unlockScript);
  const request = await CertificationRequest.create(certificationData);

  return {
    params: HexConverter.encode(request.toCBOR()),
    shard,
    stateId: HexConverter.encode(stateId.data),
  };
}
