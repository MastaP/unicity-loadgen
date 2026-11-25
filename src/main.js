import { buildCommitment } from './commitment.js';
import { LoadRun } from './engine.js';
import { fetchShardConfig, NETWORKS, pollInclusionProof, submitCommitment } from './gateway.js';
import { KIND_LABELS } from './stats.js';

const STORAGE_KEY = 'unicity-loadgen:v1';
const LOG_LIMIT = 200;
const CHART_SECONDS = 300;
const RENDER_EVERY_MS = 250;
const CLOCK_MS = 20;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- settings

const DEFAULT_SETTINGS = {
  countMax: 10,
  countMin: 1,
  intervalSec: 1,
  keys: { mainnet: '', testnet: '' },
  network: 'testnet',
  periodMin: 5,
  /** Unticked shard prefixes per network; everything else is ticked. */
  unticked: { mainnet: [], testnet: [] },
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Settings from a stored JSON string, each field checked for shape so a
 * damaged entry falls back to its default instead of breaking the page.
 */
function parseSettings(text) {
  const out = structuredClone(DEFAULT_SETTINGS);
  let raw = null;
  try {
    raw = JSON.parse(text ?? 'null');
  } catch {
    return out;
  }
  if (!isObject(raw)) {
    return out;
  }
  for (const field of ['countMax', 'countMin', 'intervalSec', 'periodMin']) {
    if (Number.isFinite(raw[field])) {
      out[field] = raw[field];
    }
  }
  if (typeof raw.network === 'string' && NETWORKS[raw.network]) {
    out.network = raw.network;
  }
  for (const network of Object.keys(NETWORKS)) {
    if (isObject(raw.keys) && typeof raw.keys[network] === 'string') {
      out.keys[network] = raw.keys[network];
    }
    if (isObject(raw.unticked) && Array.isArray(raw.unticked[network])) {
      out.unticked[network] = raw.unticked[network].filter((p) => typeof p === 'string');
    }
  }
  return out;
}

function loadSettings() {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

const settings = loadSettings();

/**
 * Another tab saved its settings. Take them over in memory so this tab's next
 * save does not write back a stale copy (e.g. erase a key entered over there).
 * The fields on screen are left alone; a run reads them when it starts.
 */
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY || event.newValue === null) {
    return;
  }
  const incoming = parseSettings(event.newValue);
  const network = settings.network;
  // Keep what this tab is showing: its network and that network's shard ticks.
  Object.assign(settings, incoming, { network, unticked: { ...incoming.unticked, [network]: settings.unticked[network] } });
});

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode, file:// restrictions); settings then last for this visit only.
  }
}

// ---------------------------------------------------------------- state

/** Shard prefixes of the selected network, as the gateway reported them. */
let shardPrefixes = [];
let shardLoad = null;
/** @type {LoadRun|null} */
let run = null;
let runNetwork = null;
/** Newest last. */
let logEntries = [];
let lastRender = 0;
let hoverIndex = null;

// ---------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat();

function fmt(n) {
  return n == null ? '–' : nf.format(n);
}

