/** Seconds of per-second history kept (the chart shows the last 300). */
const HISTORY_SECONDS = 600;
/** Latency samples kept per series for percentiles. */
const LATENCY_SAMPLES = 2000;
/** Distinct failure details kept; later new ones are counted under one overflow entry. */
export const MAX_FAILURE_DETAILS = 50;
export const OVERFLOW_DETAIL = '(other details)';

/** Labels for failure kinds, as the page shows them. */
export const KIND_LABELS = {
  'bad-response': 'Malformed response',
  'client-error': 'Page error',
  expired: 'Subscription expired (402)',
  http: 'Other HTTP status',
  maintenance: 'Maintenance (503)',
  network: 'Network error',
  'not-found': 'Not found (404)',
  overloaded: 'Gateway overloaded (503)',
  'rate-limited': 'Rate limited (429)',
  'rpc-error': 'JSON-RPC error',
  unauthorized: 'API key rejected (401)',
};

/** Fixed-size sample buffer that keeps the most recent values. */
class Samples {
  constructor(size = LATENCY_SAMPLES) {
    this.size = size;
    this.values = [];
    this.next = 0;
  }

  /**
   * @param {number} value
   */
  push(value) {
    if (this.values.length < this.size) {
      this.values.push(value);
    } else {
      this.values[this.next] = value;
      this.next = (this.next + 1) % this.size;
    }
  }

  /**
   * @param {number} p Percentile, 0–100.
   * @returns {number|null}
   */
  percentile(p) {
    if (this.values.length === 0) {
      return null;
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  }
}

/**
 * Counters and short histories for one run.
 */
export class Stats {
  constructor() {
    this.sent = 0;
    this.accepted = 0;
    this.included = 0;
    this.rateLimited = 0;
    this.proofTimeouts = 0;
    this.abandoned = 0;
    this.missedSends = 0;
    this.shardMismatches = 0;
    this.proofPolls = 0;
    /** Submission failures other than 429, by kind. @type {Map<string, number>} */
    this.failures = new Map();
    /** Failure details, by "kind: detail". @type {Map<string, number>} */
    this.failureDetails = new Map();
    /** Aggregator statuses other than SUCCESS. @type {Map<string, number>} */
    this.statuses = new Map();
    /** Proof requests that failed, by kind. @type {Map<string, number>} */
    this.pollFailures = new Map();

    this.lastRemaining = null;
    this.lastRemainingAt = null;
    this.lastRetryAfter = null;
    this.lastRetryAfterAt = null;
    this.lastRateLimitedAt = null;
    this.keyBlocked = false;

    /** Per-second buckets keyed by Unix second. @type {Map<number, {accepted: number, limited: number, errors: number, included: number}>} */
    this.seconds = new Map();
    /** @type {Map<string, {accepted: Map<number, number>, acceptedTotal: number, included: number, timeouts: number, latency: Samples}>} */
    this.shards = new Map();
    this.submitLatency = new Samples();
    this.proofLatency = new Samples();
  }

  /** @returns {number} Submissions that ended in anything but SUCCESS or 429. */
  get errors() {
    let n = 0;
    for (const count of this.failures.values()) {
      n += count;
    }
    for (const count of this.statuses.values()) {
      n += count;
    }
    return n;
  }

  /**
   * @param {number} now
   * @returns {{accepted: number, limited: number, errors: number, included: number}}
   */
  bucket(now) {
    const second = Math.floor(now / 1000);
    let bucket = this.seconds.get(second);
    if (!bucket) {
      bucket = { accepted: 0, errors: 0, included: 0, limited: 0 };
      this.seconds.set(second, bucket);
      for (const key of this.seconds.keys()) {
        if (key > second - HISTORY_SECONDS) {
          break;
        }
        this.seconds.delete(key);
      }
    }
    return bucket;
  }

  /**
   * @param {string|null} shard
   * @returns {object}
   */
  shard(shard) {
    const key = shard ?? '';
    let entry = this.shards.get(key);
    if (!entry) {
      entry = { accepted: new Map(), acceptedTotal: 0, included: 0, latency: new Samples(), timeouts: 0 };
      this.shards.set(key, entry);
    }
    return entry;
  }

  countSent() {
    this.sent++;
  }

  countAbandoned() {
    this.abandoned++;
  }

