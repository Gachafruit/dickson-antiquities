/* Showcase Worker unit tests.  node workers/showcase/test.mjs */

import assert from 'node:assert';
import {
  getShowcaseItems,
  publicCandidateOrder,
  assembleShowcase,
  normalizeItem,
  classifyResponse,
  classifyItemBody,
  availabilitySignal,
  endDateState,
  buildStatusCounts,
  parseIdList,
  parseIdsParam,
  resolveCorsOrigin,
} from './worker.js';

/* ---- sequential runner (so a test may stub globalThis.fetch safely) ---- */
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const future = new Date(Date.now() + 30 * 864e5).toISOString();
const past = new Date(Date.now() - 30 * 864e5).toISOString();
const item = (extra) => ({ itemId: 'v1|123456789012|0', title: 'Thing', itemWebUrl: 'https://www.ebay.com/itm/123456789012', ...extra });
const avail = (status, qty) => ({ estimatedAvailabilities: [{ estimatedAvailabilityStatus: status, estimatedAvailableQuantity: qty }] });
const resp = (status, body) => ({ status, json: async () => { if (body === '__throw__') throw new SyntaxError('bad json'); return body; } });

/* ================= availability classification ================= */

test('200 + future itemEndDate → active', () => {
  assert.strictEqual(classifyItemBody('1', item({ itemEndDate: future })).status, 'active');
});
test('200 + past itemEndDate → unavailable', () => {
  const r = classifyItemBody('1', item({ itemEndDate: past }));
  assert.strictEqual(r.status, 'unavailable');
  assert.ok(r.reason.startsWith('ended-'));
});
test('200 + OUT_OF_STOCK availability status → unavailable', () => {
  const r = classifyItemBody('1', item(avail('OUT_OF_STOCK', 0)));
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.reason, 'out-of-stock');
});
test('200 + past itemEndDate AND OUT_OF_STOCK (real sold signature) → unavailable', () => {
  assert.strictEqual(classifyItemBody('1', item({ itemEndDate: past, ...avail('OUT_OF_STOCK', 0) })).status, 'unavailable');
});
test('200 + IN_STOCK, no end date → active', () => {
  assert.strictEqual(classifyItemBody('1', item(avail('IN_STOCK', 1))).status, 'active');
});
test('ambiguous 200 body (no availability fields) → unverified', () => {
  const r = classifyItemBody('1', item());
  assert.strictEqual(r.status, 'unverified');
  assert.strictEqual(r.reason, 'no-availability-signal');
});
test('200 with an empty / garbage body → unverified', () => {
  assert.strictEqual(classifyItemBody('1', {}).reason, 'unexpected-200-body');
});
test('contradictory 200 body (past end date BUT IN_STOCK qty 1) → unverified', () => {
  const r = classifyItemBody('1', item({ itemEndDate: past, ...avail('IN_STOCK', 1) }));
  assert.strictEqual(r.status, 'unverified');
  assert.ok(r.reason.startsWith('contradictory:'));
});
test('classifyResponse(200, ...) delegates to the body classifier', async () => {
  assert.strictEqual((await classifyResponse('x', resp(200, item({ itemEndDate: past })))).status, 'unavailable');
  assert.strictEqual((await classifyResponse('x', resp(200, item(avail('IN_STOCK', 1))))).status, 'active');
  assert.strictEqual((await classifyResponse('x', resp(200, '__throw__'))).reason, 'bad-json');
});

