// Drives the built index.html in headless Chromium.
//
//   node test/browser.mjs [screenshot-dir]
//
// CHROMIUM=/path/to/chrome overrides the browser binary (default: the newest Playwright-managed Chromium).
// Missing system libraries can be supplied with LD_LIBRARY_PATH.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';

const PAGE = pathToFileURL(new URL('../index.html', import.meta.url).pathname).href;
const SHOTS = process.argv[2] ?? null;
const notCertified = JSON.parse(readFileSync(new URL('./fixtures/not-certified.json', import.meta.url), 'utf8'));
const certified = JSON.parse(readFileSync(new URL('./fixtures/certified.json', import.meta.url), 'utf8'));

function findChromium() {
  if (process.env.CHROMIUM) {
    return process.env.CHROMIUM;
  }
  const root = join(homedir(), '.cache', 'ms-playwright');
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)) : [];
  // Newest first; the headless shell needs fewer system libraries than full Chromium.
  const shell = (d) => (d.startsWith('chromium_headless_shell') ? 0 : 1);
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]) || shell(a) - shell(b));
  for (const dir of dirs) {
    for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const path = join(root, dir, sub);
      if (existsSync(path)) {
        return path;
      }
    }
  }
  throw new Error('No Chromium found; set CHROMIUM.');
}

async function openPage(browser, options = {}) {
  const context = await browser.newContext({ viewport: { height: 1600, width: 1280 }, ...options });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      problems.push(`console: ${message.text()}`);
    }
  });
  await page.goto(PAGE);
  return { context, page, problems };
}

const browser = await chromium.launch({ executablePath: findChromium() });

test('loads, lists testnet shards, keeps a worker clock', async () => {
  const { context, page, problems } = await openPage(browser);
  await page.waitForFunction(() => document.querySelectorAll('#shardChips input').length === 8, null, { timeout: 15_000 });
  assert.equal(await page.textContent('#gatewayUrl'), 'https://gateway.testnet2.unicity.network');
  assert.match(await page.textContent('#shardNote'), /All 8 shards/);
  assert.match(await page.textContent('#offered'), /commitments\/s/);
  assert.equal(await page.evaluate(() => window.loadgen.clockUsesWorker), true);
  assert.deepEqual(problems, []);
  await context.close();
});

test('form validation blocks a bad range and a missing key', async () => {
  const { context, page } = await openPage(browser);
  await page.fill('#countMin', '5');
  await page.fill('#countMax', '2');
  assert.match(await page.textContent('#formError'), /upper count/);
  await page.fill('#countMax', '9');
  assert.equal(await page.textContent('#formError'), '');
  await page.fill('#apiKey', '');
  await page.click('#startBtn');
  assert.match(await page.textContent('#formError'), /API key/);
  assert.equal(await page.evaluate(() => window.loadgen.run), null);
  await context.close();
});

test('a rejected key stops the run with a 401 (real testnet)', async () => {
  const { context, page, problems } = await openPage(browser);
  await page.waitForFunction(() => document.querySelectorAll('#shardChips input').length === 8, null, { timeout: 15_000 });
  await page.fill('#apiKey', 'key_00000000-0000-4000-8000-000000000000');
  await page.fill('#periodMin', '1');
  await page.fill('#intervalSec', '1');
  await page.fill('#countMin', '2');
  await page.fill('#countMax', '3');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.loadgen.run?.phase === 'done', null, { timeout: 15_000 });
  assert.match(await page.textContent('#bannerText'), /Stopped on Testnet: API key rejected \(401\)/);
  assert.match(await page.textContent('#failures'), /API key rejected \(401\)/);
  assert.ok(Number((await page.textContent('#tErrors')).replace(/\D/g, '')) >= 2);
  assert.equal(await page.isVisible('#startBtn'), true, 'controls unlocked again');
  assert.equal(await page.isDisabled('#periodMin'), false);
  // Settings and the key persist per network.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('unicity-loadgen:v1')));
  assert.equal(saved.keys.testnet, 'key_00000000-0000-4000-8000-000000000000');
  assert.equal(saved.countMax, 3);
  assert.deepEqual(problems, []);
  await context.close();
});

test('mainnet asks before starting; declining sends nothing', async () => {
  const { context, page } = await openPage(browser);
  let requests = 0;
  await page.route('https://gateway.mainnet.unicity.network/', (route) => {
    requests++;
    return route.abort();
  });
  await page.click('label[for=net-mainnet]');
  assert.equal(await page.isChecked('#net-mainnet'), true);
  await page.waitForFunction(() => document.querySelectorAll('#shardChips input').length === 4, null, { timeout: 15_000 });
  assert.equal(await page.inputValue('#apiKey'), '', 'mainnet has its own key slot');
  await page.fill('#apiKey', 'key_mainnet_placeholder');
  let message = null;
  page.once('dialog', (dialog) => {
    message = dialog.message();
    return dialog.dismiss();
  });
  await page.click('#startBtn');
  assert.match(message, /MAINNET/);
  assert.match(message, /permanently/);
  assert.equal(await page.evaluate(() => window.loadgen.run), null);
  assert.equal(requests, 0);
  await context.close();
});

