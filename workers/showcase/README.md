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

Classification:

| status        | when                                                                              | auto-cleanup eligible |
| ------------- | -------------------------------------------------------------------------------- | --------------------- |
| `active`      | HTTP 200 with a usable item body (or a cached normalized item)                    | no (kept)             |
| `unavailable` | HTTP 404 — bare, or eBay `errorId` 11001 / 11002 ("item not found")              | **yes**               |
| `unverified`  | 401 / 403 / 429 / 400 / 5xx, timeout, network error, bad JSON, unexpected 404 code, no OAuth token | **never** |

CORS: the public origin plus `http://localhost[:port]` / `http://127.0.0.1[:port]`
/ `http://[::1][:port]` so the admin tool works when served locally.

Reuses the existing OAuth token (KV `ebay_app_token`) and per-item cache
(`ebay_item_<id>`), and adds a short-lived per-status cache (`ebay_status_<id>`,
1 h for active / 6 h for unavailable; `unverified` is never cached so transient
failures retry).

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