test('endDateState: past / future / absent / unparseable', () => {
  assert.strictEqual(endDateState(past), 'past');
  assert.strictEqual(endDateState(future), 'future');
  assert.strictEqual(endDateState(undefined), 'absent');
  assert.strictEqual(endDateState('not-a-date'), 'absent');
});
test('availabilitySignal: status enum, nested, quantity fallback, contradiction', () => {
  assert.strictEqual(availabilitySignal(avail('IN_STOCK', 1)), 'in');
  assert.strictEqual(availabilitySignal(avail('OUT_OF_STOCK', 0)), 'out');
  assert.strictEqual(availabilitySignal({ estimatedAvailableQuantity: 0 }), 'out');
  assert.strictEqual(availabilitySignal({ estimatedAvailableQuantity: 3 }), 'in');
  assert.strictEqual(availabilitySignal({}), 'none');
  assert.strictEqual(availabilitySignal({ estimatedAvailabilities: [
    { estimatedAvailabilityStatus: 'IN_STOCK' }, { estimatedAvailabilityStatus: 'OUT_OF_STOCK' },
  ] }), 'none');
});

test('404 + errorId 11001 → unavailable', async () => {
  assert.strictEqual((await classifyResponse('x', resp(404, { errors: [{ errorId: 11001 }] }))).reason, 'ebay-404-11001');
});
test('bare 404 with no body → unavailable', async () => {
  assert.strictEqual((await classifyResponse('x', resp(404, '__throw__'))).status, 'unavailable');
});
test('404 with an UNEXPECTED error code → unverified', async () => {
  assert.strictEqual((await classifyResponse('x', resp(404, { errors: [{ errorId: 12345 }] }))).status, 'unverified');
});
for (const code of [400, 401, 403, 429, 500, 502, 503, 504]) {
  test(`HTTP ${code} → unverified`, async () => {
    const r = await classifyResponse('x', resp(code, { errors: [{ errorId: 1 }] }));
    assert.strictEqual(r.status, 'unverified');
    assert.strictEqual(r.reason, `http-${code}`);
  });
}

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
  assert.strictEqual(resolveCorsOrigin(''), 'https://dicksonantiquities.com');
  assert.strictEqual(resolveCorsOrigin('https://evil.example'), null);
});

/* ================= public showcase fill ================= */

const idOrder = (a) => a.slice(); // deterministic "shuffle" for tests

test('publicCandidateOrder: excludes known-unavailable, active first, then unknown', () => {
  const ids = ['1', '2', '3', '4', '5'];
  const status = { '1': 'active', '2': 'unavailable', '3': null, '4': 'active', '5': 'unavailable' };
  const order = publicCandidateOrder(ids, status, idOrder);
  assert.deepStrictEqual(order, ['1', '4', '3']); // 2 and 5 dropped; actives before unknowns
});

test('publicCandidateOrder: unverified is treated as unknown (never cached, so null)', () => {
  const ids = ['1', '2', '3'];
  // status cache only ever holds 'active' / 'unavailable'
  const order = publicCandidateOrder(ids, { '2': 'unavailable' }, idOrder);
  assert.deepStrictEqual(order, ['1', '3']);
});

test('assembleShowcase: active fills first, unverified backfills, never exceeds want', () => {
  const A = (id) => ({ id });
  assert.deepStrictEqual(assembleShowcase([A('a'), A('b')], [A('c'), A('d')], 3), [A('a'), A('b'), A('c')]);
  assert.deepStrictEqual(assembleShowcase([A('a'), A('b'), A('c'), A('d')], [A('e')], 3), [A('a'), A('b'), A('c')]);
  assert.deepStrictEqual(assembleShowcase([], [A('e')], 3), [A('e')]);
});

/* ---- getShowcaseItems with mocked fetch + KV ---- */

function mockCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}

// KV stub seeded with { key: stringValue }
function mockKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    _store: store,
    get: async (k, type) => {
      const v = store.has(k) ? store.get(k) : null;
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, String(v)); },
  };
}

// Runs fn with globalThis.fetch replaced; always restores it.
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts, calls);
  };
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = real;
  }
}

const jsonResponse = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const ebayItemUrl = (id) => `https://api.ebay.com/buy/browse/v1/item/v1|${id}|0`;
const ebayItemId = (url) => (url.match(/item\/v1\|(\d+)\|0/) || [])[1];

