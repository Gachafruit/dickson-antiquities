# Showcase Worker

Backs the homepage "From Our Collection" section and the admin Showcase Manager's
availability check. Deployed at `https://showcase.andickso21.workers.dev`.

## Routes

### `GET /showcase` — public

Returns up to 6 **active** items, chosen at random from the curated `showcase.json`
allow-list. Response contract and CORS (`https://dicksonantiquities.com`) unchanged:

```json
{ "items": [ { "id", "title", "price", "currency", "image", "url" }, ... ] }
```

**Slot filling.** Instead of picking exactly 6 ids and showing whatever survives,
the route draws replacement candidates past sold/ended listings until it has 6
active items (or the curated list is exhausted). It reuses the same classifier and
KV caches as `/showcase/status`:

1. Read `ebay_status_v2_<id>` for the whole list (KV only — no eBay calls).
   Known-`unavailable` ids are dropped; known-`active` ids are tried first.
2. For each candidate, if it is cached `active` **and** its `ebay_item_<id>`
   details are cached → use it, zero eBay calls.
3. Otherwise do one `getItem` call: that single response yields both a fresh
   availability verdict and the display fields, and both are cached (so the
   verdict also helps the admin sweep, and vice-versa).
4. Stop at 6 active. If still short, backfill with `unverified`-but-renderable
   items (ambiguous 200 bodies) — never with anything classified `unavailable`.

Randomness is preserved (each group is shuffled); only curated ids are ever
surfaced. Live lookups are capped at 18 per cold request. If the OAuth token
can't be obtained, the route still serves whatever the cache fully covers rather
than erroring.

Because the admin sweep pre-warms both caches, a public hit shortly after a
sweep typically makes **zero** eBay calls.

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

CORS: the public origin plus `http://localhost[:port]` / `http://127.0.0.1[:port]`
/ `http://[::1][:port]` so the admin tool works when served locally.

Reuses the existing OAuth token (KV `ebay_app_token`). Shared KV caches:

- `ebay_status_v2_<id>` — verdict string, 15 min for `active` / 6 h for
  `unavailable`; `unverified` is never cached. Written by **both** routes.
- `ebay_item_<id>` — normalized display fields, 1 h. Written whenever either
  route sees a renderable 200 body, so the admin sweep pre-warms the public
  route's details.

The `ebay_item_<id>` cache is **not** trusted as an availability signal (it
stores any 200 body, sold listings included) — the public route only uses it for
display, and only for ids independently known `active`.

eBay's Browse API occasionally serves a stale (pre-sale) body under a concurrent
burst, so status lookups run at low concurrency (4), a transient failure
(timeout / network / 429 / 5xx) is retried once, and the short `active` TTL lets
any stale `active` self-heal on the next check. The `_v2` suffix is bumped
whenever the classification rules change so stale verdicts are never served.

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
