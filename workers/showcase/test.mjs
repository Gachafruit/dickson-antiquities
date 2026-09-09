/* Showcase Worker unit tests.  node workers/showcase/test.mjs */

import assert from 'node:assert';
import worker, {
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

const PUBLIC_WANT = 12;

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
test('resolveCorsOrigin: production + www + every loopback form allowed; others rejected', () => {
  assert.strictEqual(resolveCorsOrigin('https://dicksonantiquities.com'), 'https://dicksonantiquities.com');
  assert.strictEqual(resolveCorsOrigin('https://www.dicksonantiquities.com'), 'https://www.dicksonantiquities.com');
  assert.strictEqual(resolveCorsOrigin('http://localhost:5500'), 'http://localhost:5500');
  assert.strictEqual(resolveCorsOrigin('http://127.0.0.1:5500'), 'http://127.0.0.1:5500');
  assert.strictEqual(resolveCorsOrigin('http://[::1]:5500'), 'http://[::1]:5500');
  assert.strictEqual(resolveCorsOrigin(''), 'https://dicksonantiquities.com'); // no Origin → production
  assert.strictEqual(resolveCorsOrigin('https://evil.example'), null);
  assert.strictEqual(resolveCorsOrigin('http://192.168.1.20:5500'), null); // arbitrary LAN not allowed
  assert.strictEqual(resolveCorsOrigin('https://dicksonantiquities.com.evil.com'), null);
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

const jsonResponse = (status, body, extra = {}) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), ...extra });
const ebayItemId = (url) => (url.match(/item\/v1\|(\d+)\|0/) || [])[1];

// 20 curated ids so want = min(12, 20) = 12
const CURATED = Array.from({ length: 20 }, (_, i) => '1000000000' + String(10 + i));
const liveBody = (id) => ({ itemId: 'v1|' + id + '|0', title: 'Live ' + id, price: { value: '10.00', currency: 'USD' }, image: { imageUrl: 'img' }, itemWebUrl: 'w', estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedAvailableQuantity: 1 }] });
const soldBody = (id) => ({ itemId: 'v1|' + id + '|0', title: 'Sold ' + id, itemEndDate: past, estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK', estimatedAvailableQuantity: 0 }] });

test('public: 12 active served entirely from cache → ZERO eBay item + token calls', async () => {
  const ctx = mockCtx();
  const seed = { ebay_app_token: 'TExisting' };
  // 14 cached active w/ details, rest cached unavailable
  CURATED.forEach((id, i) => {
    if (i < 14) {
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
    assert.strictEqual(result.items.length, 12, 'filled 12 slots');
    assert.strictEqual(getCalls().filter((u) => ebayItemId(u)).length, 0, 'zero eBay item lookups');
    return result;
  });
  out.items.forEach((it) => assert.deepStrictEqual(Object.keys(it).sort(), ['currency', 'id', 'image', 'price', 'title', 'url']));
});

test('public: cold cache fills to 12, skipping sold, drawing replacements, caching verdicts back', async () => {
  const ctx = mockCtx();
  const env = { SHOWCASE_CACHE: mockKV({ ebay_app_token: 'T' }) };
  // exactly 16 curated: 4 sold, 12 live → every id must be checked to fill 12
  const pool = Array.from({ length: 16 }, (_, i) => '4000000000' + String(10 + i));
  const sold = new Set([pool[2], pool[5], pool[9], pool[13]]);
  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: pool });
    const id = ebayItemId(url);
    if (id) return jsonResponse(200, sold.has(id) ? soldBody(id) : liveBody(id));
    throw new Error('unexpected ' + url);
  }, async (getCalls) => {
    const r = await getShowcaseItems(env, ctx);
    await ctx.settle();
    assert.strictEqual(r.items.length, 12, 'filled 12 despite 4 sold');
    const shown = r.items.map((i) => i.id);
    assert.ok([...sold].every((s) => !shown.includes(s)), 'no sold id shown');
    assert.ok(getCalls().filter((u) => ebayItemId(u)).length <= 16, 'never checks more than the list');
    return r;
  });
  for (const s of sold) {
    assert.strictEqual(await env.SHOWCASE_CACHE.get('ebay_status_v2_' + s), 'unavailable', 'sold verdict cached back: ' + s);
  }
});