const CURATED = ['10000000001', '10000000002', '10000000003', '10000000004', '10000000005', '10000000006', '10000000007', '10000000008'];

test('public: 6 active served entirely from cache → ZERO eBay item calls', async () => {
  const ctx = mockCtx();
  const seed = {
    ebay_app_token: 'TExisting',
  };
  // first 6 curated ids cached active + details; rest cached unavailable
  CURATED.forEach((id, i) => {
    if (i < 6) {
      seed[`ebay_status_v2_${id}`] = 'active';
      seed[`ebay_item_${id}`] = JSON.stringify({ id, title: 'Item ' + id, price: 1, currency: 'USD', image: 'x', url: 'u' });
    } else {
      seed[`ebay_status_v2_${id}`] = 'unavailable';
    }
  });
  const env = { SHOWCASE_CACHE: mockKV(seed) };

  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: CURATED });
    if (ebayItemId(url)) throw new Error('unexpected eBay item call for ' + url);
    if (url.includes('oauth2/token')) throw new Error('unexpected token call (cached)');
    throw new Error('unexpected fetch ' + url);
  }, async (getCalls) => {
    const result = await getShowcaseItems(env, ctx);
    await ctx.settle();
    assert.strictEqual(result.items.length, 6, 'filled 6 slots');
    const ebayCalls = getCalls().filter((u) => ebayItemId(u));
    assert.strictEqual(ebayCalls.length, 0, 'no eBay item lookups: ' + ebayCalls.length);
    return result;
  });
  // contract shape
  out.items.forEach((it) => assert.deepStrictEqual(Object.keys(it).sort(), ['currency', 'id', 'image', 'price', 'title', 'url']));
});

test('public: sold candidates are skipped and replaced until 6 active found', async () => {
  const ctx = mockCtx();
  // Nothing cached — everything must be looked up live.
  const env = { SHOWCASE_CACHE: mockKV({ ebay_app_token: 'T' }) };

  // ids ...002 and ...005 are sold (past end date); the rest active.
  const sold = new Set(['10000000002', '10000000005']);
  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: CURATED });
    const id = ebayItemId(url);
    if (id) {
      const body = sold.has(id)
        ? { itemId: 'v1|' + id + '|0', title: 'Sold ' + id, itemEndDate: past, estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK', estimatedAvailableQuantity: 0 }] }
        : { itemId: 'v1|' + id + '|0', title: 'Live ' + id, price: { value: '10.00', currency: 'USD' }, image: { imageUrl: 'img' }, itemWebUrl: 'w', estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedAvailableQuantity: 1 }] };
      return jsonResponse(200, body);
    }
    throw new Error('unexpected fetch ' + url);
  }, async () => {
    const result = await getShowcaseItems(env, ctx);
    await ctx.settle();
    return result;
  });

  assert.strictEqual(out.items.length, 6, 'still filled 6 slots');
  const shownIds = out.items.map((i) => i.id);
  assert.ok(!shownIds.includes('10000000002') && !shownIds.includes('10000000005'), 'sold ids not shown');
  // sold verdicts were written back to the status cache
  assert.strictEqual(await env.SHOWCASE_CACHE.get('ebay_status_v2_10000000002'), 'unavailable');
});

test('public: known-unavailable in cache costs no eBay call', async () => {
  const ctx = mockCtx();
  const seed = { ebay_app_token: 'T' };
  // 2 cached-unavailable, 6 unknown-but-live
  CURATED.forEach((id, i) => { if (i < 2) seed[`ebay_status_v2_${id}`] = 'unavailable'; });
  const env = { SHOWCASE_CACHE: mockKV(seed) };

  const out = await withFetch((url, _o, calls) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: CURATED });
    const id = ebayItemId(url);
    if (id) {
      assert.ok(!['10000000001', '10000000002'].includes(id), 'never looks up a cached-unavailable id');
      return jsonResponse(200, { itemId: 'v1|' + id + '|0', title: 't', price: { value: '1', currency: 'USD' }, itemWebUrl: 'w', estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedAvailableQuantity: 1 }] });
    }
    throw new Error('unexpected ' + url);
  }, async (getCalls) => {
    const r = await getShowcaseItems(env, ctx);
    await ctx.settle();
    const ebayCalls = getCalls().filter((u) => ebayItemId(u));
    assert.strictEqual(ebayCalls.length, 6, 'exactly 6 lookups for the 6 unknown live ids');
    return r;
  });
  assert.strictEqual(out.items.length, 6);
});

