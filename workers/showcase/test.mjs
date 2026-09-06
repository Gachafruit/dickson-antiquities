/* Showcase Worker — classification / parsing unit tests.  node workers/showcase/test.mjs */

import assert from 'node:assert';
import {
  classifyResponse,
  classifyItemBody,
  availabilitySignal,
  endDateState,
  buildStatusCounts,
  parseIdList,
  parseIdsParam,
  resolveCorsOrigin,
} from './worker.js';

let pass = 0, fail = 0;
function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { console.log('  ok  ' + name); pass++; })
    .catch((e) => { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); fail++; });
}

const future = new Date(Date.now() + 30 * 864e5).toISOString();
const past = new Date(Date.now() - 30 * 864e5).toISOString();
const item = (extra) => ({ itemId: 'v1|123456789012|0', title: 'Thing', itemWebUrl: 'https://www.ebay.com/itm/123456789012', ...extra });
const avail = (status, qty) => ({ estimatedAvailabilities: [{ estimatedAvailabilityStatus: status, estimatedAvailableQuantity: qty }] });

// a Response-ish stub
const resp = (status, body) => ({
  status,
  json: async () => { if (body === '__throw__') throw new SyntaxError('bad json'); return body; },
});

/* ---- 200 body classification (the required cases) ---- */

test('200 + future itemEndDate → active', () => {
  const r = classifyItemBody('123456789012', item({ itemEndDate: future }));
  assert.strictEqual(r.status, 'active');
});

test('200 + past itemEndDate → unavailable', () => {
  const r = classifyItemBody('123456789012', item({ itemEndDate: past }));
  assert.strictEqual(r.status, 'unavailable');
  assert.ok(r.reason.startsWith('ended-'));
});

test('200 + OUT_OF_STOCK availability status → unavailable', () => {
  const r = classifyItemBody('123456789012', item(avail('OUT_OF_STOCK', 0)));
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.reason, 'out-of-stock');
});

test('200 + past itemEndDate AND OUT_OF_STOCK (real sold signature) → unavailable', () => {
  const r = classifyItemBody('123456789012', item({ itemEndDate: past, ...avail('OUT_OF_STOCK', 0) }));
  assert.strictEqual(r.status, 'unavailable');
});

test('200 + IN_STOCK, no end date → active', () => {
  const r = classifyItemBody('123456789012', item(avail('IN_STOCK', 1)));
  assert.strictEqual(r.status, 'active');
});

test('ambiguous 200 body (no availability fields) → unverified', () => {
  const r = classifyItemBody('123456789012', item());
  assert.strictEqual(r.status, 'unverified');
  assert.strictEqual(r.reason, 'no-availability-signal');
});

test('200 with an empty / garbage body → unverified', () => {
  assert.strictEqual(classifyItemBody('123456789012', {}).status, 'unverified');
  assert.strictEqual(classifyItemBody('123456789012', {}).reason, 'unexpected-200-body');
});

test('contradictory 200 body (past end date BUT IN_STOCK qty 1) → unverified, never removed', () => {
  const r = classifyItemBody('123456789012', item({ itemEndDate: past, ...avail('IN_STOCK', 1) }));
  assert.strictEqual(r.status, 'unverified');
  assert.ok(r.reason.startsWith('contradictory:'));
});

test('classifyResponse(200, ...) delegates to the body classifier', async () => {
  assert.strictEqual((await classifyResponse('x', resp(200, item({ itemEndDate: past })))).status, 'unavailable');
  assert.strictEqual((await classifyResponse('x', resp(200, item(avail('IN_STOCK', 1))))).status, 'active');
  assert.strictEqual((await classifyResponse('x', resp(200, '__throw__'))).reason, 'bad-json');
});

/* ---- availability + end-date helpers ---- */

test('endDateState: past / future / absent / unparseable', () => {
  assert.strictEqual(endDateState(past), 'past');
  assert.strictEqual(endDateState(future), 'future');
  assert.strictEqual(endDateState(undefined), 'absent');
  assert.strictEqual(endDateState('not-a-date'), 'absent');
});

test('availabilitySignal: status enum, nested, quantity fallback, contradiction', () => {
  assert.strictEqual(availabilitySignal(avail('IN_STOCK', 1)), 'in');
  assert.strictEqual(availabilitySignal(avail('LIMITED_STOCK', 1)), 'in');
  assert.strictEqual(availabilitySignal(avail('OUT_OF_STOCK', 0)), 'out');
  assert.strictEqual(availabilitySignal({ estimatedAvailabilityStatus: 'IN_STOCK' }), 'in');
  assert.strictEqual(availabilitySignal({ estimatedAvailableQuantity: 0 }), 'out');
  assert.strictEqual(availabilitySignal({ estimatedAvailableQuantity: 3 }), 'in');
  assert.strictEqual(availabilitySignal({}), 'none');
  // two nested entries disagreeing → no signal
  assert.strictEqual(availabilitySignal({ estimatedAvailabilities: [
    { estimatedAvailabilityStatus: 'IN_STOCK' }, { estimatedAvailabilityStatus: 'OUT_OF_STOCK' },
  ] }), 'none');
});

/* ---- 404 (still an "unavailable" signal) ---- */

test('404 + errorId 11001 → unavailable', async () => {
  const r = await classifyResponse('187148798269', resp(404, { errors: [{ errorId: 11001 }] }));
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.reason, 'ebay-404-11001');
});

test('bare 404 with no body → unavailable', async () => {
  const r = await classifyResponse('187148798269', resp(404, '__throw__'));
  assert.strictEqual(r.status, 'unavailable');
});

test('404 with an UNEXPECTED error code → unverified', async () => {
  const r = await classifyResponse('187148798269', resp(404, { errors: [{ errorId: 12345 }] }));
  assert.strictEqual(r.status, 'unverified');
});

/* ---- unverified: every ambiguous HTTP failure ---- */
for (const code of [400, 401, 403, 429, 500, 502, 503, 504]) {
  test(`HTTP ${code} → unverified`, async () => {
    const r = await classifyResponse('123456789012', resp(code, { errors: [{ errorId: 1 }] }));
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.reason, `http-${code}`);
  });
}

/* ---- counts / id parsing / CORS ---- */

test('buildStatusCounts tallies each bucket', () => {
  assert.deepStrictEqual(
    buildStatusCounts([{ status: 'active' }, { status: 'active' }, { status: 'unavailable' }, { status: 'unverified' }, { status: 'weird' }]),
    { active: 2, unavailable: 1, unverified: 2 }
  );
});

test('parseIdsParam: valid numeric ids only, deduped, order kept', () => {
  assert.deepStrictEqual(parseIdsParam('187370603142, 187370603142 ,abc,12,187860554164'), ['187370603142', '187860554164']);
});

test('parseIdList tolerates numbers and stray whitespace', () => {
  assert.deepStrictEqual(parseIdList([187370603142, ' 187860554164 ', '', null]), ['187370603142', '187860554164']);
});

test('resolveCorsOrigin: public site + loopback allowed, others rejected', () => {
  assert.strictEqual(resolveCorsOrigin('https://dicksonantiquities.com'), 'https://dicksonantiquities.com');
  assert.strictEqual(resolveCorsOrigin('http://localhost:5500'), 'http://localhost:5500');
  assert.strictEqual(resolveCorsOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.strictEqual(resolveCorsOrigin('http://[::1]:3000'), 'http://[::1]:3000');
  assert.strictEqual(resolveCorsOrigin(''), 'https://dicksonantiquities.com');
  assert.strictEqual(resolveCorsOrigin('https://evil.example'), null);
});

process.on('exit', () => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
});
