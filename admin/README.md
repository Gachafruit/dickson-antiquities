# Dickson Antiquities — Content Admin

Small browser tools for the parts of the site that change often. **The repository
is the source of truth**; these tools read the current files and write changes
back to them. `localStorage` is only a draft-autosave convenience — it never
decides what the live site shows.

## Running them

Serve the repo root over loopback (any static server), then open
`http://localhost:<port>/admin/`:

```
npx serve .          # or: python -m http.server
```

Use `http://localhost` / `http://127.0.0.1`, **not** a LAN IP and **not**
`file://` — the File System Access API and the JSON fallback fetch both need a
trustworthy origin.

## Tools

| Page | Owns | Writes |
| --- | --- | --- |
| `index.html` | landing page | — |
| `featured-manager.html` | the 9 homepage Featured Finds tiles | `featured.json`, `images/featured/<id>.<ext>` |
| `showcase-manager.html` | the eBay item-ID list for "From Our Collection" | `showcase.json` (read by the Cloudflare Worker) |

Instagram is Worker-driven and has no manager.

### Showcase availability check

On open (and via **Re-check availability**) the Showcase Manager calls the
Worker's `GET /showcase/status` with its current draft id list. Each row is
labelled **Active**, **Sold / unavailable**, or **Unverified**, and a summary
shows `N active · N sold/unavailable · N unverified · N total`.

**Cleanse sold listings (N)** removes only ids the Worker *definitively*
confirmed ended on eBay (HTTP 404 / errorId 11001). Active, unverified, and
not-yet-checked ids are never touched. A failed check (rate limit, auth error,
5xx, timeout, network) marks everything **Unverified** and nothing is removable.
Cleanse edits the local draft only — **Save to Repository** is still the only
write. Requires the Worker in `workers/showcase/` to be deployed with the
`/showcase/status` route (see its README).

### Replacing a stale ID

When a listing was ended and relisted under a new eBay number, click the ID (or
the ✎ button) to edit it in place: type a bare item ID or paste a full eBay
listing URL, then ✓ / Enter to commit (✕ / Esc to cancel). The row keeps its
position; malformed values and duplicates are rejected; the row's availability
resets to **Not checked** until the next check. Draft only — **Save to
Repository** still writes `showcase.json`.

### Session Changes / Undo

The tab on the right edge opens the **Session Changes** panel — a running list
(newest first) of every mutation this session: adds, removes, replacements, a
cleanse (one grouped entry), and moves. It's an overlay (doesn't shrink the
list), in-memory only, and not kept across a page reload. **Undo last change**
walks the list backward one step at a time (Redo re-applies until you make a new
edit). Undo restores the exact previous ID list; any re-introduced ID shows
**Not checked** rather than a stale verdict. Undo/redo touch the draft only.

### Capacity & layout

The list is capped at **100 IDs** (a safety ceiling — the normal range is
~30–40; adding past 100 is rejected). It renders only the IDs that exist, never
empty slots. On wide screens a list of 14+ IDs splits into two visual columns
(IDs 1..k down the left, k+1..n down the right); narrow screens stay single
column. The split is presentation only — index numbers and every control operate
on the real global order.

## Workflow

1. Open a manager — current content loads automatically (from the connected repo
   folder, or by fetching the served JSON).
2. Edit. Edits autosave to a local draft. If the draft ever disagrees with the
   repository you get a banner to pick **Resume draft** or **Load repository
   version** — neither side is overwritten silently.
3. **Save to Repository.**
   - *Connected* (Chromium browser + "Connect repository…"): files are written
     straight into the working copy.
   - *Not connected / other browser*: you get one repo-ready download — a single
     `.json` for JSON-only changes, or a `.zip` (internal paths already match the
     repo) for changes that include new images. Extract at the repo root.
4. `git status` / `git diff` → review → `git commit` → `git push`.

**Pushing is still what deploys.** A direct write only updates your local working
copy; Cloudflare/GitHub Pages (and the showcase Worker's source) update on push.

## Tests

```
node admin/tests/run.js          # admin logic
node workers/showcase/test.mjs   # Worker classification + CORS
```

Covers the JSON contracts, file-set isolation (a Featured save never touches
`showcase.json` and vice versa), image path derivation, the ZIP-path mirroring,
draft-vs-repository conflict detection, the availability summary/cleanse logic
(unverified is never batch-removed), inline ID replacement, the session
history / linear undo-redo stack, the 100-ID cap, the status-reconcile-on-undo
rule, the two-column layout hook, and the Worker's classification + public
slot-fill logic.
