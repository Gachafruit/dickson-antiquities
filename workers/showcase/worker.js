/**
 * Dickson Antiquities Showcase Worker
 * Deploy to: https://showcase.andickso21.workers.dev
 *
 * Routes:
 *   GET /showcase          Public. Random sample of active items for the site.
 *                          UNCHANGED — same logic, same response contract.
 *   GET /showcase/status   Admin. Availability of every curated item id.
 *                          ?ids=<comma-separated> optional; defaults to the full
 *                          list in the deployed showcase.json.
 *
 * The /showcase/status route reuses the existing OAuth token, KV cache and eBay
 * Browse API lookup. It classifies each id as:
 *   active       eBay returned the item (HTTP 200 with a usable body)
 *   unavailable  eBay returned 404 "not found" (ended / removed / sold)
 *   unverified   ANY ambiguous outcome — auth error, rate limit, 5xx, timeout,
 *                network failure, malformed body, unexpected 404 error code.
 *                Unverified items are NEVER eligible for automatic cleanup.
 */

// ── Cache keys / tuning ──────────────────────────────────────────────────────
const TOKEN_CACHE_KEY = 'ebay_app_token';
const ITEMS_CACHE_PREFIX = 'ebay_item_';
const STATUS_CACHE_PREFIX = 'ebay_status_';
const TOKEN_CACHE_DURATION = 7000; // ~2 hours (eBay tokens expire at 7200s)
const ITEM_CACHE_DURATION = 3600; // 1 hour per item
const STATUS_CACHE_ACTIVE_TTL = 3600; // 1 hour
const STATUS_CACHE_UNAVAILABLE_TTL = 21600; // 6 hours (sold stays sold)
const STATUS_CONCURRENCY = 6; // parallel eBay lookups per batch
const STATUS_MAX_IDS = 250; // hard cap on ids checked per request
const EBAY_TIMEOUT_MS = 8000;

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

    // ── Public route — UNCHANGED ──────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/showcase') {
      try {
        const result = await getShowcaseItems(env, ctx);
        return new Response(JSON.stringify(result), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'https://dicksonantiquities.com',
            'Cache-Control': 'public, max-age=1800', // Cache in browser for 30 min
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
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': 'https://dicksonantiquities.com',
            },
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
 * Which Access-Control-Allow-Origin to echo. The public site is always allowed;
 * the admin tool is additionally allowed from loopback origins so it works when
 * served via `npx serve` / `python -m http.server` on localhost / 127.0.0.1.
 * Returns null for a disallowed origin.
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

function statusCorsHeaders(origin) {
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
 * Preflight. Only /showcase/status gets the dynamic (loopback-aware) response;
 * every other path keeps the original public-only preflight untouched.
 */
function handlePreflight(request, url) {
  if (url.pathname === '/showcase/status') {
    return new Response(null, {
      status: 204,
      headers: {
        ...statusCorsHeaders(request.headers.get('Origin')),
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

// ── /showcase (public) — original logic, unchanged ──────────────────────────

/**
 * Main logic: fetch showcase.json, select random items, get details
 */
async function getShowcaseItems(env, ctx) {
  // 1. Fetch showcase.json from the website
  const showcaseUrl = 'https://dicksonantiquities.com/showcase.json';
  const showcaseResponse = await fetch(showcaseUrl);

  if (!showcaseResponse.ok) {
    throw new Error('Failed to fetch showcase.json');
  }

  const showcaseData = await showcaseResponse.json();
  const allItemIds = showcaseData.itemIds || [];

  if (allItemIds.length === 0) {
    return { items: [] };
  }

  // 2. Select 6 random distinct items (or fewer if list is smaller)
  const numToSelect = Math.min(6, allItemIds.length);
  const selectedIds = selectRandomItems(allItemIds, numToSelect);

  // 3. Get eBay OAuth token
  const token = await getEbayToken(env, ctx);

  // 4. Fetch item details for selected IDs
  const items = [];
  for (const itemId of selectedIds) {
    try {
      const itemData = await getItemDetails(itemId, token, env, ctx);
      if (itemData) {
        items.push(itemData);
      }
    } catch (error) {
      console.error(`Failed to fetch item ${itemId}:`, error);
      // Continue to next item
    }
  }

  return { items };
}

/**
 * Select N random distinct items from array
 */
function selectRandomItems(array, n) {
  const shuffled = [...array].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
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

/**
 * Get item details from eBay Browse API (cached per item)
 */
async function getItemDetails(itemId, token, env, ctx) {
  const cacheKey = `${ITEMS_CACHE_PREFIX}${itemId}`;

  // Check cache first
  if (env.SHOWCASE_CACHE) {
    const cached = await env.SHOWCASE_CACHE.get(cacheKey, 'json');
    if (cached) {
      return cached;
    }
  }

  // Fetch from eBay
  const response = await fetch(
    `https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'X-EBAY-C-ENDUSERCTX': 'affiliateCampaignId=<ePNCampaignId>',
      },
    }
  );

  if (!response.ok) {
    console.error(`eBay API error for item ${itemId}:`, response.status);
    return null;
  }

  const data = await response.json();

  // Normalize the data
  const normalized = {
    id: itemId,
    title: data.title || 'Untitled',
    price: data.price?.value || 0,
    currency: data.price?.currency || 'USD',
    image: data.image?.imageUrl || data.thumbnailImages?.[0]?.imageUrl || '',
    url: data.itemWebUrl || `https://www.ebay.com/itm/${itemId}`,
  };

  // Cache the normalized item
  if (env.SHOWCASE_CACHE) {
    ctx.waitUntil(
      env.SHOWCASE_CACHE.put(cacheKey, JSON.stringify(normalized), {
        expirationTtl: ITEM_CACHE_DURATION,
      })
    );
  }

  return normalized;
}

// ── /showcase/status (admin) ────────────────────────────────────────────────

async function handleStatus(request, url, env, ctx) {
  const cors = statusCorsHeaders(request.headers.get('Origin'));
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
  // Fast paths from KV — reuse what the public route already cached.
  if (env.SHOWCASE_CACHE) {
    const cachedStatus = await env.SHOWCASE_CACHE.get(`${STATUS_CACHE_PREFIX}${itemId}`).catch(() => null);
    if (cachedStatus === 'active' || cachedStatus === 'unavailable') {
      return { id: itemId, status: cachedStatus, reason: 'cache' };
    }
    const cachedItem = await env.SHOWCASE_CACHE.get(`${ITEMS_CACHE_PREFIX}${itemId}`, 'json').catch(() => null);
    if (cachedItem && cachedItem.id) {
      return { id: itemId, status: 'active', reason: 'item-cache', title: cachedItem.title || null, url: cachedItem.url || null };
    }
  }

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

  const result = await classifyResponse(itemId, response);
  if (result.status === 'active' || result.status === 'unavailable') {
    cacheStatus(env, ctx, itemId, result.status);
  }
  return result;
}

/**
 * Pure classification of one eBay Browse API response.
 * `response` needs `.status` and an async `.json()`.
 */
async function classifyResponse(itemId, response) {
  const code = response.status;

  if (code === 200) {
    let data;
    try {
      data = await response.json();
    } catch {
      return { id: itemId, status: 'unverified', reason: 'bad-json' };
    }
    if (data && (data.itemId || data.title || data.itemWebUrl)) {
      return {
        id: itemId,
        status: 'active',
        reason: null,
        title: data.title || null,
        url: data.itemWebUrl || `https://www.ebay.com/itm/${itemId}`,
      };
    }
    return { id: itemId, status: 'unverified', reason: 'unexpected-200-body' };
  }

  if (code === 404) {
    // eBay Browse API returns 404 + errorId 11001/11002 for ended/removed/sold
    // items. A 404 whose body carries a DIFFERENT error is treated as ambiguous.
    let firstErrorId = null;
    try {
      const body = await response.json();
      const errors = Array.isArray(body && body.errors) ? body.errors : [];
      if (errors.length) {
        firstErrorId = errors[0].errorId ?? null;
        const notFound = [11001, 11002];
        if (!errors.some((e) => notFound.includes(Number(e.errorId)))) {
          return { id: itemId, status: 'unverified', reason: `ebay-404-unexpected-${firstErrorId}` };
        }
      }
    } catch {
      // No / invalid body on a 404 is still eBay's "not found" for this endpoint.
    }
    return { id: itemId, status: 'unavailable', reason: firstErrorId ? `ebay-404-${firstErrorId}` : 'ebay-404' };
  }

  // 401 / 403 / 429 / 400 / 5xx / anything else → ambiguous, never removable
  return { id: itemId, status: 'unverified', reason: `http-${code}` };
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
export { classifyResponse, buildStatusCounts, parseIdList, parseIdsParam, resolveCorsOrigin };