test('public: cold-request lookups are bounded by MAX_PUBLIC_LOOKUPS', async () => {
  const ctx = mockCtx();
  const env = { SHOWCASE_CACHE: mockKV({ ebay_app_token: 'T' }) };
  // 40 curated, ALL sold — the route can never fill 12 and must stop at the cap
  const pool = Array.from({ length: 40 }, (_, i) => '5000000000' + String(10 + i));
  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: pool });
    const id = ebayItemId(url);
    if (id) return jsonResponse(200, soldBody(id));
    throw new Error('unexpected ' + url);
  }, async (getCalls) => {
    const r = await getShowcaseItems(env, ctx);
    await ctx.settle();
    assert.deepStrictEqual(r.items, [], 'nothing to show — all sold');
    const n = getCalls().filter((u) => ebayItemId(u)).length;
    assert.strictEqual(n, 30, 'lookups capped at exactly MAX_PUBLIC_LOOKUPS (30)');
    return r;
  });
});

test('public: known-unavailable in cache is never looked up', async () => {
  const ctx = mockCtx();
  const seed = { ebay_app_token: 'T' };
  const dead = CURATED.slice(0, 3);
  dead.forEach((id) => { seed[`ebay_status_v2_${id}`] = 'unavailable'; });
  const env = { SHOWCASE_CACHE: mockKV(seed) };

  await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: CURATED });
    const id = ebayItemId(url);
    if (id) {
      assert.ok(!dead.includes(id), 'never looks up a cached-unavailable id: ' + id);
      return jsonResponse(200, liveBody(id));
    }
    throw new Error('unexpected ' + url);
  }, async (getCalls) => {
    const r = await getShowcaseItems(env, ctx);
    await ctx.settle();
    assert.strictEqual(r.items.length, 12);
    assert.strictEqual(getCalls().filter((u) => ebayItemId(u)).length, 12, 'exactly 12 lookups (the dead 3 skipped)');
  });
});

test('public: returns < 12 ONLY when the viable curated pool is genuinely exhausted', async () => {
  const ctx = mockCtx();
  const env = { SHOWCASE_CACHE: mockKV({ ebay_app_token: 'T' }) };
  const small = Array.from({ length: 10 }, (_, i) => '3000000000' + String(10 + i)); // only 10 curated
  const sold = new Set([small[1], small[4], small[7]]); // 3 sold → 7 viable
  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: small });
    const id = ebayItemId(url);
    if (id) return jsonResponse(200, sold.has(id) ? soldBody(id) : liveBody(id));
    throw new Error('unexpected ' + url);
  }, async () => {
    const r = await getShowcaseItems(env, ctx);
    await ctx.settle();
    return r;
  });
  assert.strictEqual(out.items.length, 7, 'exactly the 7 genuinely-viable items');
  assert.ok(out.items.every((i) => !sold.has(i.id)));
});

test('public: unverified items only backfill a genuine shortfall; unavailable is never shown', async () => {
  const ctx = mockCtx();
  const env = { SHOWCASE_CACHE: mockKV({ ebay_app_token: 'T' }) };
  const small = ['20000000001', '20000000002', '20000000003', '20000000004'];
  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: small });
    const id = ebayItemId(url);
    if (id === '20000000001') return jsonResponse(200, liveBody(id));
    if (id === '20000000002') return jsonResponse(404, { errors: [{ errorId: 11001 }] });
    if (id) return jsonResponse(200, { itemId: 'v1|' + id + '|0', title: 'Ambiguous ' + id, price: { value: '2', currency: 'USD' }, itemWebUrl: 'w' }); // no signals → unverified
    throw new Error('unexpected ' + url);
  }, async () => {
    const r = await getShowcaseItems(env, ctx);
    await ctx.settle();
    return r;
  });
  const ids = out.items.map((i) => i.id);
  assert.ok(ids.includes('20000000001'), 'the active item is shown');
  assert.ok(!ids.includes('20000000002'), 'the sold (404) item is never shown');
  assert.strictEqual(out.items.length, 3, 'active + 2 unverified backfill (want capped to the 4-id list, 3 renderable)');
});

test('public: token failure → serves whatever the cache fully covers, no throw', async () => {
  const ctx = mockCtx();
  const seed = {};
  CURATED.slice(0, 5).forEach((id) => {
    seed[`ebay_status_v2_${id}`] = 'active';
    seed[`ebay_item_${id}`] = JSON.stringify({ id, title: 't', price: 1, currency: 'USD', image: 'x', url: 'u' });
  });
  const env = { SHOWCASE_CACHE: mockKV(seed), EBAY_CLIENT_ID: '', EBAY_CLIENT_SECRET: '' };
  const out = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: CURATED });
    if (url.includes('oauth2/token')) return jsonResponse(401, { error: 'nope' });
    if (ebayItemId(url)) throw new Error('must not call eBay without a token');
    throw new Error('unexpected ' + url);
  }, async () => getShowcaseItems(env, ctx));
  assert.strictEqual(out.items.length, 5, 'served the 5 fully-cached active items');
});

