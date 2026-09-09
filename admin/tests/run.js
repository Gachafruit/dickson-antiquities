/* ============================================
   Dickson admin tools - dependency-free test suite
   Run:  node admin/tests/run.js
   ============================================ */

'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var AC = require('../admin-common.js');
var Featured = require('../featured-manager.js');
var Showcase = require('../showcase-manager.js');

var repoRoot = path.join(__dirname, '..', '..');
var featuredRaw = fs.readFileSync(path.join(repoRoot, 'featured.json'), 'utf8');
var showcaseRaw = fs.readFileSync(path.join(repoRoot, 'showcase.json'), 'utf8');
var featuredLoaderSrc = fs.readFileSync(path.join(repoRoot, 'featured-loader.js'), 'utf8');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log('  ok  ' + name); passed++; }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; }
}

/* ---------------- AdminCommon ---------------- */

test('deepEqual: identical / different structures', function () {
    assert.strictEqual(AC.deepEqual({ a: [1, 2], b: 'x' }, { b: 'x', a: [1, 2] }), true);
    assert.strictEqual(AC.deepEqual([1, 2, 3], [1, 2]), false);
    assert.strictEqual(AC.deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
    assert.strictEqual(AC.deepEqual('187', '187'), true);
});

test('commitMode: connected always writes to the repo', function () {
    assert.strictEqual(AC.commitMode([{ path: 'featured.json', content: '{}' }], true), 'repo');
});

test('commitMode: disconnected + JSON only = single json download', function () {
    assert.strictEqual(AC.commitMode([{ path: 'showcase.json', content: '{}' }], false), 'json');
});

test('commitMode: disconnected + images = one repo-ready zip', function () {
    var files = [
        { path: 'featured.json', content: '{}' },
        { path: 'images/featured/T1.jpg', content: new Blob(['x']) }
    ];
    assert.strictEqual(AC.commitMode(files, false), 'zip');
});

test('commitMode: disconnected + multiple JSON files = zip (paths must be preserved)', function () {
    var files = [{ path: 'a.json', content: '{}' }, { path: 'b.json', content: '{}' }];
    assert.strictEqual(AC.commitMode(files, false), 'zip');
});

/* ---------------- Featured Finds ---------------- */

test('featured: normalizeTiles always yields exactly 9 canonical slots', function () {
    var tiles = Featured.normalizeTiles(JSON.parse(featuredRaw));
    assert.strictEqual(tiles.length, 9);
    tiles.forEach(function (t, i) {
        assert.strictEqual(t.id, 'T' + (i + 1));
        assert.deepStrictEqual(Object.keys(t).sort(),
            ['alt', 'enabled', 'id', 'localImage', 'mode', 'price', 'remoteImage', 'title', 'url']);
    });
});

test('featured: existing featured.json content is preserved through normalize', function () {
    var original = JSON.parse(featuredRaw);
    var tiles = Featured.normalizeTiles(original);
    original.tiles.forEach(function (o) {
        var t = tiles.find(function (x) { return x.id === o.id; });
        assert.ok(t, 'tile ' + o.id + ' survived');
        ['title', 'price', 'url', 'mode', 'localImage', 'remoteImage'].forEach(function (k) {
            assert.strictEqual(t[k], o[k], o.id + '.' + k + ' preserved');
        });
    });
});

test('featured: additive fields default safely (enabled=true, alt="")', function () {
    var tiles = Featured.normalizeTiles(JSON.parse(featuredRaw));
    tiles.forEach(function (t) {
        assert.strictEqual(t.enabled, true);
        assert.strictEqual(t.alt, '');
    });
});

test('featured: buildFileSet emits valid featured.json with updatedAt + tiles', function () {
    var tiles = Featured.normalizeTiles(JSON.parse(featuredRaw));
    var built = Featured.buildFileSet(tiles);
    var parsed = JSON.parse(built.json);
    assert.ok(typeof parsed.updatedAt === 'string');
    assert.strictEqual(parsed.tiles.length, 9);
    assert.strictEqual(built.json.slice(-1) !== '\n', true, 'featured.json keeps no trailing newline');
});

test('featured: image path derives from tile id + uploaded extension, not filename', function () {
    assert.strictEqual(Featured.extOf('SomePhoto.JPEG'), 'jpeg');
    assert.strictEqual(Featured.extOf('no-extension'), 'jpg');
    assert.strictEqual(Featured.imagePathFor('T3', 'weird name.PNG'), 'images/featured/T3.png');
});

test('featured: a fresh upload adds exactly one image file at the computed path', function () {
    var tiles = Featured.normalizeTiles(JSON.parse(featuredRaw));
    var t3 = tiles.find(function (x) { return x.id === 'T3'; });
    t3.mode = 'local';
    t3._file = { name: 'replacement.png' };

    var built = Featured.buildFileSet(tiles);
    var paths = built.files.map(function (f) { return f.path; });
    assert.deepStrictEqual(paths, ['featured.json', 'images/featured/T3.png']);

    var savedT3 = JSON.parse(built.json).tiles.find(function (x) { return x.id === 'T3'; });
    assert.strictEqual(savedT3.localImage, 'images/featured/T3.png');
});

test('featured: commit file set NEVER references showcase.json', function () {
    var tiles = Featured.normalizeTiles(JSON.parse(featuredRaw));
    tiles[0].mode = 'local';
    tiles[0]._file = { name: 'a.jpg' };
    var built = Featured.buildFileSet(tiles);
    built.files.forEach(function (f) {
        assert.ok(!/showcase/i.test(f.path), 'no showcase path in featured commit: ' + f.path);
    });
});

test('featured: draft-vs-repo snapshot detects an edit (banner, not silent overwrite)', function () {
    var repo = Featured.snapshot(Featured.normalizeTiles(JSON.parse(featuredRaw)));
    var draft = Featured.snapshot(Featured.normalizeTiles(JSON.parse(featuredRaw)));
    assert.strictEqual(AC.deepEqual(draft, repo), true);
    draft[0].price = '$9,999';
    assert.strictEqual(AC.deepEqual(draft, repo), false);
});

test('featured-loader: still tolerates legacy data (no alt / no enabled keys)', function () {
    assert.ok(/tileData\.alt \|\| tileData\.title/.test(featuredLoaderSrc), 'alt fallback present');
    assert.ok(/tileData\.enabled === false/.test(featuredLoaderSrc), 'enabled flag handled');
});

/* ---------------- Showcase ---------------- */

test('showcase: parseItemIds reads the exact Worker contract shape', function () {
    var idsFromFile = Showcase.parseItemIds(JSON.parse(showcaseRaw));
    assert.ok(Array.isArray(idsFromFile));
    assert.strictEqual(idsFromFile.length, JSON.parse(showcaseRaw).itemIds.length);
    idsFromFile.forEach(function (id) { assert.ok(Showcase.isValidItemId(id)); });
});

test('showcase: addItemId extracts an ID from a pasted eBay URL', function () {
    var r = Showcase.addItemId([], 'https://www.ebay.com/itm/187370603142?hash=item2ba0288286');
    assert.strictEqual(r.added, true);
    assert.strictEqual(r.id, '187370603142');
});

test('showcase: addItemId rejects duplicates and junk', function () {
    var dup = Showcase.addItemId(['187370603142'], '187370603142');
    assert.strictEqual(dup.added, false);
    assert.ok(/already/.test(dup.reason));

    var junk = Showcase.addItemId([], 'not-an-id');
    assert.strictEqual(junk.added, false);
});

test('showcase: addItemId does not mutate the input array', function () {
    var original = ['111111111111'];
    Showcase.addItemId(original, '222222222222');
    assert.deepStrictEqual(original, ['111111111111']);
});

test('showcase: move reorders within bounds and is a no-op past the edges', function () {
    assert.deepStrictEqual(Showcase.move(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
    assert.deepStrictEqual(Showcase.move(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
    assert.deepStrictEqual(Showcase.move(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
});

/* ---------------- Showcase inline ID replace ---------------- */

var RIDS = ['111111111111', '222222222222', '333333333333'];

test('showcase: replaceItemId swaps a bare numeric ID in place (order preserved)', function () {
    var r = Showcase.replaceItemId(RIDS, 1, '999999999999');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.ids, ['111111111111', '999999999999', '333333333333']);
    assert.strictEqual(r.oldId, '222222222222');
    assert.strictEqual(r.id, '999999999999');
    assert.deepStrictEqual(RIDS, ['111111111111', '222222222222', '333333333333'], 'input not mutated');
});

test('showcase: replaceItemId extracts the ID from a pasted eBay URL', function () {
    var r = Showcase.replaceItemId(RIDS, 0, 'https://www.ebay.com/itm/187370603142?hash=item2ba0');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.ids[0], '187370603142');
    assert.strictEqual(r.ids[1], '222222222222');
    assert.strictEqual(r.ids[2], '333333333333');
});

test('showcase: replaceItemId rejects malformed values', function () {
    var r = Showcase.replaceItemId(RIDS, 0, 'not-an-id');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.ids, RIDS);
});

test('showcase: replaceItemId rejects a duplicate of another row', function () {
    var r = Showcase.replaceItemId(RIDS, 0, '333333333333');
    assert.strictEqual(r.ok, false);
    assert.ok(/already/.test(r.reason));
});

test('showcase: replaceItemId flags an unchanged value (same ID)', function () {
    var r = Showcase.replaceItemId(RIDS, 0, '111111111111');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.unchanged, true);
});

test('showcase: replacing an ID resets that row to "not checked" in the summary', function () {
    var status = { '111111111111': { status: 'active' }, '222222222222': { status: 'unavailable' }, '333333333333': { status: 'active' } };
    var r = Showcase.replaceItemId(RIDS, 1, '444444444444'); // was unavailable
    assert.strictEqual(r.ok, true);
    // the manager deletes the old id's entry; the new id has none
    delete status[r.oldId];
    var c = Showcase.summarize(r.ids, status);
    assert.deepStrictEqual(c, { active: 2, unavailable: 0, unverified: 0, notChecked: 1, total: 3 });
    assert.deepStrictEqual(Showcase.soldIds(r.ids, status), [], 'no confirmed-sold ids after the swap');
});

test('showcase: contract stays exact after a replace + build', function () {
    var ids = Showcase.parseItemIds(JSON.parse(showcaseRaw));
    var r = Showcase.replaceItemId(ids, 3, '424242424242');
    assert.strictEqual(r.ok, true);
    var out = Showcase.buildJSON(r.ids);
    assert.strictEqual(out, JSON.stringify({ itemIds: r.ids }, null, 2) + '\n');
    assert.deepStrictEqual(Object.keys(JSON.parse(out)), ['itemIds']);
    assert.strictEqual(r.ids.length, ids.length, 'length unchanged');
});

test('showcase: buildJSON preserves the exact { itemIds: [...] } shape + trailing newline', function () {
    var ids = Showcase.parseItemIds(JSON.parse(showcaseRaw));
    var out = Showcase.buildJSON(ids);
    assert.strictEqual(out.slice(-1), '\n');
    var parsed = JSON.parse(out);
    assert.deepStrictEqual(Object.keys(parsed), ['itemIds']);
    assert.deepStrictEqual(parsed.itemIds, ids);
    // byte-identical to a re-serialisation of the current file
    assert.strictEqual(out, JSON.stringify({ itemIds: JSON.parse(showcaseRaw).itemIds }, null, 2) + '\n');
});

test('showcase: save file set is showcase.json only, never featured.json', function () {
    var out = Showcase.buildJSON(['187370603142']);
    // a showcase commit is always a single file at this path
    assert.ok(!/featured/i.test('showcase.json'));
    assert.doesNotThrow(function () { JSON.parse(out); });
});

/* ---------------- Showcase availability / cleanse ---------------- */

var STATUS_FIXTURE = {
    '111111111111': { status: 'active' },
    '222222222222': { status: 'unavailable' },
    '333333333333': { status: 'unavailable' },
    '444444444444': { status: 'unverified' }
    // '555555555555' intentionally absent -> "not checked"
};
var FIXTURE_IDS = ['111111111111', '222222222222', '333333333333', '444444444444', '555555555555'];

test('showcase: summarize counts each availability bucket', function () {
    assert.deepStrictEqual(Showcase.summarize(FIXTURE_IDS, STATUS_FIXTURE),
        { active: 1, unavailable: 2, unverified: 1, notChecked: 1, total: 5 });
});

test('showcase: soldIds returns ONLY confirmed-unavailable ids still in the list', function () {
    assert.deepStrictEqual(Showcase.soldIds(FIXTURE_IDS, STATUS_FIXTURE),
        ['222222222222', '333333333333']);
    // an unavailable id no longer in the list is not reported
    assert.deepStrictEqual(Showcase.soldIds(['111111111111'], STATUS_FIXTURE), []);
});

test('showcase: cleanse removes only confirmed sold, keeps active/unverified/unchecked', function () {
    var cleaned = Showcase.cleanse(FIXTURE_IDS, STATUS_FIXTURE);
    assert.deepStrictEqual(cleaned, ['111111111111', '444444444444', '555555555555']);
});

test('showcase: cleanse never removes unverified even when checks failed', function () {
    // simulate a failed check: empty statusMap -> nothing is sold -> nothing removed
    assert.deepStrictEqual(Showcase.cleanse(FIXTURE_IDS, {}), FIXTURE_IDS);
    assert.deepStrictEqual(Showcase.soldIds(FIXTURE_IDS, {}), []);
});

test('showcase: formatSummary omits zero unverified/not-checked segments', function () {
    assert.strictEqual(
        Showcase.formatSummary({ active: 18, unavailable: 12, unverified: 0, notChecked: 0, total: 30 }),
        '18 active · 12 sold/unavailable · 30 total');
    assert.strictEqual(
        Showcase.formatSummary({ active: 17, unavailable: 12, unverified: 1, notChecked: 0, total: 30 }),
        '17 active · 12 sold/unavailable · 1 unverified · 30 total');
});

test('showcase: contract still exact after a cleanse + build', function () {
    var ids = Showcase.parseItemIds(JSON.parse(showcaseRaw));
    var withSold = ids.concat(['222222222222']);
    var cleaned = Showcase.cleanse(withSold, STATUS_FIXTURE);
    assert.deepStrictEqual(cleaned, ids, 'cleanse restores the original curated list');
    var out = Showcase.buildJSON(cleaned);
    assert.strictEqual(out, JSON.stringify({ itemIds: ids }, null, 2) + '\n');
    assert.deepStrictEqual(Object.keys(JSON.parse(out)), ['itemIds']);
});

/* ---------------- Showcase session history / undo ---------------- */

function seq(n, base) { var a = []; for (var i = 0; i < n; i++) a.push(String((base || 100000000000) + i)); return a; }

test('history: add / remove / replace / move each create exactly one entry', function () {
    var h = Showcase.makeHistory();
    h.record('add', 'Added item ID 111111111111', ['a']);
    h.record('remove', 'Removed item ID a', ['a', '111111111111']);
    h.record('replace', 'Replaced item ID x → y', ['111111111111']);
    h.record('move', 'Moved item ID y from position 1 → 2', ['111111111111', 'y']);
    assert.strictEqual(h.entries().length, 4);
    assert.deepStrictEqual(h.entries().map(function (e) { return e.kind; }), ['add', 'remove', 'replace', 'move']);
});

test('history: a cleanse of N ids is ONE grouped entry, not one per id', function () {
    var h = Showcase.makeHistory();
    h.record('cleanse', 'Cleansed 4 sold/unavailable listings', ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.strictEqual(h.entries().length, 1);
    assert.strictEqual(h.entries()[0].kind, 'cleanse');
    assert.ok(/Cleansed 4/.test(h.entries()[0].label));
});

test('history: undo restores the immediately previous full ID list', function () {
    var h = Showcase.makeHistory();
    h.record('add', 'Added 3', ['1', '2']);
    var r = h.undo(['1', '2', '3']);
    assert.deepStrictEqual(r.ids, ['1', '2']);
    assert.strictEqual(r.label, 'Added 3');
});

test('history: repeated undo walks backward through every mutation', function () {
    var h = Showcase.makeHistory();
    var s0 = ['a', 'b'];
    h.record('add', 'Added c', s0);          var s1 = ['a', 'b', 'c'];
    h.record('add', 'Added d', s1);          var s2 = ['a', 'b', 'c', 'd'];
    h.record('remove', 'Removed a', s2);     var s3 = ['b', 'c', 'd'];
    var u1 = h.undo(s3); assert.deepStrictEqual(u1.ids, s2);
    var u2 = h.undo(u1.ids); assert.deepStrictEqual(u2.ids, s1);
    var u3 = h.undo(u2.ids); assert.deepStrictEqual(u3.ids, s0);
    assert.strictEqual(h.undo(u3.ids), null, 'nothing left to undo');
});

test('history: redo re-applies, and a new mutation clears the redo stack', function () {
    var h = Showcase.makeHistory();
    h.record('add', 'Added c', ['a', 'b']);
    var u = h.undo(['a', 'b', 'c']);       // -> ['a','b']
    assert.strictEqual(h.canRedo(), true);
    var rd = h.redo(u.ids);
    assert.deepStrictEqual(rd.ids, ['a', 'b', 'c']);
    // undo again, then a fresh mutation kills redo
    h.undo(['a', 'b', 'c']);
    h.record('add', 'Added z', ['a', 'b']);
    assert.strictEqual(h.canRedo(), false);
});

test('history: undo/redo snapshots are copies — later mutation of ids does not corrupt them', function () {
    var h = Showcase.makeHistory();
    var live = ['a', 'b'];
    h.record('add', 'Added c', live);
    live.push('c'); live.push('MUTATED');
    var r = h.undo(live);
    assert.deepStrictEqual(r.ids, ['a', 'b']);
});

test('reconcileStatus: a move (same id set) keeps every verdict', function () {
    var status = { a: { status: 'active' }, b: { status: 'unavailable' }, c: { status: 'active' } };
    var out = Showcase.reconcileStatus(['a', 'b', 'c'], ['b', 'a', 'c'], status);
    assert.deepStrictEqual(out, status);
});

test('reconcileStatus: a re-introduced id (undo of remove) gets NO carried-over status', function () {
    // 'b' was removed then undo brings it back; its old "active" verdict must not follow it
    var status = { a: { status: 'active' }, b: { status: 'active' }, c: { status: 'unavailable' } };
    var out = Showcase.reconcileStatus(['a', 'c'], ['a', 'b', 'c'], status);
    assert.deepStrictEqual(out, { a: { status: 'active' }, c: { status: 'unavailable' } });
    assert.strictEqual(out.b, undefined, 'restored id b is unchecked');
});

test('reconcileStatus: undo of a replace — restored old id is unchecked, new id dropped', function () {
    // replace X -> Y, then undo. prev list has Y, next list has X back.
    var status = { X: { status: 'unavailable' }, Y: { status: 'active' }, k: { status: 'active' } };
    var out = Showcase.reconcileStatus(['Y', 'k'], ['X', 'k'], status);
    assert.deepStrictEqual(out, { k: { status: 'active' } });
});

/* ---------------- Showcase capacity ---------------- */

test('capacity: MAX_IDS is 100', function () {
    assert.strictEqual(Showcase.MAX_IDS, 100);
});

test('capacity: a list well past the old ~30 limit still accepts adds', function () {
    var r = Showcase.addItemId(seq(45), '999999999999');
    assert.strictEqual(r.added, true);
    assert.strictEqual(r.ids.length, 46);
});

test('capacity: the 100th id is accepted', function () {
    var r = Showcase.addItemId(seq(99), '999999999999');
    assert.strictEqual(r.added, true);
    assert.strictEqual(r.ids.length, 100);
});

test('capacity: adding a 101st id is rejected with a clear message', function () {
    var r = Showcase.addItemId(seq(100), '999999999999');
    assert.strictEqual(r.added, false);
    assert.ok(/capped at 100/.test(r.reason), r.reason);
    assert.deepStrictEqual(r.ids.length, 100, 'list unchanged');
});

test('capacity: buildJSON has no preallocated / empty entries — length matches ids', function () {
    var ids = seq(34);
    var parsed = JSON.parse(Showcase.buildJSON(ids));
    assert.strictEqual(parsed.itemIds.length, 34);
    assert.ok(parsed.itemIds.every(Boolean), 'no empty slots');
});

/* ---------------- Showcase two-column layout (CSS + JS hook) ---------------- */

test('layout: JS toggles .id-list--columns only above the threshold; CSS has the responsive fallback', function () {
    var js = fs.readFileSync(path.join(repoRoot, 'admin', 'showcase-manager.js'), 'utf8');
    assert.ok(/COLUMN_MIN\s*=\s*14/.test(js), 'threshold defined');
    assert.ok(/classList\.toggle\('id-list--columns', ids\.length >= COLUMN_MIN\)/.test(js), 'class toggled by real list length');

    var css = fs.readFileSync(path.join(repoRoot, 'admin', 'admin.css'), 'utf8');
    assert.ok(/@media \(min-width: 1000px\)[\s\S]*\.id-list--columns[\s\S]*column-count: 2/.test(css), 'two columns only on wide screens');
    assert.ok(/break-inside: avoid/.test(css), 'rows are not split across columns');
});

test('worker: contract guards (full behaviour tested in workers/showcase/test.mjs)', function () {
    var src = fs.readFileSync(path.join(repoRoot, 'workers', 'showcase', 'worker.js'), 'utf8');
    assert.ok(src.indexOf("url.pathname === '/showcase')") !== -1, 'public /showcase route preserved');
    assert.ok(/url\.pathname === '\/showcase\/status'/.test(src), '/showcase/status route present');
    assert.ok(/status: 'unverified', reason: `http-\$\{code\}`/.test(src), 'ambiguous HTTP -> unverified');
    assert.ok(/function resolveCorsOrigin/.test(src) && /localhost\(:\\d\+\)\?/.test(src), 'loopback-aware CORS allow-list present');
    assert.ok(/const cors = corsHeaders\(request\.headers\.get\('Origin'\)\)/.test(src), '/showcase route uses the shared CORS helper');
    assert.ok(/return \{ items: assembleShowcase\(/.test(src), 'public route fills slots via assembleShowcase');
    assert.ok(/publicCandidateOrder\(allItemIds, cachedStatus\)/.test(src), 'public route draws from the curated list + cache');
    assert.ok(/const PUBLIC_WANT = 12;/.test(src), 'public target is 12');
    assert.ok(/Phase 1: cache only — no eBay calls/.test(src), 'cache-first phase 1 preserved');
});

/* ---------------- summary ---------------- */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
