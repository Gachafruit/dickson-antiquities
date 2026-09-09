/**
 * Dickson Antiquities Showcase Worker
 * Deploy to: https://showcase.andickso21.workers.dev
 *
 * Routes:
 *   GET /showcase          Public. Random sample of ACTIVE curated items. Draws
 *                          replacement candidates past sold/ended listings until
 *                          it has up to 12 valid items or the list is exhausted.
 *                          Response contract unchanged: { items: [ … ] }. CORS
 *                          echoes the production site or any loopback dev origin.
 *   GET /showcase/status   Admin. Availability of every curated item id.
 *                          ?ids=<comma-separated> optional; defaults to the full
 *                          list in the deployed showcase.json.
 *
 * Both routes share one availability classifier and one KV cache:
 *   ebay_status_v2_<id>  verdict string ('active' | 'unavailable'), short TTL
 *   ebay_item_<id>       normalized display fields, 1 h TTL
 * The admin sweep pre-warms both, so a public hit shortly after a sweep makes
 * few or zero eBay calls. The public route also writes back what it learns.
 *
 * Availability classification (see classifyItemBody):
 *   A 200 from the eBay Browse API does NOT by itself mean "active" — eBay keeps
 *   returning ended/sold listings (HTTP 200 with full data) for a while.
 *
 *   active       body's availability signals (itemEndDate, estimated availability
 *                status/quantity) all say live, none say ended
 *   unavailable  HTTP 404 (errorId 11001/11002)  -OR-  body's signals all say
 *                ended (past itemEndDate and/or OUT_OF_STOCK / qty 0), none say live
 *   unverified   ANY ambiguous outcome — no usable availability fields,
 *                contradictory fields, auth error, rate limit, 5xx, timeout,
 *                network failure, malformed body, unexpected 404 code.
 *                Unverified items are NEVER eligible for automatic cleanup.
 */

// ── Cache keys / tuning ──────────────────────────────────────────────────────
const TOKEN_CACHE_KEY = 'ebay_app_token';
const ITEMS_CACHE_PREFIX = 'ebay_item_';
// v2: bumped when the status classification rules change so stale "active"
// verdicts for now-ended items are not served from an old cache.
const STATUS_CACHE_PREFIX = 'ebay_status_v2_';
const TOKEN_CACHE_DURATION = 7000; // ~2 hours (eBay tokens expire at 7200s)
const ITEM_CACHE_DURATION = 3600; // 1 hour per item
const STATUS_CACHE_ACTIVE_TTL = 1800; // 30 min — matches the public browser cache; still short enough
                                     // that a sold item is re-detected quickly (was 15 min)
const STATUS_CACHE_UNAVAILABLE_TTL = 21600; // 6 hours (sold stays sold)
const STATUS_CONCURRENCY = 4; // parallel eBay lookups — gentle enough to avoid stale burst responses
const STATUS_MAX_IDS = 250; // hard cap on ids checked per request
const PUBLIC_WANT = 12; // slots the public showcase tries to fill (two desktop columns of six)
const MAX_PUBLIC_LOOKUPS = 30; // cap eBay calls for one cold public request — enough headroom past
                               // dead/unverified candidates to genuinely fill 12 from a ~30-id list
const PUBLIC_CONCURRENCY = 4; // parallel eBay lookups in the cold-cache fill phase
const EBAY_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 400;
// A verdict of `unverified` for one of these reasons is retried once.
const TRANSIENT_REASON = /^(timeout|network-error|http-(429|5\d\d))$/;

const PUBLIC_ORIGIN = 'https://dicksonantiquities.com';

