# Showcase Worker

Backs the homepage "From Our Collection" section and the admin Showcase Manager's
availability check. Deployed at `https://showcase.andickso21.workers.dev`.

## Routes

### `GET /showcase` — public

Returns up to **12** `active` items (`PUBLIC_WANT`), chosen at random from the
curated `showcase.json` allow-list — the homepage renders them as two desktop
columns of six. Response contract unchanged:

```json
{ "items": [ { "id", "title", "price", "currency", "image", "url" }, ... ] }
```

`Content-Type: application/json` and `Cache-Control: public, max-age=1800` are
unchanged. CORS now uses the same loopback-aware allow-list as `/showcase/status`
(via the shared `corsHeaders` / `resolveCorsOrigin` helpers): it echoes the exact
matched `Origin` and adds `Vary: Origin`. Allowed: `https://dicksonantiquities.com`,
`https://www.dicksonantiquities.com`, and `http://localhost` / `http://127.0.0.1`
/ `http://[::1]` on any port (so the layout can be tested locally against the real
deployed Worker). A request with no `Origin` still resolves to the production
origin. Anything else gets no `Access-Control-Allow-Origin` header — never `*`,
never arbitrary LAN IPs.

**Slot filling.** Instead of picking exactly 12 ids and showing whatever
survives, the route draws replacement candidates past sold/ended listings until
it has 12 active items (or the curated list is exhausted). It reuses the same
classifier and KV caches as `/showcase/status`, in two phases:

1. Read `ebay_status_v2_<id>` for the whole list (KV only — no eBay calls).
   Known-`unavailable` ids are dropped; known-`active` ids are tried first.
2. **Phase 1 (cache only):** for each candidate cached `active` **and** with
   `ebay_item_<id>` details cached → use it. Zero eBay calls. This fills all 12
   right after an admin sweep.
3. **Phase 2 (only if short):** live-check the remaining candidates in concurrent
   waves of `PUBLIC_CONCURRENCY` (4). Each `getItem` call yields both a fresh
   verdict and the display fields; both are cached (helping the admin sweep and
   future public hits). Stops as soon as 12 active are collected.
4. Still short? Backfill with `unverified`-but-renderable items (ambiguous 200
   bodies) — never with anything classified `unavailable`.

Randomness is preserved (each group is shuffled); only curated ids are ever
surfaced. Live lookups are capped at `MAX_PUBLIC_LOOKUPS` (30) per cold request —
enough to check a whole ~30-id list to genuinely fill 12. If the OAuth token
can't be obtained, the route still serves whatever the cache fully covers rather
than erroring.

Because the admin sweep pre-warms both caches, a public hit within
`STATUS_CACHE_ACTIVE_TTL` (30 min) of a sweep typically makes **zero** eBay calls
even for 12 items.

*Future option:* the cold path could use eBay's `getItems` (plural, ≤20 ids/call)
to collapse ~16–30 sequential lookups into 1–2 — deferred for now (different
response shape + all-or-nothing failure mode vs. today's per-item resilience).

### `GET /showcase/status` — admin

Checks **every** curated id and reports availability. Used by the Showcase Manager
to find stale sold listings.

Query:

- `?ids=187370603142,187860554164,...` — check exactly this list (what the manager
  sends: its current draft). Ids validated as 6–20 digits, deduped, capped at 250.
- omitted — falls back to the id list in the deployed `showcase.json`.

Response:

```json
{
  "checkedAt": "2026-09-06T12:00:00.000Z",
  "total": 30,
  "counts": { "active": 17, "unavailable": 12, "unverified": 1 },
  "statuses": [
    { "id": "187370603142", "status": "active",      "reason": null,       "title": "...", "url": "..." },
    { "id": "187148798269", "status": "unavailable", "reason": "ebay-404-11001" },
    { "id": "187999999999", "status": "unverified",  "reason": "http-429" }
  ]
}
```

Classification — a 200 from the Browse API does **not** by itself mean active
(eBay serves ended/sold listings as 200 with full data for a while). The body's
availability signals are read: `itemEndDate` (past ⇒ ended / future ⇒ live) and
`estimatedAvailabilityStatus` + `estimatedAvailableQuantity` (`OUT_OF_STOCK` or
qty 0 ⇒ ended / `IN_STOCK` / `LIMITED_STOCK` ⇒ live).

| status        | when                                                                              | auto-cleanup eligible |
| ------------- | -------------------------------------------------------------------------------- | --------------------- |
| `active`      | HTTP 200, body's availability signals all say live, none say ended               | no (kept)             |
| `unavailable` | HTTP 404 (`errorId` 11001 / 11002)  **or**  HTTP 200 whose signals all say ended (past `itemEndDate` and/or `OUT_OF_STOCK` / qty 0) | **yes** |
| `unverified`  | signals disagree; no usable availability field; 401 / 403 / 429 / 400 / 5xx; timeout; network error; bad JSON; unexpected 404 code; no OAuth token | **never** |

The observed signature of a genuinely sold fixed-price listing: HTTP 200,
`itemEndDate` in the past, `estimatedAvailabilityStatus: OUT_OF_STOCK`,
`estimatedAvailableQuantity: 0`, `estimatedSoldQuantity: 1`.

CORS: identical to `/showcase` (shared `corsHeaders` / `resolveCorsOrigin`) — the
production origin(s) plus any loopback dev origin, echoed exactly, with
`Vary: Origin`.

Reuses the existing OAuth token (KV `ebay_app_token`). Shared KV caches:

- `ebay_status_v2_<id>` — verdict string, **30 min** for `active` / 6 h for
  `unavailable`; `unverified` is never cached. Written by **both** routes. The
  30-min active TTL matches the public browser cache (`max-age=1800`), so a
  public hit that soon after a sweep re-verifies nothing — it was 15 min, raised
  when the public target doubled to 12 to keep that window a zero-eBay-call hit.
- `ebay_item_<id>` — normalized display fields, 1 h. Written whenever either
  route sees a renderable 200 body, so the admin sweep pre-warms the public
  route's details.

The `ebay_item_<id>` cache is **not** trusted as an availability signal (it
stores any 200 body, sold listings included) — the public route only uses it for
display, and only for ids independently known `active`.

eBay's Browse API occasionally serves a stale (pre-sale) body under a concurrent
burst, so both the status sweep and the public cold-fill run at low concurrency
(4), and a transient failure (timeout / network / 429 / 5xx) is retried once (on
the status route). The `_v2` suffix is bumped whenever the classification rules
change so stale verdicts are never served.

## Deploy

```
cd workers/showcase
# set the real KV id in wrangler.toml (npx wrangler kv namespace list)
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
npx wrangler deploy
```

## Test

```
node workers/showcase/test.mjs
```

Covers the classification rules (200 → active, 404/11001 → unavailable, every
ambiguous failure → unverified), `?ids=` parsing, CORS origin resolution, count
tallying, and the public fill logic (fills to 6 past sold candidates; zero eBay
calls when the cache covers it; known-unavailable skipped; unverified backfill
only; contract unchanged) with a mocked `fetch` + KV.
