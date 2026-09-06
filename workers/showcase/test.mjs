/* Showcase Worker — classification / parsing unit tests.  node workers/showcase/test.mjs */

import assert from 'node:assert';
import {
  classifyResponse,
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

// a Response-ish stub
const resp = (status, body) => ({
  status,
  json: async () => {
    if (body === '__throw__') throw new SyntaxError('bad json');
    return body;
  },
});

/* ---- active ---- */
test('200 with a real item body → active (+ title/url)', async () => {
  const r = await classifyResponse('123456789012', resp(200, { itemId: 'v1|123456789012|0', title: 'Brass Lamp', itemWebUrl: 'https://www.ebay.com/itm/123456789012' }));
  assert.strictEqual(r.status, 'active');
  assert.strictEqual(r.title, 'Brass Lamp');
  assert.strictEqual(r.reason, null);
});

test('200 with an empty/garbage body → unverified (not active, not sold)', async () => {
  const r = await classifyResponse('123456789012', resp(200, {}));
  assert.strictEqual(r.status, 'unverified');
});

test('200 with unparseable body → unverified', async () => {
  const r = await classifyResponse('123456789012', resp(200, '__throw__'));
  assert.strictEqual(r.status, 'unverified');
  assert.strictEqual(r.reason, 'bad-json');
});

/* ---- unavailable ---- */
test('404 + errorId 11001 → unavailable', async () => {
  const r = await classifyResponse('187148798269', resp(404, { errors: [{ errorId: 11001, message: 'The specified item Id was not found.' }] }));
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.reason, 'ebay-404-11001');
});

test('bare 404 with no body → unavailable', async () => {
  const r = await classifyResponse('187148798269', resp(404, '__throw__'));
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.reason, 'ebay-404');
});

test('404 with an UNEXPECTED error code → unverified (ambiguous, never removable)', async () => {
  const r = await classifyResponse('187148798269', resp(404, { errors: [{ errorId: 12345, message: 'weird' }] }));
  assert.strictEqual(r.status, 'unverified');
});

/* ---- unverified: every ambiguous failure ---- */
for (const code of [400, 401, 403, 429, 500, 502, 503, 504]) {
  test(`HTTP ${code} → unverified`, async () => {
    const r = await classifyResponse('123456789012', resp(code, { errors: [{ errorId: 1 }] }));
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.reason, `http-${code}`);
  });
}

/* ---- counts ---- */
test('buildStatusCounts tallies each bucket', () => {
  const c = buildStatusCounts([
    { status: 'active' }, { status: 'active' }, { status: 'unavailable' },
    { status: 'unverified' }, { status: 'weird-unknown' },
  ]);
  assert.deepStrictEqual(c, { active: 2, unavailable: 1, unverified: 2 });
});

/* ---- id parsing ---- */
test('parseIdsParam: valid numeric ids only, deduped, order kept', () => {
  assert.deepStrictEqual(
    parseIdsParam('187370603142, 187370603142 ,abc,12,187860554164'),
    ['187370603142', '187860554164']
  );
});

test('parseIdList tolerates numbers and stray whitespace', () => {
  assert.deepStrictEqual(parseIdList([187370603142, ' 187860554164 ', '', null]), ['187370603142', '187860554164']);
});

/* ---- CORS ---- */
test('resolveCorsOrigin: public site + loopback allowed, others rejected', () => {
  assert.strictEqual(resolveCorsOrigin('https://dicksonantiquities.com'), 'https://dicksonantiquities.com');
  assert.strictEqual(resolveCorsOrigin('http://localhost:5500'), 'http://localhost:5500');
  assert.strictEqual(resolveCorsOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.strictEqual(resolveCorsOrigin('http://[::1]:3000'), 'http://[::1]:3000');
  assert.strictEqual(resolveCorsOrigin(''), 'https://dicksonantiquities.com'); // no Origin header
  assert.strictEqual(resolveCorsOrigin('https://evil.example'), null);
});

process.on('exit', () => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
});