/**
 * Main request handler
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handlePreflight(request, url);
    }

    // ── Public route ─────────────────────────────────────────────────────
    // Fill / cache / randomization logic is unchanged. CORS is now loopback-aware
    // (same allow-list as /showcase/status) so the layout can be tested locally
    // against the real deployed Worker.
    if (request.method === 'GET' && url.pathname === '/showcase') {
      const cors = corsHeaders(request.headers.get('Origin'));
      try {
        const result = await getShowcaseItems(env, ctx);
        return new Response(JSON.stringify(result), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=1800', // Cache in browser for 30 min
            ...cors,
          },
        });
      } catch (error) {
        console.error('Showcase error:', error);
        return new Response(
          JSON.stringify({
            error: 'Failed to fetch showcase items',
            items: [],
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...cors },
          }
        );
      }
    }

    // ── Admin status route — NEW ──────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/showcase/status') {
      return handleStatus(request, url, env, ctx);
    }

    // 404 for other routes
    return new Response('Not Found', { status: 404 });
  },
};

// ── CORS ────────────────────────────────────────────────────────────────────

/**
 * Which Access-Control-Allow-Origin to echo. Allowed: the production site
 * (with/without www) and any loopback dev origin (localhost / 127.0.0.1 / [::1],
 * any port) so both the public route and the admin tool can be exercised from a
 * local static server / Live Server. A request with no Origin header (curl,
 * monitors, the site's own same-origin fetch) resolves to the production origin.
 * Returns null for anything else — never a wildcard, never arbitrary LAN IPs.
 */