for (const colorScheme of ['light', 'dark']) {
  test(`mocked run fills the page (${colorScheme})`, async () => {
    const { context, page, problems } = await openPage(browser, { colorScheme });
    const proofPolls = new Map();
    let n = 0;
    // What the gateway sends cross-origin; without the expose list the page cannot read Retry-After.
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-RateLimit-Remaining, Retry-After' };
    await page.route('https://gateway.testnet2.unicity.network/', async (route) => {
      const request = JSON.parse(route.request().postData());
      const reply = (result, headers = {}) =>
        route.fulfill({ body: JSON.stringify({ id: request.id, jsonrpc: '2.0', result }), headers: { 'content-type': 'application/json', ...cors, ...headers } });
      if (request.method === 'certification_request') {
        n++;
        if (n % 5 === 0) {
          return route.fulfill({ body: 'Too Many Requests', headers: { ...cors, 'Retry-After': '1' }, status: 429 });
        }
        return reply({ status: 'SUCCESS' }, { 'X-RateLimit-Remaining': String(Math.max(0, 50 - (n % 50))) });
      }
      if (request.method === 'get_inclusion_proof.v2') {
        const polls = (proofPolls.get(request.params.stateId) ?? 0) + 1;
        proofPolls.set(request.params.stateId, polls);
        return reply(polls >= 2 ? certified.result : notCertified.result);
      }
      return route.continue();
    });
    await page.waitForFunction(() => document.querySelectorAll('#shardChips input').length === 8, null, { timeout: 15_000 });
    // Aim only at shard 011, the shard the proof fixtures come from.
    await page.click('#shardsNone');
    await page.locator('#shardChips label', { hasText: '011' }).locator('input').check();
    assert.match(await page.textContent('#shardNote'), /1 of 8 shards/);
    await page.fill('#apiKey', 'key_mock');
    await page.fill('#periodMin', '0.15');
    await page.fill('#intervalSec', '0.5');
    await page.fill('#countMin', '3');
    await page.fill('#countMax', '8');
    await page.click('#startBtn');
    await page.waitForTimeout(6000);
    if (SHOTS) {
      await page.screenshot({ fullPage: true, path: join(SHOTS, `running-${colorScheme}.png`) });
    }
    const banner = await page.textContent('#bannerText');
    assert.match(banner, /Running on Testnet/);
    await page.waitForFunction(() => window.loadgen.run?.phase === 'done', null, { timeout: 30_000 });

    const s = await page.evaluate(() => {
      const st = window.loadgen.run.stats;
      return {
        accepted: st.accepted,
        errors: st.errors,
        included: st.included,
        mismatches: st.shardMismatches,
        rateLimited: st.rateLimited,
        sent: st.sent,
        shards: [...st.shards.keys()],
        timeouts: st.proofTimeouts,
      };
    });
    assert.ok(s.sent > 20, `sent ${s.sent}`);
    assert.equal(s.accepted + s.rateLimited, s.sent);
    assert.ok(s.rateLimited > 0);
    assert.equal(s.included, s.accepted, 'every accepted commitment got its proof');
    assert.equal(s.errors, 0);
    assert.equal(s.timeouts, 0);
    assert.equal(s.mismatches, 0);
    assert.deepEqual(s.shards, ['011'], 'every commitment went to the one ticked shard');
    assert.match(await page.textContent('#bannerText'), /Finished on Testnet: period over/);
    assert.match(await page.textContent('#rRetryAfter'), /1 s/);
    assert.ok((await page.locator('#logRows tr').count()) > 10);
    assert.ok((await page.locator('#chart polyline').count()) === 3);

    // Hover shows the tooltip.
    const box = await page.locator('#chart svg').boundingBox();
    // A few seconds back from "now" (right margin 96 px), inside the run.
    await page.mouse.move(box.x + box.width - 96 - 12, box.y + 80);
    assert.equal(await page.isVisible('#tooltip'), true);
    assert.match(await page.textContent('#tooltip'), /Accepted/);
    if (SHOTS) {
      await page.screenshot({ fullPage: true, path: join(SHOTS, `done-${colorScheme}.png`) });
    }
    assert.deepEqual(problems, []);
    await context.close();
  });
}

test('Start waits for the shard list', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('https://gateway.testnet2.unicity.network/config/shards', async (route) => {
    await gate;
    return route.continue();
  });
  await page.goto(PAGE);
  await page.fill('#apiKey', 'key_x');
  await page.click('#startBtn');
  assert.match(await page.textContent('#formError'), /shard list/);
  assert.equal(await page.evaluate(() => window.loadgen.run), null);
  release();
  await page.waitForFunction(() => document.querySelectorAll('#shardChips input').length === 8, null, { timeout: 15_000 });
  await context.close();
});

