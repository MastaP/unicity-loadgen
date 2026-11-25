import { Stats } from './stats.js';

/** Delay between an accepted submission and its first proof request, and between proof requests. */
export const PROOF_POLL_INTERVAL_MS = 1000;
/** How long after acceptance a proof may take before the commitment counts as a proof timeout. */
export const PROOF_TIMEOUT_MS = 60_000;

/** Submission outcomes after which every further submission would fail the same way. */
const FATAL_KINDS = new Set(['expired', 'unauthorized']);

/**
 * Uniform random integer in [min, max].
 *
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomInt(min, max) {
  const span = max - min + 1;
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return min + (buf[0] % span);
}

/**
 * One load run. The caller drives it by calling `tick(now)` often (every few
 * tens of milliseconds); all timing decisions are made against that `now`, so
 * a fake clock can drive it in tests.
 *
 * Phases: `running` (sending on schedule) → `draining` (no new sends; waiting
 * for submissions and proofs already under way) → `done`.
 */
export class LoadRun {
  /**
   * @param {object} options
   * @param {number} options.intervalMs  Time between sends.
   * @param {number} options.periodMs    Run length; 0 runs until stopped.
   * @param {number} options.min         Fewest commitments per send.
   * @param {number} options.max         Most commitments per send.
   * @param {string[]} options.targets   Shard prefixes to aim at; empty for any.
   * @param {string[]} options.allShards All shard prefixes of the network.
   * @param {object} options.transport   `{ build(targets, allShards), submit(commitment, signal), poll(stateId, signal) }`.
   * @param {(event: object) => void} [options.onEvent] Called for every logged event.
   * @param {(run: LoadRun) => void} [options.onPhase] Called when the phase changes.
   * @param {(n: number) => number} [options.pickCount] Override for the per-send count picker (tests).
   */
  constructor(options) {
    this.intervalMs = options.intervalMs;
    this.periodMs = options.periodMs;
    this.min = options.min;
    this.max = options.max;
    this.targets = options.targets;
    this.allShards = options.allShards;
    this.transport = options.transport;
    this.onEvent = options.onEvent ?? (() => {});
    this.onPhase = options.onPhase ?? (() => {});
    this.pickCount = options.pickCount ?? (() => randomInt(this.min, this.max));

    this.stats = new Stats();
    this.phase = 'idle';
    this.stopReason = null;
    this.startedAt = null;
    this.endsAt = null;
    this.endedAt = null;
    this.nextSendAt = null;
    this.sendCount = 0;
    this.seq = 0;
    this.inFlightSubmits = 0;
    /** Set by "Stop now": nothing new is waited for; the run ends once aborted requests settle. */
    this.abandoning = false;
    /** @type {Map<string, {shard: string|null, seq: number, acceptedAt: number, nextPollAt: number, deadline: number, polling: boolean}>} */
    this.pending = new Map();
    this.abortController = new AbortController();
  }

  /**
   * @param {number} now
   */
  start(now) {
    if (this.phase !== 'idle') {
      throw new Error('A run can only be started once.');
    }
    this.startedAt = now;
    this.endsAt = this.periodMs > 0 ? now + this.periodMs : null;
    this.nextSendAt = now;
    this.setPhase('running');
    this.tick(now);
  }

  /**
   * First call: stop sending and let work under way finish. Second call: abandon it.
   *
   * @param {number} now
   * @param {string} [reason]
   */
  stop(now, reason = 'stopped') {
    if (this.phase === 'running') {
      this.stopReason = reason;
      this.setPhase('draining');
      this.maybeFinish(now);
    } else if (this.phase === 'draining') {
      this.abandon(now);
    }
  }

  /**
   * Drop everything under way: cancel open requests and stop waiting for
   * proofs. The run ends as soon as the cancelled submissions have settled
   * (immediately when none are open), so the final numbers include them.
   *
   * @param {number} now
   */
  abandon(now) {
    if (this.phase === 'done' || this.phase === 'idle') {
      return;
    }
    this.stopReason = this.stopReason ?? 'stopped';
    this.abandoning = true;
    if (this.phase === 'running') {
      this.setPhase('draining');
    }
    this.abortController.abort();
    for (const [stateId, entry] of this.pending) {
      this.stats.countAbandoned();
      this.log(now, { kind: 'abandoned', seq: entry.seq, shard: entry.shard, stateId });
    }
    this.pending.clear();
    this.maybeFinish(now);
  }

  /**
   * Advance the run to `now`: fire a due send and any due proof requests.
   *
   * @param {number} now
   */
  tick(now) {
    if (this.phase === 'running') {
      if (this.endsAt !== null && now >= this.endsAt) {
        this.stopReason = 'period over';
        this.setPhase('draining');
      } else if (now >= this.nextSendAt) {
        // Fixed schedule. If the page fell more than one interval behind (a
        // frozen tab, a long GC), skip the missed sends rather than burst them.
        const behind = now - this.nextSendAt;
        if (behind >= this.intervalMs) {
          const missed = Math.floor(behind / this.intervalMs);
          this.stats.countMissedSends(missed);
          this.nextSendAt += missed * this.intervalMs;
        }
        this.nextSendAt += this.intervalMs;
        this.fireSend();
      }
    }

    if (this.phase === 'running' || this.phase === 'draining') {
      for (const [stateId, entry] of this.pending) {
        // The deadline holds even while a proof request is still open; its late answer is ignored.
        if (now >= entry.deadline) {
          this.timeOut(now, stateId, entry);
        } else if (!entry.polling && now >= entry.nextPollAt) {
          this.firePoll(stateId, entry);
        }
      }
      this.maybeFinish(now);
    }
  }