  /**
   * @param {number} n
   */
  countMissedSends(n) {
    this.missedSends += n;
  }

  countShardMismatch() {
    this.shardMismatches++;
  }

  /**
   * @param {string|null} shard
   */
  countProofTimeout(shard) {
    this.proofTimeouts++;
    this.shard(shard).timeouts++;
  }

  /**
   * @param {number} now
   * @param {string|null} shard
   * @param {object} outcome Result of submitCommitment.
   */
  recordSubmit(now, shard, outcome) {
    if (outcome.remaining != null) {
      this.lastRemaining = outcome.remaining;
      this.lastRemainingAt = now;
    }
    if (outcome.httpStatus !== undefined) {
      this.submitLatency.push(outcome.ms);
    }

    const bucket = this.bucket(now);
    if (outcome.kind === 'ok' && outcome.accepted) {
      this.accepted++;
      bucket.accepted++;
      const entry = this.shard(shard);
      const second = Math.floor(now / 1000);
      entry.accepted.set(second, (entry.accepted.get(second) ?? 0) + 1);
      entry.acceptedTotal++;
      for (const key of entry.accepted.keys()) {
        if (key > second - 60) {
          break;
        }
        entry.accepted.delete(key);
      }
      // An accepted request proves the key is not blocked any more.
      this.keyBlocked = false;
      return;
    }

    if (outcome.kind === 'ok') {
      this.statuses.set(outcome.status, (this.statuses.get(outcome.status) ?? 0) + 1);
      bucket.errors++;
      return;
    }

    if (outcome.kind === 'rate-limited') {
      this.rateLimited++;
      bucket.limited++;
      this.lastRateLimitedAt = now;
      this.keyBlocked = outcome.blocked === true;
      if (outcome.retryAfterRaw != null) {
        this.lastRetryAfter = outcome.retryAfter ?? outcome.retryAfterRaw;
        this.lastRetryAfterAt = now;
      }
      return;
    }

    bucket.errors++;
    this.failures.set(outcome.kind, (this.failures.get(outcome.kind) ?? 0) + 1);
    let detailKey = outcome.detail ? `${outcome.kind}: ${outcome.detail}` : outcome.kind;
    if (!this.failureDetails.has(detailKey) && this.failureDetails.size >= MAX_FAILURE_DETAILS) {
      detailKey = OVERFLOW_DETAIL;
    }
    this.failureDetails.set(detailKey, (this.failureDetails.get(detailKey) ?? 0) + 1);
  }

  /**
   * @param {object} outcome Result of pollInclusionProof.
   */
  recordPoll(outcome) {
    this.proofPolls++;
    if (outcome.kind !== 'ok' && outcome.kind !== 'not-found') {
      this.pollFailures.set(outcome.kind, (this.pollFailures.get(outcome.kind) ?? 0) + 1);
    }
  }

  /**
   * @param {number} now
   * @param {string|null} shard
   * @param {number} latencyMs Acceptance to proof.
   */
  recordIncluded(now, shard, latencyMs) {
    this.included++;
    this.bucket(now).included++;
    const entry = this.shard(shard);
    entry.included++;
    entry.latency.push(latencyMs);
    this.proofLatency.push(latencyMs);
  }

  /**
   * Accepted commitments for `shard` in the `windowSeconds` seconds up to `now`.
   *
   * @param {string|null} shard
   * @param {number} now
   * @param {number} windowSeconds At most 60.
   * @returns {number}
   */
  acceptedIn(shard, now, windowSeconds) {
    const entry = this.shards.get(shard ?? '');
    if (!entry) {
      return 0;
    }
    const second = Math.floor(now / 1000);
    let n = 0;
    for (const [key, count] of entry.accepted) {
      if (key > second - windowSeconds) {
        n += count;
      }
    }
    return n;
  }

  /**
   * The last `count` seconds up to `now`, oldest first, zero-filled.
   *
   * @param {number} now
   * @param {number} count
   * @returns {Array<{second: number, accepted: number, limited: number, errors: number, included: number}>}
   */
  series(now, count) {
    const last = Math.floor(now / 1000);
    const out = [];
    for (let second = last - count + 1; second <= last; second++) {
      const bucket = this.seconds.get(second);
      out.push({ second, ...(bucket ?? { accepted: 0, errors: 0, included: 0, limited: 0 }) });
    }
    return out;
  }
}