test('a double-click on Stop drains instead of dropping proofs', async () => {
  const { context, page } = await openPage(browser);
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-RateLimit-Remaining, Retry-After' };
  await page.route('https://gateway.testnet2.unicity.network/', (route) => {
    const request = JSON.parse(route.request().postData());
    const result = request.method === 'certification_request' ? { status: 'SUCCESS' } : notCertified.result;
    return route.fulfill({ body: JSON.stringify({ id: request.id, jsonrpc: '2.0', result }), headers: { 'content-type': 'application/json', ...cors } });
  });
  await page.waitForFunction(() => document.querySelectorAll('#shardChips input').length === 8, null, { timeout: 15_000 });
  await page.fill('#apiKey', 'key_mock');
  await page.fill('#periodMin', '0');
  await page.fill('#countMin', '2');
  await page.fill('#countMax', '2');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.loadgen.run.pending.size > 0);
  await page.dblclick('#stopBtn');
  assert.equal(await page.evaluate(() => window.loadgen.run.phase), 'draining');
  assert.equal(await page.textContent('#stopBtn'), 'Stop now');
  await page.waitForTimeout(600);
  await page.click('#stopBtn');
  await page.waitForFunction(() => window.loadgen.run.phase === 'done', null, { timeout: 5000 });
  assert.ok(await page.evaluate(() => window.loadgen.run.stats.abandoned) > 0);
  assert.match(await page.textContent('#tPendingSub'), /^\s*$/, 'no submissions shown in flight after the end');
  await context.close();
});

test('failure details stay open while the page redraws', async () => {
  const { context, page } = await openPage(browser);
  await page.route('https://gateway.testnet2.unicity.network/', (route) =>
    route.fulfill({ body: 'upstream went away', headers: { 'Access-Control-Allow-Origin': '*' }, status: 502 }),
  );
  await page.waitForFunction(() => document.querySelectorAll('#shardChips input').length === 8, null, { timeout: 15_000 });
  await page.fill('#apiKey', 'key_mock');
  await page.fill('#periodMin', '0');
  await page.fill('#intervalSec', '0.2');
  await page.click('#startBtn');
  await page.waitForSelector('#failures details summary');
  await page.click('#failures details summary');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.querySelector('#failures details').open), true);
  assert.match(await page.textContent('#failures'), /upstream went away/);
  await page.click('#stopBtn');
  await context.close();
});

test('two tabs do not erase each other\'s saved keys', async () => {
  const context = await browser.newContext();
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto(PAGE);
  await b.goto(PAGE);
  // Tab B works on mainnet and saves its key; tab A, still on testnet, then edits a field.
  await b.click('label[for=net-mainnet]');
  await b.fill('#apiKey', 'key_mainnet_from_b');
  await a.waitForTimeout(200);
  await a.fill('#intervalSec', '2');
  const saved = await a.evaluate(() => JSON.parse(localStorage.getItem('unicity-loadgen:v1')));
  assert.equal(saved.keys.mainnet, 'key_mainnet_from_b');
  assert.equal(saved.intervalSec, 2);
  await context.close();
});

const TESTNET_KEY = process.env.LOADGEN_TESTNET_KEY ?? '';

test('real testnet run from file:// gets every accepted commitment included', { skip: TESTNET_KEY === '' && 'set LOADGEN_TESTNET_KEY' }, async () => {
  const { context, page, problems } = await openPage(browser);
  await page.waitForFunction(() => document.querySelectorAll('#shardChips input').length === 8, null, { timeout: 15_000 });
  await page.fill('#apiKey', TESTNET_KEY);
  await page.fill('#periodMin', '0.25');
  await page.fill('#intervalSec', '1');
  await page.fill('#countMin', '1');
  await page.fill('#countMax', '3');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.loadgen.run?.phase === 'done', null, { timeout: 120_000 });
  const s = await page.evaluate(() => {
    const st = window.loadgen.run.stats;
    return { accepted: st.accepted, errors: st.errors, included: st.included, mismatches: st.shardMismatches, rateLimited: st.rateLimited, remaining: st.lastRemaining, sent: st.sent, shards: st.shards.size, timeouts: st.proofTimeouts, p50: st.proofLatency.percentile(50) };
  });
  console.log(`  real run: ${JSON.stringify(s)}`);
  assert.ok(s.accepted > 0);
  assert.equal(s.accepted + s.rateLimited + s.errors, s.sent);
  assert.equal(s.included, s.accepted);
  assert.equal(s.timeouts, 0);
  assert.equal(s.mismatches, 0);
  assert.notEqual(s.remaining, null, 'X-RateLimit-Remaining readable cross-origin');
  if (SHOTS) {
    await page.screenshot({ fullPage: true, path: join(SHOTS, 'real-testnet.png') });
  }
  assert.deepEqual(problems, []);
  await context.close();
});

test.after(() => browser.close());