function resolveCorsOrigin(origin) {
  if (!origin) return PUBLIC_ORIGIN;
  if (origin === PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  if (origin === 'https://www.dicksonantiquities.com') return origin;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin;
  if (/^https?:\/\/\[::1\](:\d+)?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(origin) {
  const allowed = resolveCorsOrigin(origin);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = allowed;
  return headers;
}

/**
 * Preflight. /showcase and /showcase/status both get the loopback-aware
 * response; any other path keeps the original public-only preflight.
 */
function handlePreflight(request, url) {
  if (url.pathname === '/showcase' || url.pathname === '/showcase/status') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request.headers.get('Origin')),
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://dicksonantiquities.com',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ── /showcase (public) ─────────────────────────────────────────────────────

/**
 * Build the public showcase: up to PUBLIC_WANT active curated items, drawing
 * replacements past sold/ended listings. Reuses cached availability + details
 * from the admin sweep and its own prior runs; only calls eBay where a slot
 * still needs filling and the cache can't answer.
 *
 * Two phases: (1) fill from cache only — zero eBay calls, the common case right
 * after an admin sweep; (2) if still short, live-check the remaining candidates
 * in bounded concurrent waves, stopping as soon as PUBLIC_WANT is reached.
 *
 * Response contract is unchanged: { items: [ {id,title,price,currency,image,url} ] }.
 */
async function getShowcaseItems(env, ctx) {
  const showcaseResponse = await fetch('https://dicksonantiquities.com/showcase.json');
  if (!showcaseResponse.ok) {
    throw new Error('Failed to fetch showcase.json');
  }

  const showcaseData = await showcaseResponse.json();
  const allItemIds = parseIdList(showcaseData.itemIds || []);
  if (allItemIds.length === 0) {
    return { items: [] };
  }

  const want = Math.min(PUBLIC_WANT, allItemIds.length);

  // eBay OAuth token. If it fails we still serve whatever the cache covers.
  let token = null;
  try {
    token = await getEbayToken(env, ctx);
  } catch (err) {
    console.error('Showcase: eBay token unavailable:', err.message);
  }

  // Cached availability for the whole curated list — KV reads only, no eBay.
  const cachedStatus = {};
  if (env.SHOWCASE_CACHE) {
    await Promise.all(
      allItemIds.map(async (id) => {
        cachedStatus[id] = await env.SHOWCASE_CACHE.get(`${STATUS_CACHE_PREFIX}${id}`).catch(() => null);
      })
    );
  }

  // Known-active first (fewest live lookups), then unknowns; known-unavailable
  // are never candidates. Randomised within each group.
  const candidates = publicCandidateOrder(allItemIds, cachedStatus);

  const active = [];
  const spare = []; // renderable but unverified — used only to backfill

  // ── Phase 1: cache only — no eBay calls ──────────────────────────────────
  const needsLookup = [];
  for (const id of candidates) {
    if (active.length >= want) break;
    if (cachedStatus[id] === 'active' && env.SHOWCASE_CACHE) {
      const detail = await env.SHOWCASE_CACHE.get(`${ITEMS_CACHE_PREFIX}${id}`, 'json').catch(() => null);
      if (detail && detail.id) {
        active.push(detail);
        continue;
      }
    }
    needsLookup.push(id);
  }

  // ── Phase 2: live lookups for whatever the cache couldn't fill ───────────
  if (active.length < want && token) {
    let lookups = 0;
    for (
      let i = 0;
      i < needsLookup.length && active.length < want && lookups < MAX_PUBLIC_LOOKUPS;
      i += PUBLIC_CONCURRENCY
    ) {
      const wave = needsLookup
        .slice(i, i + PUBLIC_CONCURRENCY)
        .slice(0, MAX_PUBLIC_LOOKUPS - lookups);
      lookups += wave.length;
      const results = await Promise.all(
        wave.map((id) => resolveShowcaseItem(id, token, env, ctx))
      );
      for (const { verdict, item } of results) {
        if (verdict === 'active' && item) active.push(item);
        else if (verdict === 'unverified' && item) spare.push(item);
        // 'unavailable' (or no renderable body) → slot not consumed
      }
    }
  }

  return { items: assembleShowcase(active, spare, want) };
}

/**
 * Candidate order for filling public slots. Pure.
 * Known-unavailable ids are dropped; known-active come first; each group shuffled.
 */
function publicCandidateOrder(allItemIds, cachedStatus, shuffle = selectRandomItems) {
  const known = shuffle(allItemIds.filter((id) => cachedStatus[id] === 'active'), allItemIds.length);
  const unknown = shuffle(allItemIds.filter((id) => !cachedStatus[id]), allItemIds.length);
  return known.concat(unknown);
}

/**
 * Final slot assembly. Pure. Active items fill first; unverified-but-renderable
 * items backfill only if active runs short; never more than `want`.
 */
function assembleShowcase(active, spare, want) {
  const out = active.slice(0, want);
  for (const s of spare) {
    if (out.length >= want) break;
    out.push(s);
  }
  return out;
}

/** Select N random items from an array (N defaults to the whole array = shuffle). */
function selectRandomItems(array, n = array.length) {
  const shuffled = [...array].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

/**
 * One eBay lookup for the public route: classify availability AND extract the
 * display fields from the same response, caching both. Returns { verdict, item }.
 */
async function resolveShowcaseItem(itemId, token, env, ctx) {
  let response;
  try {
    response = await fetchWithTimeout(
      `https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ePNCampaignId>',
        },
      },
      EBAY_TIMEOUT_MS
    );
  } catch {
    return { verdict: 'unverified', item: null };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    /* body stays null */
  }

  const verdict = classifyHttp(itemId, response.status, body).status;
  if (verdict === 'active' || verdict === 'unavailable') {
    cacheStatus(env, ctx, itemId, verdict);
  }

  let item = null;
  if (response.status === 200 && body && (body.itemId || body.title)) {
    item = normalizeItem(itemId, body);
    cacheItem(env, ctx, itemId, item);
  }
  return { verdict, item };
}

/** Browse API body → the site's item shape. */
function normalizeItem(itemId, data) {
  return {
    id: itemId,
    title: data.title || 'Untitled',
    price: data.price?.value || 0,
    currency: data.price?.currency || 'USD',
    image: data.image?.imageUrl || data.thumbnailImages?.[0]?.imageUrl || '',
    url: data.itemWebUrl || `https://www.ebay.com/itm/${itemId}`,
  };
}

function cacheItem(env, ctx, itemId, item) {
  if (!env.SHOWCASE_CACHE) return;
  ctx.waitUntil(
    env.SHOWCASE_CACHE.put(`${ITEMS_CACHE_PREFIX}${itemId}`, JSON.stringify(item), {
      expirationTtl: ITEM_CACHE_DURATION,
    })
  );
}

/**
 * Get eBay OAuth application token (cached)
 */
async function getEbayToken(env, ctx) {
  // Check cache first
  const cached = await env.SHOWCASE_CACHE?.get(TOKEN_CACHE_KEY);
  if (cached) {
    return cached;
  }

  // Get new token from eBay
  const clientId = env.EBAY_CLIENT_ID;
  const clientSecret = env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('eBay credentials not configured');
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`eBay OAuth failed: ${error}`);
  }

  const data = await response.json();
  const token = data.access_token;

  // Cache token (expires in ~2 hours, we cache for slightly less)
  if (env.SHOWCASE_CACHE) {
    ctx.waitUntil(
      env.SHOWCASE_CACHE.put(TOKEN_CACHE_KEY, token, {
        expirationTtl: TOKEN_CACHE_DURATION,
      })
    );
  }

  return token;
}

// ── /showcase/status (admin) ────────────────────────────────────────────────

async function handleStatus(request, url, env, ctx) {
  const cors = corsHeaders(request.headers.get('Origin'));
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });

  // 1. Resolve the id list — explicit ?ids= wins, else the deployed showcase.json
  let ids;
  const idsParam = url.searchParams.get('ids');
  if (idsParam !== null) {
    ids = parseIdsParam(idsParam);
    if (ids.length === 0) {
      return json({ error: 'No valid eBay item ids in ?ids=' }, 400);
    }
  } else {
    try {
      const res = await fetch(`${PUBLIC_ORIGIN}/showcase.json`, { cf: { cacheTtl: 0 } });
      if (!res.ok) throw new Error('showcase.json HTTP ' + res.status);
      const data = await res.json();
      ids = parseIdList(data.itemIds || []);
    } catch (err) {
      return json({ error: 'Failed to load showcase.json: ' + err.message }, 502);
    }
  }
  ids = ids.slice(0, STATUS_MAX_IDS);

  // 2. Token — if we cannot get one, EVERYTHING is unverified (never "sold")
  let token = null;
  let tokenError = null;
  try {
    token = await getEbayToken(env, ctx);
  } catch (err) {
    tokenError = err.message;
  }

  // 3. Classify
  let statuses;
  if (!token) {
    statuses = ids.map((id) => ({ id, status: 'unverified', reason: 'no-token' }));
  } else {
    statuses = await classifyAll(ids, token, env, ctx);
  }

  const body = {
    checkedAt: new Date().toISOString(),
    total: ids.length,
    counts: buildStatusCounts(statuses),
    statuses,
  };
  if (tokenError) body.warning = 'eBay authentication unavailable; all items reported unverified.';
  return json(body);
}

function parseIdList(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = String(raw).trim();
    if (/^\d{6,20}$/.test(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function parseIdsParam(param) {
  return parseIdList(String(param).split(','));
}

async function classifyAll(ids, token, env, ctx) {
  const results = new Array(ids.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      results[i] = await classifyItemId(ids[i], token, env, ctx);
    }
  };
  const pool = Array.from({ length: Math.min(STATUS_CONCURRENCY, ids.length) }, worker);
  await Promise.all(pool);
  return results;
}

async function classifyItemId(itemId, token, env, ctx) {
  // Fast path: a definitive verdict cached by a previous /showcase/status run.
  // (The public route's ebay_item_ cache is NOT trusted here — it stores any
  //  HTTP 200 body, including still-returned sold listings.)
  if (env.SHOWCASE_CACHE) {
    const cachedStatus = await env.SHOWCASE_CACHE.get(`${STATUS_CACHE_PREFIX}${itemId}`).catch(() => null);
    if (cachedStatus === 'active' || cachedStatus === 'unavailable') {
      return { id: itemId, status: cachedStatus, reason: 'cache' };
    }
  }

  let result = await lookupAndClassify(itemId, token, env, ctx);

  // One retry for a transient failure — never for a definitive verdict.
  if (result.status === 'unverified' && TRANSIENT_REASON.test(result.reason || '')) {
    await sleep(RETRY_DELAY_MS);
    result = await lookupAndClassify(itemId, token, env, ctx);
  }

  if (result.status === 'active' || result.status === 'unavailable') {
    cacheStatus(env, ctx, itemId, result.status);
  }
  return result;
}

async function lookupAndClassify(itemId, token, env, ctx) {
  let response;
  try {
    response = await fetchWithTimeout(
      `https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      },
      EBAY_TIMEOUT_MS
    );
  } catch (err) {
    return { id: itemId, status: 'unverified', reason: err.name === 'AbortError' ? 'timeout' : 'network-error' };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    /* body stays null */
  }

  // Pre-warm the details cache the public route reads (only for renderable bodies).
  if (env && ctx && response.status === 200 && body && (body.itemId || body.title)) {
    cacheItem(env, ctx, itemId, normalizeItem(itemId, body));
  }

  return classifyHttp(itemId, response.status, body);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Classify one eBay Browse API response object (needs `.status` + async `.json()`).
 * Thin wrapper around classifyHttp — kept for the unit tests.
 */
async function classifyResponse(itemId, response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* body stays null */
  }
  return classifyHttp(itemId, response.status, body);
}

/**
 * Classify from an HTTP status code + already-parsed body (or null).
 *   200 + usable body → classifyItemBody
 *   404 (errorId 11001/11002, or no body) → unavailable
 *   anything else → unverified
 */
function classifyHttp(itemId, code, body) {
  if (code === 200) {
    if (body == null || typeof body !== 'object') {
      return { id: itemId, status: 'unverified', reason: 'bad-json' };
    }
    return classifyItemBody(itemId, body);
  }

  if (code === 404) {
    const errors = Array.isArray(body && body.errors) ? body.errors : [];
    let firstErrorId = null;
    if (errors.length) {
      firstErrorId = errors[0].errorId ?? null;
      const notFound = [11001, 11002];
      if (!errors.some((e) => notFound.includes(Number(e.errorId)))) {
        return { id: itemId, status: 'unverified', reason: `ebay-404-unexpected-${firstErrorId}` };
      }
    }
    return { id: itemId, status: 'unavailable', reason: firstErrorId ? `ebay-404-${firstErrorId}` : 'ebay-404' };
  }

  // 401 / 403 / 429 / 400 / 5xx / anything else → ambiguous, never removable
  return { id: itemId, status: 'unverified', reason: `http-${code}` };
}

/**
 * Pure classification of a Browse API `getItem` body (HTTP 200 already checked).
 * Returns { id, status, reason, title?, url? }.
 *
 * eBay keeps serving ended/sold listings as HTTP 200 for a while, so the body
 * must be read. Two independent fields carry availability:
 *   · itemEndDate                    — past  ⇒ ended,   future ⇒ live
 *   · estimatedAvailabilityStatus /  — OUT_OF_STOCK / qty 0 ⇒ ended,
 *     estimatedAvailableQuantity        IN_STOCK / LIMITED_STOCK ⇒ live
 * (Observed: a genuinely sold fixed-price listing reports itemEndDate in the
 *  past AND OUT_OF_STOCK, qty 0, estimatedSoldQuantity 1.)
 *
 * Verdict by signal agreement — conservative on any disagreement or silence:
 *   only "ended" signals, no "live" signal          → unavailable
 *   only "live"  signals, no "ended" signal         → active
 *   signals disagree                                → unverified (contradictory)
 *   no usable availability signal at all            → unverified
 */
function classifyItemBody(itemId, data) {
  const base = { id: itemId };
  if (!data || typeof data !== 'object' || !(data.itemId || data.title || data.itemWebUrl)) {
    return { ...base, status: 'unverified', reason: 'unexpected-200-body' };
  }
  base.title = data.title || null;
  base.url = data.itemWebUrl || `https://www.ebay.com/itm/${itemId}`;

  const end = endDateState(data.itemEndDate); // 'past' | 'future' | 'absent'
  const avail = availabilitySignal(data); // 'in' | 'out' | 'none'

  const ended = [];
  const live = [];
  if (end === 'past') ended.push(`ended-${data.itemEndDate}`);
  if (end === 'future') live.push(`ends-${data.itemEndDate}`);
  if (avail === 'out') ended.push('out-of-stock');
  if (avail === 'in') live.push('in-stock');

  if (ended.length && !live.length) {
    return { ...base, status: 'unavailable', reason: ended.join('+') };
  }
  if (live.length && !ended.length) {
    return { ...base, status: 'active', reason: null };
  }
  if (ended.length && live.length) {
    return { ...base, status: 'unverified', reason: `contradictory:${ended.concat(live).join('+')}` };
  }
  return { ...base, status: 'unverified', reason: 'no-availability-signal' };
}

function endDateState(raw) {
  if (!raw) return 'absent';
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return 'absent';
  return t < Date.now() ? 'past' : 'future';
}

/**
 * Reduce eBay's availability fields to 'in' | 'out' | 'none'.
 * Checks estimatedAvailabilityStatus (IN_STOCK / LIMITED_STOCK / OUT_OF_STOCK)
 * and estimatedAvailableQuantity, both top-level and inside estimatedAvailabilities[].
 */
function availabilitySignal(data) {
  const statuses = [];
  const quantities = [];

  if (typeof data.estimatedAvailabilityStatus === 'string') statuses.push(data.estimatedAvailabilityStatus);
  if (typeof data.estimatedAvailableQuantity === 'number') quantities.push(data.estimatedAvailableQuantity);

  const arr = Array.isArray(data.estimatedAvailabilities) ? data.estimatedAvailabilities : [];
  for (const a of arr) {
    if (a && typeof a.estimatedAvailabilityStatus === 'string') statuses.push(a.estimatedAvailabilityStatus);
    if (a && typeof a.estimatedAvailableQuantity === 'number') quantities.push(a.estimatedAvailableQuantity);
  }

  const hasIn = statuses.some((s) => s === 'IN_STOCK' || s === 'LIMITED_STOCK');
  const hasOut = statuses.some((s) => s === 'OUT_OF_STOCK');
  const knownStatus = statuses.some((s) => ['IN_STOCK', 'LIMITED_STOCK', 'OUT_OF_STOCK'].includes(s));

  if (hasOut && !hasIn) return 'out';
  if (hasIn && !hasOut) return 'in';
  if (hasIn && hasOut) return 'none'; // contradictory statuses → no signal

  // No usable status enum. Fall back to quantity only if it's unambiguous.
  if (!knownStatus && quantities.length) {
    if (quantities.every((q) => q === 0)) return 'out';
    if (quantities.every((q) => q > 0)) return 'in';
  }
  return 'none';
}

function buildStatusCounts(statuses) {
  const counts = { active: 0, unavailable: 0, unverified: 0 };
  for (const s of statuses) {
    if (counts[s.status] === undefined) counts.unverified++;
    else counts[s.status]++;
  }
  return counts;
}

function cacheStatus(env, ctx, itemId, status) {
  if (!env.SHOWCASE_CACHE) return;
  const ttl = status === 'active' ? STATUS_CACHE_ACTIVE_TTL : STATUS_CACHE_UNAVAILABLE_TTL;
  ctx.waitUntil(
    env.SHOWCASE_CACHE.put(`${STATUS_CACHE_PREFIX}${itemId}`, status, { expirationTtl: ttl })
  );
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Exposed for unit tests (ignored by the Workers runtime).
export {
  getShowcaseItems,
  publicCandidateOrder,
  assembleShowcase,
  normalizeItem,
  classifyResponse,
  classifyHttp,
  classifyItemBody,
  availabilitySignal,
  endDateState,
  buildStatusCounts,
  parseIdList,
  parseIdsParam,
  resolveCorsOrigin,
};