test('public: randomised — the shown set varies across requests', async () => {
  const ctx = mockCtx();
  const seed = { ebay_app_token: 'T' };
  CURATED.forEach((id) => {
    seed[`ebay_status_v2_${id}`] = 'active';
    seed[`ebay_item_${id}`] = JSON.stringify({ id, title: 't', price: 1, currency: 'USD', image: 'x', url: 'u' });
  });
  const env = { SHOWCASE_CACHE: mockKV(seed) };
  const runs = [];
  await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: CURATED });
    throw new Error('unexpected ' + url);
  }, async () => {
    for (let i = 0; i < 8; i++) runs.push((await getShowcaseItems(env, ctx)).items.map((x) => x.id).join(','));
  });
  runs.forEach((r) => assert.strictEqual(r.split(',').length, 12));
  assert.ok(new Set(runs).size > 1, '12-of-20 selection is randomised across runs');
});

function warmEnv() {
  const seed = { ebay_app_token: 'T' };
  CURATED.forEach((id) => {
    seed[`ebay_status_v2_${id}`] = 'active';
    seed[`ebay_item_${id}`] = JSON.stringify({ id, title: 't', price: 1, currency: 'USD', image: 'x', url: 'u' });
  });
  return { SHOWCASE_CACHE: mockKV(seed) };
}
async function fetchShowcase(origin) {
  const ctx = mockCtx();
  const req = new Request('https://showcase.andickso21.workers.dev/showcase',
    origin ? { headers: { Origin: origin } } : {});
  const res = await withFetch((url) => {
    if (url.endsWith('/showcase.json')) return jsonResponse(200, { itemIds: CURATED });
    throw new Error('unexpected ' + url);
  }, async () => worker.fetch(req, warmEnv(), ctx));
  await ctx.settle();
  return res;
}

test('public: /showcase — body contract, Content-Type and Cache-Control unchanged; Vary: Origin added', async () => {
  const res = await fetchShowcase(); // no Origin
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('Content-Type'), 'application/json');
  assert.strictEqual(res.headers.get('Cache-Control'), 'public, max-age=1800');
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'https://dicksonantiquities.com', 'no Origin → production');
  assert.strictEqual(res.headers.get('Vary'), 'Origin');
  const body = await res.json();
  assert.deepStrictEqual(Object.keys(body), ['items']);
  assert.strictEqual(body.items.length, 12);
});

for (const origin of [
  'https://dicksonantiquities.com',
  'https://www.dicksonantiquities.com',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://[::1]:5500',
]) {
  test(`public: /showcase echoes allowed Origin ${origin}`, async () => {
    const res = await fetchShowcase(origin);
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), origin);
    assert.strictEqual(res.headers.get('Vary'), 'Origin');
    assert.strictEqual(res.headers.get('Cache-Control'), 'public, max-age=1800');
    assert.strictEqual((await res.json()).items.length, 12);
  });
}

test('public: /showcase does NOT echo a disallowed Origin (no wildcard, no LAN)', async () => {
  for (const bad of ['https://evil.example', 'http://192.168.1.50:5500', 'http://localhost.evil.com']) {
    const res = await fetchShowcase(bad);
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), null, bad + ' must not be echoed');
    assert.notStrictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.strictEqual((await res.json()).items.length, 12, 'body still produced (browser enforces the block)');
  }
});

test('public: /showcase OPTIONS preflight is loopback-aware (204 + echoed Origin + Vary + methods)', async () => {
  const ctx = mockCtx();
  const res = await worker.fetch(
    new Request('https://showcase.andickso21.workers.dev/showcase', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5500' } }),
    warmEnv(), ctx
  );
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5500');
  assert.strictEqual(res.headers.get('Vary'), 'Origin');
  assert.strictEqual(res.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.strictEqual(res.headers.get('Access-Control-Max-Age'), '86400');
});

test('admin: /showcase/status CORS + contract unchanged (still loopback-aware)', async () => {
  const ctx = mockCtx();
  // 3 ids, all seeded 'active' in KV → handler makes no outgoing fetch at all
  const res = await withFetch(() => { throw new Error('no outgoing fetch expected'); },
    async () => worker.fetch(
      new Request('https://showcase.andickso21.workers.dev/showcase/status?ids=' + CURATED.slice(0, 3).join(','),
        { headers: { Origin: 'http://localhost:5500' } }),
      warmEnv(), ctx
    ));
  await ctx.settle();
  assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5500');
  assert.strictEqual(res.headers.get('Vary'), 'Origin');
  const body = await res.json();
  assert.ok(Array.isArray(body.statuses) && typeof body.total === 'number' && body.counts, 'status contract intact');
  assert.strictEqual(body.statuses.length, 3);
});

test('public: empty curated list → { items: [] }', async () => {
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