test('public: unverified items only backfill when active is short; never shows unavailable', async () => {
  const ctx = mockCtx();
  const env = { SHOWCASE_CACHE: mockKV({ ebay_app_token: 'T' }) };
  const small = ['20000000001', '20000000002', '20000000003', '20000000004'];
  // 1 active, 1 sold(404), 2 ambiguous(200 no signals)
  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: small });
    const id = ebayItemId(url);
    if (id === '20000000001') return jsonResponse(200, { itemId: 'v1|' + id + '|0', title: 'Active', price: { value: '1', currency: 'USD' }, itemWebUrl: 'w', estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedAvailableQuantity: 1 }] });
    if (id === '20000000002') return jsonResponse(404, { errors: [{ errorId: 11001 }] });
    if (id) return jsonResponse(200, { itemId: 'v1|' + id + '|0', title: 'Ambiguous ' + id, price: { value: '2', currency: 'USD' }, itemWebUrl: 'w' });
    throw new Error('unexpected ' + url);
  }, async () => {
    const r = await getShowcaseItems(env, ctx);
    await ctx.settle();
    return r;
  });
  const ids = out.items.map((i) => i.id);
  assert.ok(ids.includes('20000000001'), 'the one active item is shown');
  assert.ok(!ids.includes('20000000002'), 'the sold (404) item is never shown');
  assert.strictEqual(out.items.length, 3, 'active + 2 unverified backfill (want=min(6,4)=4, only 3 renderable)');
});

test('public: token failure → serves what the cache covers, no throw', async () => {
  const ctx = mockCtx();
  const seed = {}; // no cached token
  CURATED.slice(0, 4).forEach((id) => {
    seed[`ebay_status_v2_${id}`] = 'active';
    seed[`ebay_item_${id}`] = JSON.stringify({ id, title: 't', price: 1, currency: 'USD', image: 'x', url: 'u' });
  });
  const env = { SHOWCASE_CACHE: mockKV(seed), EBAY_CLIENT_ID: '', EBAY_CLIENT_SECRET: '' };

  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: CURATED });
    if (url.includes('oauth2/token')) return jsonResponse(401, { error: 'nope' });
    if (ebayItemId(url)) throw new Error('must not call eBay without a token');
    throw new Error('unexpected ' + url);
  }, async () => {
    return getShowcaseItems(env, ctx);
  });
  assert.strictEqual(out.items.length, 4, 'served the 4 fully-cached active items');
});

test('public: response contract unchanged — { items: [...] } only', async () => {
  const ctx = mockCtx();
  const env = { SHOWCASE_CACHE: mockKV({ ebay_app_token: 'T' }) };
  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: [] });
    throw new Error('unexpected ' + url);
  }, async () => getShowcaseItems(env, ctx));
  assert.deepStrictEqual(Object.keys(out), ['items']);
  assert.deepStrictEqual(out.items, []);
});

test('normalizeItem: maps Browse fields to the site shape', () => {
  const it = normalizeItem('999', { title: 'T', price: { value: '5.00', currency: 'USD' }, image: { imageUrl: 'i' }, itemWebUrl: 'w' });
  assert.deepStrictEqual(it, { id: '999', title: 'T', price: '5.00', currency: 'USD', image: 'i', url: 'w' });
});

/* ---- run ---- */
let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log('  ok  ' + name);
    pass++;
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + (e && (e.stack || e.message)));
    fail++;
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