  fireSend() {
    const count = this.pickCount();
    this.sendCount++;
    for (let i = 0; i < count; i++) {
      this.submitOne();
    }
  }

  async submitOne() {
    const seq = ++this.seq;
    this.inFlightSubmits++;
    this.stats.countSent();
    let commitment;
    let outcome;
    try {
      commitment = await this.transport.build(this.targets, this.allShards);
      outcome = await this.transport.submit(commitment, this.abortController.signal);
    } catch (error) {
      outcome = { detail: String(error?.message ?? error), kind: 'client-error', ms: 0 };
    }
    this.inFlightSubmits--;
    const now = this.transport.now();
    if (outcome.kind === 'aborted') {
      this.stats.countAbandoned();
      this.maybeFinish(now);
      return;
    }

    const shard = commitment?.shard ?? null;
    this.stats.recordSubmit(now, shard, outcome);
    this.log(now, { ...outcome, op: 'submit', seq, shard, stateId: commitment?.stateId });

    if (outcome.kind === 'ok' && outcome.accepted) {
      if (this.abandoning || this.phase === 'done') {
        // Accepted just before "Stop now" cancelled it; its proof is no longer waited for.
        this.stats.countAbandoned();
        this.log(now, { kind: 'abandoned', seq, shard, stateId: commitment.stateId });
        this.maybeFinish(now);
        return;
      }
      this.pending.set(commitment.stateId, {
        acceptedAt: now,
        deadline: now + PROOF_TIMEOUT_MS,
        nextPollAt: now + PROOF_POLL_INTERVAL_MS,
        polling: false,
        seq,
        shard,
      });
    } else if (FATAL_KINDS.has(outcome.kind) && this.phase === 'running') {
      this.stop(now, outcome.kind === 'unauthorized' ? 'API key rejected (401)' : 'subscription expired (402)');
    }
    this.maybeFinish(now);
  }

  /**
   * @param {string} stateId
   * @param {object} entry
   */
  async firePoll(stateId, entry) {
    entry.polling = true;
    let outcome;
    try {
      outcome = await this.transport.poll(stateId, this.abortController.signal);
    } catch (error) {
      outcome = { detail: String(error?.message ?? error), kind: 'client-error', ms: 0 };
    }
    entry.polling = false;
    const now = this.transport.now();
    if (outcome.kind === 'aborted' || this.pending.get(stateId) !== entry) {
      // Cancelled, or already timed out / dropped while the request was open.
      return;
    }

    this.stats.recordPoll(outcome);
    if (now >= entry.deadline) {
      this.timeOut(now, stateId, entry);
      this.maybeFinish(now);
      return;
    }
    if (outcome.kind === 'ok' && outcome.included) {
      this.pending.delete(stateId);
      const latency = now - entry.acceptedAt;
      this.stats.recordIncluded(now, entry.shard, latency);
      this.log(now, { kind: 'included', ms: latency, proofShard: outcome.shard, seq: entry.seq, shard: entry.shard, stateId });
      if (entry.shard !== null && outcome.shard !== undefined && outcome.shard !== entry.shard) {
        this.stats.countShardMismatch();
      }
    } else if (outcome.kind !== 'ok' && outcome.kind !== 'not-found') {
      this.log(now, { ...outcome, op: 'proof', seq: entry.seq, shard: entry.shard, stateId });
    }

    if (this.pending.has(stateId)) {
      entry.nextPollAt = now + PROOF_POLL_INTERVAL_MS;
    }
    this.maybeFinish(now);
  }

  /**
   * @param {number} now
   * @param {string} stateId
   * @param {object} entry
   */
  timeOut(now, stateId, entry) {
    this.pending.delete(stateId);
    this.stats.countProofTimeout(entry.shard);
    this.log(now, { kind: 'proof-timeout', seq: entry.seq, shard: entry.shard, stateId });
  }

  /**
   * @param {number} now
   */
  maybeFinish(now) {
    if (this.phase === 'draining' && this.inFlightSubmits === 0 && this.pending.size === 0) {
      this.finish(now);
    }
  }

  /**
   * @param {number} now
   */
  finish(now) {
    if (this.phase === 'done') {
      return;
    }
    this.endedAt = now;
    this.setPhase('done');
  }

  /**
   * @param {string} phase
   */
  setPhase(phase) {
    this.phase = phase;
    this.onPhase(this);
  }

  /**
   * @param {number} now
   * @param {object} event
   */
  log(now, event) {
    this.onEvent({ ...event, at: now });
  }
}
