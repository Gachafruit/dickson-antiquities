/* ============================================
   SHOWCASE MANAGER
   The eBay item ID list -> showcase.json  ({ "itemIds": [ ... ] })

   The Cloudflare Worker consumes this file, so the JSON shape is fixed.
   Repository is authoritative; localStorage is draft recovery only.

   Availability: the Worker's /showcase/status endpoint classifies every id as
   active / unavailable / unverified. Only "unavailable" (definitively ended on
   eBay) is eligible for the batch cleanse. Nothing is written until Save.
   ============================================ */

(function (root) {
    'use strict';

    var STORAGE_KEY = 'dickson_showcase_draft';
    var REPO_PATH = 'showcase.json';
    var HTTP_URL = '/showcase.json';
    var STATUS_URL = 'https://showcase.andickso21.workers.dev/showcase/status';

    /* ---------------- Pure helpers (exported for tests) ---------------- */

    // eBay numeric item IDs are 9-15 digits. Accept a bare ID or pull the
    // first long digit run out of a pasted listing URL.
    function extractItemId(text) {
        var s = String(text || '').trim();
        if (/^\d{9,15}$/.test(s)) return s;
        var m = s.match(/(\d{9,15})/);
        return m ? m[1] : null;
    }

    function isValidItemId(id) {
        return /^\d{9,15}$/.test(String(id || ''));
    }

    // Returns { ids, added, reason }. Never mutates the input array.
    function addItemId(ids, raw) {
        var id = extractItemId(raw);
        if (!id) return { ids: ids.slice(), added: false, reason: 'That is not a recognisable eBay item ID.' };
        if (ids.indexOf(id) !== -1) return { ids: ids.slice(), added: false, reason: 'Item ID ' + id + ' is already in the list.' };
        return { ids: ids.concat([id]), added: true, id: id };
    }

    function move(ids, index, delta) {
        var next = ids.slice();
        var target = index + delta;
        if (target < 0 || target >= next.length) return next;
        var tmp = next[index];
        next[index] = next[target];
        next[target] = tmp;
        return next;
    }

    // Exact on-disk shape: 2-space indent + trailing newline (matches showcase.json).
    function buildJSON(ids) {
        return JSON.stringify({ itemIds: ids }, null, 2) + '\n';
    }

    function parseItemIds(parsed) {
        if (parsed && Array.isArray(parsed.itemIds)) {
            return parsed.itemIds.map(String);
        }
        return [];
    }

    /* ---- availability helpers ---- */

    // statusMap: { <id>: { status: 'active'|'unavailable'|'unverified', ... } }
    function summarize(ids, statusMap) {
        var c = { active: 0, unavailable: 0, unverified: 0, notChecked: 0, total: ids.length };
        ids.forEach(function (id) {
            var s = statusMap[id] && statusMap[id].status;
            if (s === 'active') c.active++;
            else if (s === 'unavailable') c.unavailable++;
            else if (s === 'unverified') c.unverified++;
            else c.notChecked++;
        });
        return c;
    }

    // Only ids CONFIRMED unavailable AND still present in the list.
    function soldIds(ids, statusMap) {
        return ids.filter(function (id) {
            return statusMap[id] && statusMap[id].status === 'unavailable';
        });
    }

    // Remove only confirmed-unavailable ids. Active / unverified / unchecked stay.
    function cleanse(ids, statusMap) {
        return ids.filter(function (id) {
            return !(statusMap[id] && statusMap[id].status === 'unavailable');
        });
    }

    function formatSummary(c) {
        var parts = [c.active + ' active', c.unavailable + ' sold/unavailable'];
        if (c.unverified > 0) parts.push(c.unverified + ' unverified');
        if (c.notChecked > 0) parts.push(c.notChecked + ' not checked');
        parts.push(c.total + ' total');
        return parts.join(' · ');
    }

    var pure = {
        extractItemId: extractItemId,
        isValidItemId: isValidItemId,
        addItemId: addItemId,
        move: move,
        buildJSON: buildJSON,
        parseItemIds: parseItemIds,
        summarize: summarize,
        soldIds: soldIds,
        cleanse: cleanse,
        formatSummary: formatSummary
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = pure;
        return;
    }
    root.ShowcaseManagerLogic = pure;

    /* ---------------- Browser UI ---------------- */

    var AC = root.AdminCommon;
    var ids = [];
    var repoSnap = null;
    var repoSource = null;
    var conflict = null;

    var statusMap = {};
    var statusPhase = 'idle';        // idle | checking | done | error
    var lastAutoCheckKey = null;

    var $list, $count, $badge, $status, $conflict, $newId;
    var $summary, $summaryCounts, $cleanseBtn, $recheckBtn;

    function init() {
        $list = document.getElementById('idList');
        $count = document.getElementById('count');
        $badge = document.getElementById('stateBadge');
        $status = document.getElementById('statusBar');
        $conflict = document.getElementById('conflictBanner');
        $newId = document.getElementById('newId');
        $summary = document.getElementById('summary');
        $summaryCounts = document.getElementById('summaryCounts');
        $cleanseBtn = document.getElementById('cleanseBtn');
        $recheckBtn = document.getElementById('recheckBtn');

        conflict = AC.mountConflictBanner($conflict, {
            onResume: function () { refreshBadge(); maybeAutoCheck(); },
            onLoadRepo: function () {
                ids = repoSnap.slice();
                render(); saveDraft(); setBadge(repoSource); maybeAutoCheck();
            }
        });

        document.getElementById('addBtn').addEventListener('click', addFromInput);
        $newId.addEventListener('keydown', function (e) { if (e.key === 'Enter') addFromInput(); });
        document.getElementById('reloadBtn').addEventListener('click', reloadFromRepository);
        document.getElementById('clearBtn').addEventListener('click', clearDraft);
        document.getElementById('saveBtn').addEventListener('click', save);
        $recheckBtn.addEventListener('click', function () { checkAvailability(true); });
        $cleanseBtn.addEventListener('click', cleanseSold);

        AC.mountRepoBar(document.getElementById('repoBar'), {
            statusEl: $status,
            onChange: function () { loadAuthoritative(); }
        });
    }

    function setBadge(kind) { AC.setBadge($badge, kind); }

    function refreshBadge() {
        if (!repoSnap) return;
        setBadge(AC.deepEqual(ids, repoSnap) ? repoSource : 'draft');
    }

    /* ---- Loading ---- */

    function loadAuthoritative() {
        AC.loadJSON({ repoPath: REPO_PATH, httpUrl: HTTP_URL }).then(function (res) {
            repoSnap = parseItemIds(res.data);
            repoSource = res.source;

            var draft = readDraft();
            if (!draft) {
                ids = repoSnap.slice();
                render();
                setBadge(res.source);
                conflict.hide();
                AC.status($status, 'Loaded ' + ids.length + ' item IDs from the ' +
                    (res.source === 'repo' ? 'connected repository' : 'live site') + '.', 'info');
                maybeAutoCheck();
                return;
            }

            ids = draft.itemIds.slice();
            render();
            if (AC.deepEqual(ids, repoSnap)) {
                setBadge(res.source);
                conflict.hide();
                AC.status($status, 'Draft matches the repository.', 'info');
            } else {
                setBadge('draft');
                conflict.show();
                AC.status($status, 'Local draft differs from the repository — choose which to keep above.', 'warn');
            }
            maybeAutoCheck();
        }).catch(function (err) {
            var draft = readDraft();
            if (draft) {
                ids = draft.itemIds.slice();
                render();
                setBadge('draft');
                AC.status($status, 'Could not reach showcase.json (' + err.message + '). Showing your local draft.', 'warn');
            } else {
                ids = [];
                render();
                setBadge('empty');
                AC.status($status, 'Could not load showcase.json and no local draft exists. ' +
                    'Connect the repository or serve the site over http://localhost.', 'error');
            }
        });
    }

    function reloadFromRepository() {
        if (repoSnap && !AC.deepEqual(ids, repoSnap) &&
            !confirm('Discard the local draft and load the repository version?')) {
            return;
        }
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        loadAuthoritative();
    }

    /* ---- Draft ---- */

    function readDraft() {
        var raw;
        try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
        if (!raw) return null;
        try {
            var d = JSON.parse(raw);
            if (d && Array.isArray(d.itemIds)) return d;
        } catch (e) {}
        return null;
    }

    function saveDraft() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                timestamp: new Date().toISOString(),
                itemIds: ids
            }));
        } catch (e) {}
        refreshBadge();
    }

    function clearDraft() {
        if (!confirm('Clear the local draft? Unsaved edits will be lost; the repository is not touched.')) return;
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        loadAuthoritative();
        AC.status($status, 'Local draft cleared.', 'success');
    }

    /* ---- Mutations ---- */

    function addFromInput() {
        var res = addItemId(ids, $newId.value);
        if (!res.added) {
            AC.status($status, res.reason, 'error');
            return;
        }
        ids = res.ids;
        $newId.value = '';
        render();
        saveDraft();
        updateSummary();
        AC.status($status, 'Added item ID ' + res.id + '. Re-check availability to include it.', 'success');
    }

    function removeAt(i) {
        var removed = ids[i];
        ids = ids.slice(0, i).concat(ids.slice(i + 1));
        render();
        saveDraft();
        updateSummary();
        AC.status($status, 'Removed item ID ' + removed + '.', 'info');
    }

    function moveAt(i, delta) {
        ids = move(ids, i, delta);
        render();
        saveDraft();
    }

    /* ---- Availability ---- */

    function maybeAutoCheck() {
        var key = ids.join(',');
        if (key && key !== lastAutoCheckKey) checkAvailability(false);
    }

    function checkAvailability(manual) {
        if (ids.length === 0) {
            statusMap = {}; statusPhase = 'idle';
            lastAutoCheckKey = '';
            updateSummary(); render();
            return;
        }
        lastAutoCheckKey = ids.join(',');
        statusPhase = 'checking';
        updateSummary(); render();
        if (manual) AC.status($status, 'Checking availability of ' + ids.length + ' listings…', 'info');

        var url = STATUS_URL + '?ids=' + encodeURIComponent(ids.join(','));
        fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('status endpoint HTTP ' + r.status);
            return r.json();
        }).then(function (data) {
            var map = {};
            (data.statuses || []).forEach(function (s) { if (s && s.id) map[s.id] = s; });
            statusMap = map;
            statusPhase = 'done';
            updateSummary(); render();
            var c = summarize(ids, statusMap);
            AC.status($status, 'Availability checked — ' + formatSummary(c) +
                (data.warning ? ' (' + data.warning + ')' : '') + '.', 'info');
        }).catch(function (err) {
            // Never infer "sold" from a failed check.
            statusMap = {};
            statusPhase = 'error';
            updateSummary(); render();
            AC.status($status, 'Could not check availability (' + err.message +
                '). All listings left as unverified; nothing was changed.', 'warn');
        });
    }

    function updateSummary() {
        if (statusPhase === 'idle' || ids.length === 0) {
            $summary.hidden = true;
            return;
        }
        $summary.hidden = false;

        if (statusPhase === 'checking') {
            $summaryCounts.innerHTML = '<span class="checking">Checking availability…</span>';
            $cleanseBtn.hidden = true;
            $recheckBtn.disabled = true;
            return;
        }
        $recheckBtn.disabled = false;

        if (statusPhase === 'error') {
            $summaryCounts.textContent = 'Availability check failed — all listings treated as unverified.';
            $cleanseBtn.hidden = true;
            return;
        }

        var c = summarize(ids, statusMap);
        $summaryCounts.textContent = formatSummary(c);
        var sold = soldIds(ids, statusMap).length;
        $cleanseBtn.hidden = sold === 0;
        $cleanseBtn.textContent = 'Cleanse sold listings (' + sold + ')';
    }

    function cleanseSold() {
        var sold = soldIds(ids, statusMap);
        if (sold.length === 0) return;
        if (!confirm('Remove ' + sold.length + ' confirmed sold/unavailable listing' +
            (sold.length === 1 ? '' : 's') + ' from the draft?\n\n' +
            'Active and unverified listings are kept. Nothing is written to showcase.json ' +
            'until you Save to Repository.')) return;

        ids = cleanse(ids, statusMap);
        render();
        saveDraft();
        updateSummary();
        AC.status($status, 'Removed ' + sold.length + ' sold listing' + (sold.length === 1 ? '' : 's') +
            ' from the draft. Save to Repository to apply.', 'success');
    }

    /* ---- Render ---- */

    function rowStatus(id) {
        var st = statusMap[id];
        if (statusPhase === 'checking' && !st) return { label: 'Checking…', cls: 'is-unverified', reason: '' };
        if (!st) return { label: 'Not checked', cls: 'is-unverified', reason: '' };
        if (st.status === 'active') return { label: 'Active', cls: 'is-active', reason: st.reason || '' };
        if (st.status === 'unavailable') return { label: 'Sold / unavailable', cls: 'is-sold', reason: st.reason || '' };
        return { label: 'Unverified', cls: 'is-unverified', reason: st.reason || '' };
    }

    function render() {
        $count.textContent = ids.length + ' item ID' + (ids.length === 1 ? '' : 's') +
            '. Public order is randomised by the Worker, so ordering here is just for your own reference.';
        $list.innerHTML = '';
        ids.forEach(function (id, i) {
            var s = rowStatus(id);
            var row = document.createElement('div');
            row.className = 'id-row' + (s.cls === 'is-sold' ? ' is-sold' : '');
            row.innerHTML =
                '<span class="id-row__index">' + (i + 1) + '</span>' +
                '<span class="id-row__id">' + id + '</span>' +
                '<span class="id-row__status ' + s.cls + '"' + (s.reason ? ' title="' + s.reason + '"' : '') + '>' + s.label + '</span>' +
                '<a class="id-row__link" href="https://www.ebay.com/itm/' + id + '" target="_blank" rel="noopener noreferrer">view&nbsp;&#8599;</a>' +
                '<span class="id-row__actions">' +
                    '<button class="icon-btn" data-act="up" title="Move up">&#8593;</button>' +
                    '<button class="icon-btn" data-act="down" title="Move down">&#8595;</button>' +
                    '<button class="icon-btn icon-btn--danger" data-act="remove" title="Remove">&#10005;</button>' +
                '</span>';
            row.querySelector('[data-act="up"]').disabled = (i === 0);
            row.querySelector('[data-act="down"]').disabled = (i === ids.length - 1);
            row.querySelector('[data-act="up"]').addEventListener('click', function () { moveAt(i, -1); });
            row.querySelector('[data-act="down"]').addEventListener('click', function () { moveAt(i, 1); });
            row.querySelector('[data-act="remove"]').addEventListener('click', function () { removeAt(i); });
            $list.appendChild(row);
        });
    }

    /* ---- Save ---- */

    function save() {
        var content = buildJSON(ids);
        var btn = document.getElementById('saveBtn');
        btn.disabled = true;
        AC.status($status, 'Saving…', 'info');

        AC.commit([{ path: REPO_PATH, content: content }], { zipName: 'showcase-repo-update.zip' })
            .then(function (result) {
                if (result.mode === 'repo') {
                    repoSnap = ids.slice();
                    repoSource = 'repo';
                    setBadge('saved');
                    conflict.hide();
                    AC.status($status, 'Wrote showcase.json to the repository (' + ids.length +
                        ' IDs). Review with git status, then commit & push — the Worker picks it up after the push.', 'success');
                } else {
                    setBadge('draft');
                    AC.status($status, 'Downloaded showcase.json — replace the copy at the repository root, then commit & push.', 'success');
                }
                saveDraft();
            })
            .catch(function (err) {
                AC.status($status, 'Save failed: ' + (err.message || err), 'error');
            })
            .finally(function () { btn.disabled = false; });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})(typeof window !== 'undefined' ? window : this);