function fmtMs(ms) {
  if (ms == null) {
    return '–';
  }
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function ago(at, now) {
  if (at == null) {
    return '';
  }
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 2 ? 'just now' : `${s} s ago`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' })[c]);
}

function shardLabel(shard) {
  if (shard == null) {
    return '–';
  }
  return shard === '' ? '(single)' : shard;
}

// ---------------------------------------------------------------- form

function readForm() {
  const periodMin = Number($('periodMin').value);
  const intervalSec = Number($('intervalSec').value);
  const countMin = Number($('countMin').value);
  const countMax = Number($('countMax').value);
  const errors = [];
  if (!Number.isFinite(periodMin) || periodMin < 0) {
    errors.push('Period must be 0 or more minutes.');
  }
  if (!Number.isFinite(intervalSec) || intervalSec < 0.05) {
    errors.push('Send at most every 0.05 s.');
  }
  if (!Number.isInteger(countMin) || countMin < 1) {
    errors.push('Commitments per send must start at 1 or more.');
  }
  if (!Number.isInteger(countMax) || countMax < countMin) {
    errors.push('The upper count must be a whole number no smaller than the lower one.');
  }
  if (Number.isInteger(countMax) && countMax > 10_000) {
    errors.push('At most 10,000 commitments per send.');
  }
  return { countMax, countMin, errors, intervalSec, periodMin };
}

function selectedShards() {
  const unticked = new Set(settings.unticked[settings.network] ?? []);
  return shardPrefixes.filter((p) => !unticked.has(p));
}

function updateOffered() {
  const form = readForm();
  const out = $('offered');
  if (form.errors.length > 0) {
    out.textContent = '';
    $('formError').textContent = form.errors[0];
    return;
  }
  $('formError').textContent = '';
  const perSecond = (form.countMin + form.countMax) / 2 / form.intervalSec;
  const perSend = form.countMin === form.countMax ? `${fmt(form.countMin)}` : `${fmt(form.countMin)}–${fmt(form.countMax)}`;
  const rate = perSecond >= 10 ? Math.round(perSecond) : Number(perSecond.toFixed(2));
  const duration = form.periodMin > 0 ? `for ${form.periodMin} min` : 'until stopped';
  out.textContent = `${perSend} every ${form.intervalSec} s ≈ ${fmt(rate)} commitments/s ${duration}, plus about one proof request per accepted commitment per second until it is included.`;
}

function setFormEnabled(enabled) {
  for (const el of $('controls').querySelectorAll('input, #shardsAll, #shardsNone')) {
    el.disabled = !enabled;
  }
  $('toggleKey').disabled = false;
}

function renderShardChips() {
  const chips = $('shardChips');
  chips.textContent = '';
  const unticked = new Set(settings.unticked[settings.network] ?? []);
  for (const prefix of shardPrefixes) {
    const label = document.createElement('label');
    label.className = 'chip';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !unticked.has(prefix);
    box.disabled = run !== null && run.phase !== 'done';
    box.addEventListener('change', () => {
      const set = new Set(settings.unticked[settings.network] ?? []);
      if (box.checked) {
        set.delete(prefix);
      } else {
        set.add(prefix);
      }
      settings.unticked[settings.network] = [...set];
      saveSettings();
      updateShardNote();
    });
    label.append(box, document.createTextNode(shardLabel(prefix)));
    chips.append(label);
  }
  updateShardNote();
}

function updateShardNote() {
  const note = $('shardNote');
  if (shardLoad === 'loading') {
    note.textContent = 'Loading the shard list…';
  } else if (shardLoad === 'error') {
    note.textContent = 'Could not load the shard list; commitments will go to any shard.';
  } else if (shardPrefixes.length === 0) {
    note.textContent = 'This gateway publishes no BFT shard prefixes; commitments go to any shard.';
  } else {
    const n = selectedShards().length;
    note.textContent = n === shardPrefixes.length ? `All ${n} shards.` : `${n} of ${shardPrefixes.length} shards.`;
  }
}

async function selectNetwork(network) {
  settings.network = network;
  saveSettings();
  $(`net-${network}`).checked = true;
  $('gatewayUrl').textContent = NETWORKS[network].url;
  $('apiKey').value = settings.keys[network] ?? '';
  shardPrefixes = [];
  shardLoad = 'loading';
  renderShardChips();
  try {
    const config = await fetchShardConfig(NETWORKS[network].url);
    if (settings.network !== network) {
      return;
    }
    shardPrefixes = config.prefixes;
    shardLoad = 'ok';
  } catch {
    if (settings.network !== network) {
      return;
    }
    shardLoad = 'error';
  }
  renderShardChips();
}

// ---------------------------------------------------------------- run control

function startRun() {
  if (run !== null && run.phase !== 'done') {
    return;
  }
  if (shardLoad === 'loading') {
    $('formError').textContent = 'Still loading the shard list; try again in a moment.';
    return;
  }
  const form = readForm();
  if (form.errors.length > 0) {
    $('formError').textContent = form.errors[0];
    return;
  }
  const network = settings.network;
  const apiKey = $('apiKey').value.trim();
  if (apiKey === '') {
    $('formError').textContent = `Enter the ${NETWORKS[network].label.toLowerCase()} API key.`;
    return;
  }
  const chosen = selectedShards();
  if (shardPrefixes.length > 0 && chosen.length === 0) {
    $('formError').textContent = 'Tick at least one shard.';
    return;
  }
  if (network === 'mainnet') {
    const rate = (form.countMin + form.countMax) / 2 / form.intervalSec;
    const ok = window.confirm(
      `Send to MAINNET?\n\nAbout ${rate.toFixed(rate >= 10 ? 0 : 2)} commitments per second ` +
        `${form.periodMin > 0 ? `for ${form.periodMin} min` : 'until you stop it'}.\n\n` +
        'Every accepted commitment stays in the mainnet tree permanently.',
    );
    if (!ok) {
      return;
    }
  }

  const url = NETWORKS[network].url;
  const allTicked = chosen.length === shardPrefixes.length;
  logEntries = [];
  hoverIndex = null;
  runNetwork = network;
  let created = null;
  run = created = new LoadRun({
    allShards: shardPrefixes,
    intervalMs: form.intervalSec * 1000,
    max: form.countMax,
    min: form.countMin,
    onEvent: (event) => {
      if (run !== created) {
        return;
      }
      logEntries.push(event);
      if (logEntries.length > LOG_LIMIT * 2) {
        logEntries = logEntries.slice(-LOG_LIMIT);
      }
    },
    onPhase: () => {
      if (run !== created) {
        return;
      }
      updateControls();
      render(true);
    },
    periodMs: form.periodMin * 60_000,
    targets: allTicked ? [] : chosen,
    transport: {
      build: buildCommitment,
      now: () => Date.now(),
      poll: (stateId, signal) => pollInclusionProof(url, apiKey, stateId, signal),
      submit: (commitment, signal) => submitCommitment(url, apiKey, commitment, signal),
    },
  });
  run.start(Date.now());
  clock.start();
}

function updateControls() {
  const active = run !== null && run.phase !== 'done';
  setFormEnabled(!active);
  for (const box of $('shardChips').querySelectorAll('input')) {
    box.disabled = active;
  }
  $('startBtn').hidden = active;
  $('stopBtn').hidden = !active;
  $('stopBtn').textContent = run?.phase === 'draining' ? 'Stop now' : 'Stop';
  if (!active) {
    clock.stop();
  }
}

// ---------------------------------------------------------------- clock

/**
 * Drives the run. Timers in a dedicated worker keep firing at full rate in a
 * hidden tab, where main-thread timers are throttled to once a second or, after
 * a few minutes, once a minute.
 */
const clock = (() => {
  let worker = null;
  let fallback = null;
  const onTick = () => {
    const now = Date.now();
    if (run && run.phase !== 'done') {
      run.tick(now);
    }
    if (now - lastRender >= RENDER_EVERY_MS) {
      render(false);
    }
  };
  try {
    const source = 'let t=null;onmessage=(e)=>{clearInterval(t);t=null;if(e.data>0){t=setInterval(()=>postMessage(0),e.data);}};';
    worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.onmessage = onTick;
  } catch {
    worker = null;
  }
  return {
    start() {
      if (worker) {
        worker.postMessage(CLOCK_MS);
      } else if (fallback === null) {
        fallback = setInterval(onTick, CLOCK_MS);
      }
    },
    stop() {
      if (worker) {
        worker.postMessage(0);
      } else if (fallback !== null) {
        clearInterval(fallback);
        fallback = null;
      }
    },
    usesWorker: worker !== null,
  };
})();

// ---------------------------------------------------------------- rendering

function render(force) {
  const now = Date.now();
  if (!force && document.hidden) {
    return;
  }
  lastRender = now;
  renderBanner(now);
  if (!run) {
    return;
  }
  const s = run.stats;
  renderTiles(s, now);
  renderRateLimit(s, now);
  renderTiming(s);
  renderChart(s, now);
  renderShards(s, now);
  renderFailures(s);
  renderLog();
}

function setBanner(cls, text) {
  const banner = $('banner');
  banner.className = `banner ${cls}`;
  $('bannerText').textContent = text;
}

function renderBanner(now) {
  if (!run) {
    setBanner('', 'Ready. Nothing is being sent.');
    return;
  }
  const label = NETWORKS[runNetwork].label;
  const elapsed = fmtDuration((run.endedAt ?? now) - run.startedAt);
  if (run.phase === 'running') {
    const left = run.endsAt === null ? 'until stopped' : `${fmtDuration(run.endsAt - now)} left`;
    setBanner(runNetwork === 'mainnet' ? 'running mainnet-warn' : 'running', `Running on ${label} · ${elapsed} elapsed · ${left} · send #${fmt(run.sendCount)}`);
  } else if (run.phase === 'draining' && run.abandoning) {
    setBanner('draining', `Stopping now · cancelling ${fmt(run.inFlightSubmits)} open submissions`);
  } else if (run.phase === 'draining') {
    setBanner(
      'draining',
      `Stopping (${run.stopReason}) · waiting for ${fmt(run.pending.size)} proofs and ${fmt(run.inFlightSubmits)} submissions · press “Stop now” to drop them`,
    );
  } else if (run.phase === 'done') {
    const failed = run.stopReason?.includes('401') || run.stopReason?.includes('402');
    setBanner(failed ? 'failed' : '', `${failed ? 'Stopped' : 'Finished'} on ${label}: ${run.stopReason} · ran ${elapsed} · ${fmt(run.sendCount)} sends`);
  }
}

function pct(part, whole) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(part === whole || part === 0 ? 0 : 1)}%` : '';
}

function renderTiles(s, now) {
  const last10 = s.series(now, 10);
  const sum = (key) => last10.reduce((n, b) => n + b[key], 0);
  $('tSent').textContent = fmt(s.sent);
  $('tSentSub').textContent = s.abandoned > 0 ? `${fmt(s.abandoned)} dropped on stop` : `${fmt(run.sendCount)} sends`;
  $('tAccepted').textContent = fmt(s.accepted);
  $('tAcceptedSub').textContent = `${(sum('accepted') / 10).toFixed(1)}/s last 10 s`;
  $('tIncluded').textContent = fmt(s.included);
  $('tIncludedSub').textContent = s.accepted > 0 ? `${pct(s.included, s.accepted)} of accepted` : ' ';
  $('tLimited').textContent = fmt(s.rateLimited);
  $('tLimitedSub').textContent = s.sent > 0 ? `${pct(s.rateLimited, s.sent)} of sent` : ' ';
  $('tErrors').textContent = fmt(s.errors);
  $('tErrorsSub').textContent = s.errors > 0 ? 'see “Not accepted”' : ' ';
  $('tPending').textContent = fmt(run.pending.size);
  $('tPendingSub').textContent = run.inFlightSubmits > 0 ? `${fmt(run.inFlightSubmits)} submissions in flight` : ' ';
  $('tTimeouts').textContent = fmt(s.proofTimeouts);
}

function renderRateLimit(s, now) {
  let status;
  if (s.keyBlocked) {
    status = '<span class="pill bad">✕ Blocked</span> <span class="muted">429 without Retry-After</span>';
  } else if (s.lastRateLimitedAt !== null && now - s.lastRateLimitedAt < 10_000) {
    status = `<span class="pill warn">▲ Throttled</span> <span class="muted">last 429 ${ago(s.lastRateLimitedAt, now)}</span>`;
  } else if (s.accepted > 0 || s.lastRateLimitedAt !== null) {
    status = '<span class="pill ok">✓ Not limited</span> <span class="muted">no 429 in the last 10 s</span>';
  } else {
    status = '<span class="pill idle">no data</span>';
  }
  $('rKeyStatus').innerHTML = status;
  $('rRemaining').textContent = s.lastRemaining === null ? '–' : `${fmt(s.lastRemaining)} (${ago(s.lastRemainingAt, now)})`;
  const retry = typeof s.lastRetryAfter === 'number' ? `${fmt(s.lastRetryAfter)} s` : s.lastRetryAfter;
  $('rRetryAfter').textContent = s.lastRetryAfter === null ? '–' : `${retry} (${ago(s.lastRetryAfterAt, now)})`;
  const last10 = s.series(now, 10);
  const limited = last10.reduce((n, b) => n + b.limited, 0);
  const total = last10.reduce((n, b) => n + b.limited + b.accepted + b.errors, 0);
  $('rShare').textContent = total > 0 ? `${pct(limited, total)} (${fmt(limited)} of ${fmt(total)})` : '–';
}

function renderTiming(s) {
  const p = (samples) => {
    const p50 = samples.percentile(50);
    return p50 === null ? '–' : `p50 ${fmtMs(p50)} · p95 ${fmtMs(samples.percentile(95))}`;
  };
  $('lSubmit').textContent = p(s.submitLatency);
  $('lProof').textContent = p(s.proofLatency);
  const failed = [...s.pollFailures.values()].reduce((a, b) => a + b, 0);
  $('lPolls').textContent = `${fmt(s.proofPolls)}${failed > 0 ? ` (${fmt(failed)} failed)` : ''}`;
  $('lMissed').textContent = s.missedSends > 0 ? `${fmt(s.missedSends)} (page fell behind the schedule)` : '0';
}

/** A round tick step (1, 2, 2.5 or 5 × 10^k, at least 1) so that 4 steps cover `peak`. */
function tickStep(peak) {
  const raw = Math.max(1, peak / 4);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= raw && (step * magnitude) % 1 === 0) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
}

const SERIES = [
  { color: 'var(--series-accepted)', key: 'accepted', label: 'Accepted' },
  { color: 'var(--series-included)', key: 'included', label: 'Included' },
  { color: 'var(--series-limited)', key: 'limited', label: 'Rate-limited' },
];

function renderChart(s, now) {
  const host = $('chart');
  const width = Math.max(320, host.clientWidth);
  const height = host.clientHeight;
  const m = { bottom: 22, left: 44, right: 96, top: 10 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const data = s.series(now, CHART_SECONDS);
  // Seconds before the run started are not data; the lines begin at the start.
  const startSecond = Math.floor(run.startedAt / 1000);
  const first = Math.max(0, data.findIndex((b) => b.second >= startSecond));
  // The current second is still filling, so lines stop one second short of "now".
  const last = data.length - 2;
  let peak = 0;
  for (const b of data) {
    peak = Math.max(peak, b.accepted, b.included, b.limited);
  }
  const step = tickStep(peak);
  const yMax = step * 4;
  const x = (i) => m.left + (i / (CHART_SECONDS - 1)) * plotW;
  const y = (v) => m.top + plotH - (v / yMax) * plotH;

  const parts = [];
  for (let t = 0; t <= 4; t++) {
    const v = step * t;
    const yy = y(v).toFixed(1);
    parts.push(`<line x1="${m.left}" x2="${m.left + plotW}" y1="${yy}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/>`);
    parts.push(`<text x="${m.left - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${fmt(v)}</text>`);
  }
  for (let minute = 5; minute >= 0; minute--) {
    const i = CHART_SECONDS - 1 - minute * 60;
    const xx = x(Math.max(0, i)).toFixed(1);
    const anchor = minute === 0 ? 'end' : minute === 5 ? 'start' : 'middle';
    parts.push(`<text x="${xx}" y="${height - 6}" text-anchor="${anchor}">${minute === 0 ? 'now' : `−${minute} min`}</text>`);
  }

  if (last >= first) {
    for (const series of SERIES) {
      const points = [];
      for (let i = first; i <= last; i++) {
        points.push(`${x(i).toFixed(1)},${y(data[i][series.key]).toFixed(1)}`);
      }
      parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${series.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    }

    // End labels: each series' last value, spread 14 px apart and kept inside the plot.
    const labels = SERIES.map((series) => ({ label: series.label, v: data[last][series.key] }))
      .map((e) => ({ ...e, y: y(e.v) }))
      .sort((a, b) => a.y - b.y);
    const top = m.top + 6;
    const bottom = m.top + plotH - 6;
    for (let i = 0; i < labels.length; i++) {
      labels[i].y = Math.max(labels[i].y, i === 0 ? top : labels[i - 1].y + 14);
    }
    for (let i = labels.length - 1; i >= 0; i--) {
      labels[i].y = Math.min(labels[i].y, i === labels.length - 1 ? bottom : labels[i + 1].y - 14);
    }
    for (const e of labels) {
      parts.push(`<text class="end-label" x="${m.left + plotW + 8}" y="${e.y.toFixed(1)}" dominant-baseline="middle">${escapeHtml(e.label)} ${fmt(e.v)}</text>`);
    }
  }

  const hovering = hoverIndex !== null && hoverIndex >= first && hoverIndex <= last;
  if (hovering) {
    const hx = x(hoverIndex).toFixed(1);
    parts.push(`<line x1="${hx}" x2="${hx}" y1="${m.top}" y2="${m.top + plotH}" stroke="var(--text-tertiary)" stroke-width="1" stroke-dasharray="3 3"/>`);
    for (const series of SERIES) {
      const v = data[hoverIndex][series.key];
      parts.push(`<circle cx="${hx}" cy="${y(v).toFixed(1)}" r="4" fill="${series.color}" stroke="var(--surface-1)" stroke-width="2"/>`);
    }
  }
  parts.push(`<rect id="chartHit" x="${m.left}" y="${m.top}" width="${plotW}" height="${plotH}" fill="transparent"/>`);

  let svg = host.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Accepted, included and rate-limited commitments per second over the last five minutes');
    host.prepend(svg);
    svg.addEventListener('mousemove', (event) => {
      const rect = svg.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const w = Math.max(320, host.clientWidth) - 44 - 96;
      const i = Math.round(((px - 44) / w) * (CHART_SECONDS - 1));
      hoverIndex = i >= 0 && i < CHART_SECONDS - 1 ? i : null;
      if (run) {
        renderChart(run.stats, Date.now());
      }
    });
    svg.addEventListener('mouseleave', () => {
      hoverIndex = null;
      $('tooltip').style.display = 'none';
      if (run) {
        renderChart(run.stats, Date.now());
      }
    });
  }
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = parts.join('');

  const tip = $('tooltip');
  if (hovering) {
    const b = data[hoverIndex];
    const time = new Date(b.second * 1000).toLocaleTimeString();
    tip.innerHTML =
      `<div class="t">${escapeHtml(time)}</div>` +
      SERIES.map((series) => `<div class="r"><span><span class="swatch" style="background:${series.color}"></span>${series.label}</span><span>${fmt(b[series.key])}</span></div>`).join('') +
      `<div class="r"><span>Errors</span><span>${fmt(b.errors)}</span></div>`;
    tip.style.display = 'block';
    const hx = x(hoverIndex);
    const left = hx + 12 + 170 > width ? hx - 12 - tip.offsetWidth : hx + 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${m.top}px`;
  } else {
    tip.style.display = 'none';
  }
}

function renderShards(s, now) {
  const rows = [];
  const shards = shardPrefixes.length > 0 && runNetwork === settings.network ? shardPrefixes : [...s.shards.keys()];
  const targeted = new Set(run.targets.length > 0 ? run.targets : run.allShards);
  for (const shard of shards) {
    const entry = s.shards.get(shard);
    const p50 = entry?.latency.percentile(50) ?? null;
    const p95 = entry?.latency.percentile(95) ?? null;
    const off = run.allShards.length > 0 && !targeted.has(shard);
    rows.push(
      `<tr${off ? ' class="faint" title="Not targeted in this run"' : ''}><td class="mono">${escapeHtml(shardLabel(shard))}${off ? ' ○' : ''}</td>` +
        `<td class="num">${fmt(s.acceptedIn(shard, now, 10))}</td><td class="num">${fmt(s.acceptedIn(shard, now, 60))}</td>` +
        `<td class="num">${fmt(entry?.acceptedTotal ?? 0)}</td><td class="num">${fmt(entry?.included ?? 0)}</td>` +
        `<td class="num">${fmtMs(p50)}</td><td class="num">${fmtMs(p95)}</td></tr>`,
    );
  }
  $('shardRows').innerHTML = rows.join('') || '<tr><td colspan="7" class="empty">No shard data.</td></tr>';
  $('shardFoot').textContent = run.allShards.length > 0 && targeted.size < run.allShards.length ? '○ faded rows: not targeted in this run' : '';
}

function renderFailures(s) {
  const blocks = [];
  if (s.rateLimited > 0) {
    blocks.push(`<tr><td>${KIND_LABELS['rate-limited']}</td><td class="num">${fmt(s.rateLimited)}</td></tr>`);
  }
  for (const [status, count] of s.statuses) {
    blocks.push(`<tr><td>Aggregator status <span class="mono">${escapeHtml(status)}</span></td><td class="num">${fmt(count)}</td></tr>`);
  }
  for (const [kind, count] of s.failures) {
    blocks.push(`<tr><td>${escapeHtml(KIND_LABELS[kind] ?? kind)}</td><td class="num">${fmt(count)}</td></tr>`);
  }
  if (s.proofTimeouts > 0) {
    blocks.push(`<tr><td>Proof timeouts (accepted, no proof in 60 s)</td><td class="num">${fmt(s.proofTimeouts)}</td></tr>`);
  }
  for (const [kind, count] of s.pollFailures) {
    blocks.push(`<tr><td>Proof request: ${escapeHtml(KIND_LABELS[kind] ?? kind)}</td><td class="num">${fmt(count)}</td></tr>`);
  }
  if (s.shardMismatches > 0) {
    blocks.push(`<tr><td class="k-bad">Proof came from a different shard than expected</td><td class="num">${fmt(s.shardMismatches)}</td></tr>`);
  }
  if (blocks.length === 0) {
    $('failures').innerHTML = '<div class="empty">Nothing yet.</div>';
    return;
  }
  const details = [...s.failureDetails.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  // The block is redrawn several times a second; keep "Details" open if the user opened it.
  const open = $('failures').querySelector('details')?.open ? ' open' : '';
  $('failures').innerHTML =
    `<table><tbody>${blocks.join('')}</tbody></table>` +
    (details.length > 0
      ? `<details style="margin-top:10px"${open}><summary>Details</summary><table><tbody>${details
          .map(([text, count]) => `<tr><td class="mono" style="word-break:break-word">${escapeHtml(text)}</td><td class="num">${fmt(count)}</td></tr>`)
          .join('')}</tbody></table></details>`
      : '');
}

function describe(event) {
  switch (event.kind) {
    case 'ok':
      if (event.op === 'submit') {
        return event.accepted ? ['k-ok', 'accepted', ''] : ['k-bad', event.status, 'aggregator status'];
      }
      return ['', 'proof', ''];
    case 'included':
      return ['k-ok', 'included', event.proofShard !== undefined && event.proofShard !== event.shard && event.shard !== null ? `proof from shard ${event.proofShard}` : ''];
    case 'rate-limited':
      return ['k-warn', event.blocked ? '429 blocked' : '429', event.retryAfterRaw != null ? `Retry-After ${event.retryAfterRaw}` : 'no Retry-After'];
    case 'proof-timeout':
      return ['k-bad', 'proof timeout', 'no proof within 60 s'];
    case 'abandoned':
      return ['faint', 'dropped', 'stopped before the proof arrived'];
    default:
      return ['k-bad', `${event.op === 'proof' ? 'proof: ' : ''}${KIND_LABELS[event.kind] ?? event.kind}`, event.detail ?? ''];
  }
}

function renderLog() {
  const rows = [];
  const start = Math.max(0, logEntries.length - LOG_LIMIT);
  for (let i = logEntries.length - 1; i >= start; i--) {
    const e = logEntries[i];
    const [cls, what, detail] = describe(e);
    const time = new Date(e.at);
    const stamp = `${time.toLocaleTimeString([], { hour12: false })}.${String(time.getMilliseconds()).padStart(3, '0')}`;
    rows.push(
      `<tr><td>${stamp}</td><td class="num">${e.seq ?? ''}</td><td>${escapeHtml(shardLabel(e.shard))}</td>` +
        `<td class="${cls}">${escapeHtml(what)}</td><td class="num">${e.ms != null ? Math.round(e.ms) : ''}</td>` +
        `<td class="detail">${escapeHtml(detail)}</td></tr>`,
    );
  }
  $('logRows').innerHTML = rows.join('') || '<tr><td colspan="6" class="empty">Nothing yet.</td></tr>';
}

// ---------------------------------------------------------------- wiring

function init() {
  $('periodMin').value = settings.periodMin;
  $('intervalSec').value = settings.intervalSec;
  $('countMin').value = settings.countMin;
  $('countMax').value = settings.countMax;

  for (const id of ['periodMin', 'intervalSec', 'countMin', 'countMax']) {
    $(id).addEventListener('input', () => {
      const value = Number($(id).value);
      if ($(id).value !== '' && Number.isFinite(value)) {
        settings[id] = value;
        saveSettings();
      }
      updateOffered();
    });
  }
  for (const network of Object.keys(NETWORKS)) {
    $(`net-${network}`).addEventListener('change', () => selectNetwork(network));
  }
  $('apiKey').addEventListener('input', () => {
    settings.keys[settings.network] = $('apiKey').value.trim();
    saveSettings();
  });
  $('toggleKey').addEventListener('click', () => {
    const shown = $('apiKey').type === 'text';
    $('apiKey').type = shown ? 'password' : 'text';
    $('toggleKey').textContent = shown ? 'Show' : 'Hide';
  });
  $('shardsAll').addEventListener('click', () => {
    settings.unticked[settings.network] = [];
    saveSettings();
    renderShardChips();
  });
  $('shardsNone').addEventListener('click', () => {
    settings.unticked[settings.network] = [...shardPrefixes];
    saveSettings();
    renderShardChips();
  });
  $('startBtn').addEventListener('click', startRun);
  // A double-click must not turn "Stop" into "Stop now" and drop the proofs still due.
  let lastStopClick = 0;
  $('stopBtn').addEventListener('click', () => {
    const now = Date.now();
    if (now - lastStopClick < 500) {
      return;
    }
    lastStopClick = now;
    run?.stop(now);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      render(true);
    }
  });
  window.addEventListener('resize', () => run && render(true));
  window.addEventListener('beforeunload', (event) => {
    if (run && run.phase !== 'done') {
      event.preventDefault();
    }
  });

  updateOffered();
  selectNetwork(NETWORKS[settings.network] ? settings.network : 'testnet');
  renderBanner(Date.now());
}

init();

// Exposed for the browser test and for poking at a run from the console.
window.loadgen = {
  get clockUsesWorker() {
    return clock.usesWorker;
  },
  get run() {
    return run;
  },
};
