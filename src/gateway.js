import { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
import { HexConverter } from '@unicitylabs/state-transition-sdk/lib/util/HexConverter.js';

export const NETWORKS = {
  mainnet: { label: 'Mainnet', url: 'https://gateway.mainnet.unicity.network' },
  testnet: { label: 'Testnet', url: 'https://gateway.testnet2.unicity.network' },
};

/** Per-request time limit; a request still open after this counts as a network error. */
const REQUEST_TIMEOUT_MS = 30_000;

let requestCounter = 0;

/**
 * Outcome kinds an RPC call can end in. Everything that is not `ok` is a
 * failure the page counts under its own name.
 *
 *   ok           HTTP 2xx with a JSON-RPC result
 *   unauthorized 401: missing or unknown API key
 *   expired      402: the key's subscription has lapsed
 *   rate-limited 429 (`blocked` when the 429 has no Retry-After at all: the key is blocked, not throttled)
 *   overloaded   503 without the maintenance marker (admission control / drain)
 *   maintenance  503 with `X-Maintenance`
 *   not-found    404
 *   http         any other non-2xx status
 *   rpc-error    2xx carrying a JSON-RPC error object
 *   bad-response 2xx whose body is not a usable JSON-RPC response
 *   network      the request never got an HTTP answer (offline, CORS, TLS, timeout)
 *   aborted      cancelled by the page
 */

/**
 * @param {number} status
 * @param {Headers} headers
 * @returns {string}
 */
export function classifyHttpStatus(status, headers) {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 402:
      return 'expired';
    case 404:
      return 'not-found';
    case 429:
      return 'rate-limited';
    case 503:
      return headers.get('X-Maintenance') ? 'maintenance' : 'overloaded';
    default:
      return 'http';
  }
}

/**
 * @param {string|null} value
 * @returns {number|null}
 */
function headerNumber(value) {
  if (value == null || value.trim() === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One JSON-RPC call through the gateway. Never throws: every outcome comes back
 * as `{ kind, ... }`.
 *
 * @param {string} url
 * @param {string} method
 * @param {unknown} params
 * @param {Record<string, string>} headers
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
export async function rpc(url, method, params, headers, signal) {
  const id = `lg-${Date.now().toString(36)}-${(requestCounter++).toString(36)}`;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const started = performance.now();

  let response;
  let text;
  try {
    response = await fetch(url, {
      body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...headers },
      method: 'POST',
      redirect: 'error',
      signal: combined,
    });
    text = await response.text();
  } catch (error) {
    const ms = performance.now() - started;
    if (signal?.aborted) {
      return { kind: 'aborted', ms };
    }
    const detail = timeout.aborted ? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s` : String(error?.message ?? error);
    return { detail, kind: 'network', ms };
  }

  const ms = performance.now() - started;
  const remaining = headerNumber(response.headers.get('X-RateLimit-Remaining'));
  // Retry-After may be seconds or an HTTP date; keep the raw value so a date is shown, not lost.
  const retryAfterRaw = response.headers.get('Retry-After');
  const retryAfter = headerNumber(retryAfterRaw);
  const base = { httpStatus: response.status, ms, remaining, retryAfter, retryAfterRaw };

  if (!response.ok) {
    const kind = classifyHttpStatus(response.status, response.headers);
    const outcome = { ...base, detail: text.trim().slice(0, 200), kind };
    if (kind === 'rate-limited') {
      // The gateway omits Retry-After only when the key is blocked outright (no refill to wait for).
      outcome.blocked = retryAfterRaw === null;
    }
    return outcome;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...base, detail: 'response is not JSON', kind: 'bad-response' };
  }
  if (body === null || typeof body !== 'object' || body.jsonrpc !== '2.0') {
    return { ...base, detail: 'not a JSON-RPC 2.0 response', kind: 'bad-response' };
  }
  if (body.error != null) {
    const message = typeof body.error.message === 'string' ? body.error.message : JSON.stringify(body.error);
    return { ...base, code: body.error.code, detail: message.slice(0, 200), kind: 'rpc-error' };
  }
  if (body.id !== id) {
    return { ...base, detail: `response id ${String(body.id)} does not match request ${id}`, kind: 'bad-response' };
  }
  if (body.result === undefined) {
    return { ...base, detail: 'response has no result', kind: 'bad-response' };
  }
  return { ...base, kind: 'ok', result: body.result };
}

/**
 * Submit one commitment. On `ok`, `status` holds the aggregator's status
 * string; `accepted` is true only for SUCCESS.
 *
 * @param {string} url
 * @param {string} apiKey
 * @param {import('./commitment.js').Commitment} commitment
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
export async function submitCommitment(url, apiKey, commitment, signal) {
  const outcome = await rpc(
    url,
    'certification_request',
    commitment.params,
    { 'X-API-Key': apiKey, 'X-State-ID': commitment.stateId },
    signal,
  );
  if (outcome.kind !== 'ok') {
    return outcome;
  }
  const status = outcome.result && typeof outcome.result.status === 'string' ? outcome.result.status : null;
  if (status === null) {
    return { ...outcome, detail: 'result has no status', kind: 'bad-response' };
  }
  return { ...outcome, accepted: status === 'SUCCESS', result: undefined, status };
}

/**
 * Ask for a state's inclusion proof. On `ok`, `included` says whether the
 * aggregator has certified the state, and `shard` is the shard (bit string) of
 * the round it answered from. The proof itself is not kept or verified.
 *
 * @param {string} url
 * @param {string} apiKey
 * @param {string} stateId Hex.
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
export async function pollInclusionProof(url, apiKey, stateId, signal) {
  const outcome = await rpc(url, 'get_inclusion_proof.v2', { stateId }, apiKey ? { 'X-API-Key': apiKey } : {}, signal);
  if (outcome.kind !== 'ok') {
    return outcome;
  }
  if (typeof outcome.result !== 'string') {
    return { ...outcome, detail: 'result is not a hex string', kind: 'bad-response', result: undefined };
  }
  try {
    const response = InclusionProofResponse.fromCBOR(HexConverter.decode(outcome.result));
    return {
      ...outcome,
      included: response.inclusionProof !== null,
      result: undefined,
      shard: response.unicityCertificate.shardTreeCertificate.shard.toString(),
    };
  } catch (error) {
    return { ...outcome, detail: `undecodable proof: ${String(error?.message ?? error)}`, kind: 'bad-response', result: undefined };
  }
}

/**
 * The network's shard prefixes from `GET /config/shards`.
 *
 * @param {string} url
 * @param {number} [timeoutMs] Limit for the whole exchange, body included.
 * @returns {Promise<{mode: string, prefixes: string[]}>}
 * @throws {Error} When the configuration cannot be fetched in time or is not understood.
 */
export async function fetchShardConfig(url, timeoutMs = 10_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${url}/config/shards`, { cache: 'no-store', redirect: 'error', signal });
  if (!response.ok) {
    throw new Error(`GET /config/shards answered ${response.status}`);
  }
  const body = await response.json();
  if (body?.mode === 'bft-shard' && Array.isArray(body.bftShardPrefixes)) {
    const prefixes = body.bftShardPrefixes.filter((p) => typeof p === 'string' && /^[01]*$/.test(p));
    return { mode: body.mode, prefixes };
  }
  return { mode: String(body?.mode ?? 'unknown'), prefixes: [] };
}
