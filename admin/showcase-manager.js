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
    var MAX_IDS = 100;      // safety ceiling — NOT a target; normal range is ~30-40
    var COLUMN_MIN = 14;    // render the list in two columns only once it's this long (on wide screens)

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
        if (ids.length >= MAX_IDS) {
            return {
                ids: ids.slice(), added: false,
                reason: 'The Showcase list is capped at ' + MAX_IDS + ' item IDs. Remove or replace one before adding another.'
            };
        }
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

    // Replace the id at position `i` in place (order preserved). Never mutates
    // the input. Returns { ids, ok, reason, id?, oldId?, unchanged? }.
    function replaceItemId(ids, i, raw) {
        if (i < 0 || i >= ids.length) {
            return { ids: ids.slice(), ok: false, reason: 'That row no longer exists.' };
        }
        var id = extractItemId(raw);
        if (!id) {
            return { ids: ids.slice(), ok: false, reason: 'That is not a recognisable eBay item ID.' };
        }
        if (id === ids[i]) {
            return { ids: ids.slice(), ok: false, unchanged: true, id: id, oldId: id };
        }
        if (ids.indexOf(id) !== -1) {
            return { ids: ids.slice(), ok: false, reason: 'Item ID ' + id + ' is already in the list.' };
        }
        var next = ids.slice();
        var oldId = next[i];
        next[i] = id;
        return { ids: next, ok: true, id: id, oldId: oldId };
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

    /* ---- session history + linear undo/redo (pure) ---- */

    // Records each mutation as one entry plus a full pre-mutation ids snapshot.
    // Undo/redo are linear: one step at a time; any new mutation clears redo.
    function makeHistory() {
        var log = [];        // chronological: { kind, label, ts }
        var undoStack = [];   // { ids: [...], label }
        var redoStack = [];   // { ids: [...], label }

        function record(kind, label, beforeIds) {
            log.push({ kind: kind, label: label, ts: Date.now() });
            undoStack.push({ ids: beforeIds.slice(), label: label });
            redoStack.length = 0;
        }
        function undo(currentIds) {
            if (!undoStack.length) return null;
            var entry = undoStack.pop();
            redoStack.push({ ids: currentIds.slice(), label: entry.label });
            log.push({ kind: 'undo', label: 'Undid — ' + entry.label, ts: Date.now() });
            return { ids: entry.ids.slice(), label: entry.label };
        }
        function redo(currentIds) {
            if (!redoStack.length) return null;
            var entry = redoStack.pop();
            undoStack.push({ ids: currentIds.slice(), label: entry.label });
            log.push({ kind: 'redo', label: 'Redid — ' + entry.label, ts: Date.now() });
            return { ids: entry.ids.slice(), label: entry.label };
        }
        return {
            record: record,
            undo: undo,
            redo: redo,
            canUndo: function () { return undoStack.length > 0; },
            canRedo: function () { return redoStack.length > 0; },
            entries: function () { return log.slice(); },   // chronological (oldest first)
            count: function () { return log.length; }
        };
    }

    // After an undo/redo (or any wholesale list swap), keep a per-id availability
    // verdict ONLY for ids that were already present immediately before the
    // change. Re-introduced ids get no status → they render "Not checked", and a
    // verdict is never carried onto a different id (statusMap is id-keyed).
    function reconcileStatus(prevIds, nextIds, statusMap) {
        var prevSet = Object.create(null);
        prevIds.forEach(function (id) { prevSet[id] = true; });
        var out = {};
        nextIds.forEach(function (id) {
            if (prevSet[id] && statusMap[id]) out[id] = statusMap[id];
        });
        return out;
    }

    var pure = {
        extractItemId: extractItemId,
        isValidItemId: isValidItemId,
        addItemId: addItemId,
        replaceItemId: replaceItemId,
        move: move,
        buildJSON: buildJSON,
        parseItemIds: parseItemIds,
        summarize: summarize,
        soldIds: soldIds,
        cleanse: cleanse,
        formatSummary: formatSummary,
        makeHistory: makeHistory,
        reconcileStatus: reconcileStatus,
        MAX_IDS: MAX_IDS
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
    var editing = null;             // { index } while a row's ID is being edited
    var history = makeHistory();    // session-scoped; reset on a wholesale list load
    var drawerOpen = false;
    var drawerPinned = false;
    var hoverTimer = null;

    var $list, $count, $badge, $status, $conflict, $newId;
    var $summary, $summaryCounts, $cleanseBtn, $recheckBtn;
    var $drawer, $tab, $panel, $sessionBadge, $sessionLog, $sessionEmpty, $undoBtn, $redoBtn;

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
        $drawer = document.getElementById('sessionDrawer');
        $tab = document.getElementById('sessionTab');
        $panel = document.getElementById('sessionPanel');
        $sessionBadge = document.getElementById('sessionBadge');
        $sessionLog = document.getElementById('sessionLog');
        $sessionEmpty = document.getElementById('sessionEmpty');
        $undoBtn = document.getElementById('undoBtn');
        $redoBtn = document.getElementById('redoBtn');

        conflict = AC.mountConflictBanner($conflict, {
            onResume: function () { refreshBadge(); maybeAutoCheck(); },
            onLoadRepo: function () {
                setIdsFromLoad(repoSnap.slice());
                render(); saveDraft(); setBadge(repoSource); renderHistory(); maybeAutoCheck();
            }
        });

        document.getElementById('addBtn').addEventListener('click', addFromInput);
        $newId.addEventListener('keydown', function (e) { if (e.key === 'Enter') addFromInput(); });
        document.getElementById('reloadBtn').addEventListener('click', reloadFromRepository);
        document.getElementById('clearBtn').addEventListener('click', clearDraft);
        document.getElementById('saveBtn').addEventListener('click', save);
        $recheckBtn.addEventListener('click', function () { checkAvailability(true); });
        $cleanseBtn.addEventListener('click', cleanseSold);

        wireDrawer();
        renderHistory();

        AC.mountRepoBar(document.getElementById('repoBar'), {
            statusEl: $status,
            onChange: function () { loadAuthoritative(); }
        });
    }

    /* ---- Session Changes drawer ---- */

    function setDrawer(open) {
        drawerOpen = !!open;
        $drawer.dataset.open = drawerOpen ? 'true' : 'false';
        $tab.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
    }

    function canHover() {
        return typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches;
    }

    function wireDrawer() {
        $tab.addEventListener('click', function () {
            drawerPinned = !drawerPinned;
            setDrawer(drawerPinned);
        });
        [$tab, $panel].forEach(function (el) {
            el.addEventListener('mouseenter', function () {
                clearTimeout(hoverTimer);
                if (canHover()) setDrawer(true);
            });
            el.addEventListener('mouseleave', function () {
                if (drawerPinned || !canHover()) return;
                hoverTimer = setTimeout(function () { setDrawer(false); }, 250);
            });
        });
        document.addEventListener('click', function (e) {
            if (drawerOpen && !$drawer.contains(e.target)) { drawerPinned = false; setDrawer(false); }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && drawerOpen) { drawerPinned = false; setDrawer(false); }
        });
        $undoBtn.addEventListener('click', doUndo);
        $redoBtn.addEventListener('click', doRedo);
    }

    function renderHistory() {
        var entries = history.entries();
        $sessionBadge.textContent = String(entries.length);
        $sessionBadge.hidden = entries.length === 0;
        $undoBtn.disabled = !history.canUndo();
        $redoBtn.disabled = !history.canRedo();
        $redoBtn.hidden = !history.canRedo();
        $sessionEmpty.hidden = entries.length > 0;

        $sessionLog.innerHTML = '';
        entries.slice().reverse().forEach(function (e) {
            var t = new Date(e.ts);
            var hh = ('0' + t.getHours()).slice(-2);
            var mm = ('0' + t.getMinutes()).slice(-2);
            var li = document.createElement('li');
            li.className = 'session-log__item session-log__item--' + e.kind;
            li.innerHTML = '<span class="session-log__time"></span><span class="session-log__label"></span>';
            li.querySelector('.session-log__time').textContent = hh + ':' + mm;
            li.querySelector('.session-log__label').textContent = e.label;
            $sessionLog.appendChild(li);
        });
    }

    function doUndo() {
        var prev = ids;
        var r = history.undo(ids);
        if (!r) return;
        ids = r.ids;
        statusMap = reconcileStatus(prev, ids, statusMap);
        editing = null;
        render(); saveDraft(); updateSummary(); renderHistory();
        AC.status($status, 'Undid: ' + r.label + '. Draft only — Save to Repository to apply.', 'info');
    }

    function doRedo() {
        var prev = ids;
        var r = history.redo(ids);
        if (!r) return;
        ids = r.ids;
        statusMap = reconcileStatus(prev, ids, statusMap);
        editing = null;
        render(); saveDraft(); updateSummary(); renderHistory();
        AC.status($status, 'Redid: ' + r.label + '.', 'info');
    }

    // Wholesale list load (initial, reload, conflict resolve): start a fresh
    // session history whenever the list actually changes out from under it.
    function setIdsFromLoad(newIds) {
        if (!AC.deepEqual(ids, newIds)) history = makeHistory();
        ids = newIds;
    }

    // Shared tail for every incremental mutation.
    function afterMutation(message, type) {
        render();
        saveDraft();
        updateSummary();
        renderHistory();
        if (message) AC.status($status, message, type || 'info');
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
                setIdsFromLoad(repoSnap.slice());
                render();
                renderHistory();
                setBadge(res.source);
                conflict.hide();
                AC.status($status, 'Loaded ' + ids.length + ' item IDs from the ' +
                    (res.source === 'repo' ? 'connected repository' : 'live site') + '.', 'info');
                maybeAutoCheck();
                return;
            }

            setIdsFromLoad(draft.itemIds.slice());
            render();
            renderHistory();
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
                setIdsFromLoad(draft.itemIds.slice());
                render();
                renderHistory();
                setBadge('draft');
                AC.status($status, 'Could not reach showcase.json (' + err.message + '). Showing your local draft.', 'warn');
            } else {
                setIdsFromLoad([]);
                render();
                renderHistory();
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
        history.record('add', 'Added item ID ' + res.id, ids);
        ids = res.ids;
        $newId.value = '';
        afterMutation('Added item ID ' + res.id + '. Re-check availability to include it.', 'success');
    }

    function removeAt(i) {
        var removed = ids[i];
        history.record('remove', 'Removed item ID ' + removed, ids);
        ids = ids.slice(0, i).concat(ids.slice(i + 1));
        afterMutation('Removed item ID ' + removed + '.', 'info');
    }

    function moveAt(i, delta) {
        var target = i + delta;
        if (target < 0 || target >= ids.length) return;
        history.record('move', 'Moved item ID ' + ids[i] +
            ' from position ' + (i + 1) + ' → ' + (target + 1), ids);
        ids = move(ids, i, delta);
        afterMutation(null);
    }

    /* ---- Inline ID replace ---- */

    function beginEdit(i) {
        editing = { index: i };
        render();
    }

    function cancelEdit() {
        editing = null;
        render();
    }

    function commitEdit(i, rawValue) {
        var res = replaceItemId(ids, i, rawValue);
        if (res.unchanged) { cancelEdit(); return; }
        if (!res.ok) {
            AC.status($status, res.reason, 'error');
            return; // stay in edit mode so the value can be fixed
        }

        history.record('replace', 'Replaced item ID ' + res.oldId + ' → ' + res.id, ids);

        // Detach the old id's availability from the new id — it starts unchecked.
        if (res.oldId && statusMap[res.oldId] && res.ids.indexOf(res.oldId) === -1) {
            delete statusMap[res.oldId];
        }
        ids = res.ids;
        editing = null;
        // draft only — Save to Repository is still the only write
        afterMutation('Replaced ' + res.oldId + ' with ' + res.id +
            ' in the draft. Re-check availability, then Save to Repository.', 'success');
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

        history.record('cleanse', 'Cleansed ' + sold.length + ' sold/unavailable listing' +
            (sold.length === 1 ? '' : 's'), ids);
        ids = cleanse(ids, statusMap);
        afterMutation('Removed ' + sold.length + ' sold listing' + (sold.length === 1 ? '' : 's') +
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

    function renderEditRow(id, i) {
        var row = document.createElement('div');
        row.className = 'id-row id-row--editing';
        row.innerHTML =
            '<span class="id-row__index">' + (i + 1) + '</span>' +
            '<input class="id-row__edit" type="text" spellcheck="false" ' +
                'aria-label="Replace eBay item ID" ' +
                'placeholder="new eBay item ID — or paste a listing URL">' +
            '<span class="id-row__actions">' +
                '<button class="icon-btn" data-act="save-id" title="Replace ID">&#10003;</button>' +
                '<button class="icon-btn" data-act="cancel-id" title="Cancel">&#10005;</button>' +
            '</span>';
        var input = row.querySelector('.id-row__edit');
        input.value = id;
        setTimeout(function () { input.focus(); input.select(); }, 0);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(i, input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        });
        // mousedown fires before the input's blur, so these always register
        row.querySelector('[data-act="save-id"]').addEventListener('mousedown', function (e) {
            e.preventDefault(); commitEdit(i, input.value);
        });
        row.querySelector('[data-act="cancel-id"]').addEventListener('mousedown', function (e) {
            e.preventDefault(); cancelEdit();
        });
        input.addEventListener('blur', function () {
            setTimeout(function () { if (editing && editing.index === i) cancelEdit(); }, 150);
        });
        return row;
    }

    function render() {
        $count.textContent = ids.length + ' item ID' + (ids.length === 1 ? '' : 's') +
            '. Public order is randomised by the Worker, so ordering here is just for your own reference.';
        // Two visual columns on wide screens once the list is long enough to
        // benefit (CSS media query does the actual narrow-screen fallback).
        $list.classList.toggle('id-list--columns', ids.length >= COLUMN_MIN);
        $list.innerHTML = '';
        ids.forEach(function (id, i) {
            if (editing && editing.index === i) {
                $list.appendChild(renderEditRow(id, i));
                return;
            }
            var s = rowStatus(id);
            var row = document.createElement('div');
            row.className = 'id-row' + (s.cls === 'is-sold' ? ' is-sold' : '');
            row.innerHTML =
                '<span class="id-row__index">' + (i + 1) + '</span>' +
                '<button type="button" class="id-row__id" data-act="edit" title="Click to replace this ID">' + id + '</button>' +
                '<span class="id-row__status ' + s.cls + '"' + (s.reason ? ' title="' + s.reason + '"' : '') + '>' + s.label + '</span>' +
                '<a class="id-row__link" href="https://www.ebay.com/itm/' + id + '" target="_blank" rel="noopener noreferrer">view&nbsp;&#8599;</a>' +
                '<span class="id-row__actions">' +
                    '<button class="icon-btn" data-act="edit" title="Replace ID">&#9998;</button>' +
                    '<button class="icon-btn" data-act="up" title="Move up">&#8593;</button>' +
                    '<button class="icon-btn" data-act="down" title="Move down">&#8595;</button>' +
                    '<button class="icon-btn icon-btn--danger" data-act="remove" title="Remove">&#10005;</button>' +
                '</span>';
            row.querySelector('[data-act="up"]').disabled = (i === 0);
            row.querySelector('[data-act="down"]').disabled = (i === ids.length - 1);
            row.querySelectorAll('[data-act="edit"]').forEach(function (el) {
                el.addEventListener('click', function () { beginEdit(i); });
            });
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
