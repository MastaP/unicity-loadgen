# Unicity load generator — design

Date: 2026-11-25

## Why

Put controllable certification load on a Unicity network (testnet2 or mainnet)
through the subscription gateway (SGW), in order to:

- see whether, and how hard, an API key is being rate limited;
- simulate network utilization over longer runs;
- exercise the public network status page (`GET /network/status`, per-shard
  rounds with `totalCommitments`) and check it reflects the load sent;
- make SGW metrics record the full request cycle: submission, then inclusion
  proof retrieval.

## Goals

- One self-contained `index.html` that works opened from disk (`file://`).
- Network choice: testnet (`https://gateway.testnet2.unicity.network`) or
  mainnet (`https://gateway.mainnet.unicity.network`), each with its own API key.
- User sets: **period** (run length; 0 = until stopped), **frequency** (interval
  between sends, seconds, fractional allowed), and a **min–max range**; each send
  submits a random count of commitments drawn from that range.
- Every commitment uses a fresh random secp256k1 key pair, a random source state
  hash and a random transaction hash, and is correctly signed, so the aggregator
  accepts it.
- After an accepted submission, poll `get_inclusion_proof.v2` until the proof
  is present, then discard it.
- Show rate limiting and the effect on the network as it happens.

## Non-goals

- Verifying inclusion proofs against a trust base. The proof is decoded only to
  tell "certified" from "not yet"; then dropped.
- Storing anything beyond the API keys and the last-used settings.
- Token minting/transfers; these are bare certification requests.

## Anti-goals

- Requests that differ from what real SDK clients send. The page builds them
  with the SDK's own code.
- Quietly blending rate-limit rejections into generic errors.
- Starting a mainnet run by accident (accepted mainnet commitments are permanent).

## Constraints (checked against the live gateways)

- Both gateways speak the SDK 3.0.1 protocol (`certification_request` with
  CertificationData v2, `get_inclusion_proof.v2`).
- CORS echoes any origin including `null`, allows `X-API-Key` / `X-State-ID`, and
  exposes `X-RateLimit-Remaining` and `Retry-After`.
- No batch RPC: one HTTP request per commitment, plus one per proof poll.
- Gateway outcomes: 401 bad/missing key, 402 subscription expired, 429 rate
  limited (`Retry-After` present = transient; absent = key blocked), 503
  overloaded (`Retry-After: 1`) or maintenance (`X-Maintenance` marker). Accepted
  requests carry `X-RateLimit-Remaining`.
- Shard topology from `GET /config/shards` (`bftShardPrefixes`: testnet
  `000`–`111`, mainnet `00`–`11`). A commitment's shard is the leading bits of
  its state ID (SHA-256 of `[lockScript, sourceStateHash]`).

## Approaches considered

1. **Single HTML file with the SDK bundled inline (chosen).** esbuild bundles
   `@unicitylabs/state-transition-sdk@3.0.1` (with `@noble/curves`) into one
   inline script. Byte-exact with real clients, works offline, rebuildable.
2. CDN imports (esm.sh etc.): small source, but not self-contained and depends
   on a third-party CDN at runtime.
3. Hand-written CBOR + secp256k1: no build step, but risks wire mismatches and
   rolls its own crypto.
4. Node CLI: not a webpage.

## Behaviour

- **Pacing:** sends fire on a fixed schedule (drift corrected), independent of
  earlier replies, so the offered load is what was set. A send's commitments are
  submitted concurrently. The clock runs in a dedicated worker, because
  main-thread timers in a hidden tab are throttled to 1/s and then 1/min. If the
  page still falls more than one interval behind, the missed sends are skipped
  (and counted) rather than burst.
- **Shard targeting:** shard checkboxes loaded from `/config/shards`, all ticked
  by default. Each commitment re-rolls its random source state hash until its
  state ID falls in a ticked shard (expected ≤ 8 tries on testnet).
- **Proof polling:** after `SUCCESS`, first poll after ~1 s, then every 1 s,
  until the proof is present or 60 s pass (counted as "proof timeout"). On Stop
  or period end, new sends stop and outstanding polls finish (a second Stop
  aborts them).
- **Stops the run:** 401 or 402 (every further request would fail the same way).
- **Mainnet:** a confirmation dialog before each run.
- **API keys:** one field per network, saved in the browser's `localStorage`
  with the other settings. Sent as `X-API-Key` on both RPCs.

## Display

- Totals: sent, accepted, included (proof received), rate-limited (429), errors,
  proofs pending, proof timeouts. Errors are broken down by cause: other
  aggregator statuses (by status string), 401/402, 503 overloaded/maintenance,
  network, JSON-RPC errors, malformed responses.
- A proof served by a different shard than the one the commitment was built for
  is counted as a shard mismatch.
- Rate-limit panel: last `X-RateLimit-Remaining`, last `Retry-After`, and
  whether the key is blocked (429 with no `Retry-After`).
- Per-second chart, last 5 minutes: accepted/s, included/s and rate-limited/s
  (errors/s in the hover tooltip; three lines keeps within the colour-safe set).
- Per-shard table: accepted in the last 10 s / 60 s, included, submit→proof
  latency p50/p95.
- Log: the most recent ~200 events (time, #, shard, outcome, latency).

## Left to the builder

- Layout and styling; chart drawn with inline SVG or canvas (no libraries).
- Exact error text and log formatting.
- Build script location and shape (`loadgen/build/` with its own
  `package.json`, output `loadgen/index.html`).
