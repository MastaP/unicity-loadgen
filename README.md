# Unicity load generator

A single self-contained web page (`index.html`) that sends random, correctly signed
commitments to a Unicity network through its gateway, then fetches each one's inclusion
proof, so the gateway's metrics see the full request cycle.

Use it to see when an API key gets rate limited, to put steady load on a network, and to
check that the network status page reflects the load.

## Use

Open it at **https://mastap.github.io/unicity-loadgen/**, or open `index.html` from a
checkout in a browser (straight from disk is fine; no server needed).

1. Pick **Testnet** (`gateway.testnet2.unicity.network`) or **Mainnet**
   (`gateway.mainnet.unicity.network`) and enter that network's API key. Each network
   keeps its own key in this browser's local storage. Keys never leave the browser except
   as the `X-API-Key` header to that network's gateway. Local storage is per origin, and
   on GitHub Pages every project page of the same owner shares `mastap.github.io`; use the
   file from disk if that matters for your key.
2. Untick shards to aim the load at some of them only (all are ticked by default).
3. Set the **period** (minutes; 0 runs until you stop it), how often to send, and the
   range of commitments per send. Each send picks a random count from the range.
4. **Start**. Mainnet asks for confirmation first: accepted mainnet commitments are permanent.

**Stop** stops new sends and waits for proofs still due; **Stop now** drops them. A 401
(bad key) or 402 (expired subscription) stops the run by itself.

Keep the tab open during a run. The pace is driven from a worker, so it holds in a
background tab.

## What it shows

- Totals: sent, accepted, included, rate-limited (429), errors, proofs pending, proof timeouts.
- Rate limit: the last `X-RateLimit-Remaining` and `Retry-After`, and whether the key is
  throttled or blocked (a 429 without `Retry-After`).
- Timing: submit round trip and accepted→proof time (p50/p95).
- Accepted, included and rate-limited per second over the last five minutes.
- Per shard: accepted in the last 10 s / 60 s, total, included, proof latency.
- Everything that was not accepted, by cause, and a log of the last 200 events.

A burst of "Network error" under heavy load can be the gateway shedding the browser's CORS
preflight (`OPTIONS`) with a 503: the browser then reports a failed fetch, not the 503.

## How a commitment is made

Each commitment has a fresh secp256k1 key pair, a random source state hash and a random
transaction hash, signed and encoded with `@unicitylabs/state-transition-sdk` (bundled into
the page), and is sent as `certification_request` with `X-API-Key` and `X-State-ID`. To aim
at a shard, the source state is re-rolled until the state ID's leading bits match a ticked
shard prefix from `GET /config/shards`. After acceptance, `get_inclusion_proof.v2` is
called a second later and then every second until the proof is there (or 60 s pass); the
proof is decoded only to see that it exists, then dropped.

## Develop

```sh
npm ci
npm run build          # src/ → index.html
npm test               # unit tests
npm run test:live      # live checks against both gateways (read-only on mainnet)
npm run test:browser   # drives index.html in headless Chromium
```

`LOADGEN_TESTNET_KEY=<key>` makes `test:live` and `test:browser` also submit to testnet and
wait for the proofs. `test:browser` uses the newest Playwright-managed Chromium in
`~/.cache/ms-playwright` (or `CHROMIUM=/path/to/chrome`); supply missing system libraries
with `LD_LIBRARY_PATH` if needed. `test/fixtures/make-certified.mjs` regenerates the
certified-proof fixture.

`index.html` is a build output but is committed, so the page can be used without building.
GitHub Pages serves it as is from the root of `main` (`.nojekyll` turns off Jekyll), so
rebuild and commit it with any change to `src/`. The build appends the license notices of
the bundled packages as an HTML comment.
See `DESIGN.md` for the reasoning behind the behaviour.
