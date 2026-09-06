# Showcase Worker

Backs the homepage "From Our Collection" section and the admin Showcase Manager's
availability check. Deployed at `https://showcase.andickso21.workers.dev`.

## Routes

### `GET /showcase` — public, unchanged

Returns up to 6 random **active** items for the site:

```json
{ "items": [ { "id", "title", "price", "currency", "image", "url" }, ... ] }
```

Sold/ended items are silently dropped (eBay Browse API returns 404 → `getItemDetails`
returns `null`). Response contract and CORS (`https://dicksonantiquities.com`) are
untouched by the status route.

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

Reuses the existing OAuth token (KV `ebay_app_token`). Adds a short-lived
per-status cache `ebay_status_v2_<id>` (15 min active / 6 h unavailable;
`unverified` is never cached). eBay's Browse API occasionally serves a stale
(pre-sale) body under a concurrent burst, so lookups run at low concurrency (4),
a transient failure (timeout / network / 429 / 5xx) is retried once, and the
short "active" TTL lets any stale "active" self-heal on the next check. The
public route's `ebay_item_<id>` cache is **not** trusted for status — it stores
any 200 body, sold listings included. The `_v2` suffix is bumped whenever the
classification rules change so stale verdicts are never served.

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
ambiguous failure → unverified), `?ids=` parsing, CORS origin resolution, and
count tallying.
