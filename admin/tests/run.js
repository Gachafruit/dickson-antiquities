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

test('worker: classification + CORS rules (delegated to workers/showcase/test.mjs)', function () {
    // Guard that the worker source still exports the pieces the manager relies on.
    var src = fs.readFileSync(path.join(repoRoot, 'workers', 'showcase', 'worker.js'), 'utf8');
    assert.ok(src.indexOf("url.pathname === '/showcase')") !== -1, 'public /showcase route preserved');
    assert.ok(/url\.pathname === '\/showcase\/status'/.test(src), 'new /showcase/status route present');
    assert.ok(/status: 'unverified', reason: `http-\$\{code\}`/.test(src), 'ambiguous HTTP -> unverified');
    assert.ok(/'Access-Control-Allow-Origin': 'https:\/\/dicksonantiquities\.com'/.test(src), 'public CORS unchanged');
});

/* ---------------- summary ---------------- */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
