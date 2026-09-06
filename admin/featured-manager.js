/* ============================================
   FEATURED FINDS MANAGER
   Nine fixed homepage tiles (T1-T9) -> featured.json

   Repository is authoritative. localStorage is a draft convenience only.
   ============================================ */

(function (root) {
    'use strict';

    var TILE_COUNT = 9;
    var STORAGE_KEY = 'dickson_featured_draft';
    var REPO_PATH = 'featured.json';
    var HTTP_URL = '/featured.json';
    var IMAGE_DIR = 'images/featured';

    /* ---------------- Pure helpers (exported for tests) ---------------- */

    function defaultTile(id) {
        return {
            id: id,
            title: '',
            price: '',
            url: '',
            alt: '',
            enabled: true,
            mode: 'local',
            localImage: IMAGE_DIR + '/' + id + '.jpg',
            remoteImage: ''
        };
    }

    // Normalize any tile-ish object to the canonical featured.json shape.
    function normalizeTile(src, id) {
        src = src || {};
        var t = defaultTile(id || src.id);
        if (src.title != null) t.title = String(src.title);
        if (src.price != null) t.price = String(src.price);
        if (src.url != null) t.url = String(src.url);
        if (src.alt != null) t.alt = String(src.alt);
        if (typeof src.enabled === 'boolean') t.enabled = src.enabled;
        if (src.mode === 'remote' || src.mode === 'local') t.mode = src.mode;
        if (src.localImage) t.localImage = String(src.localImage);
        if (src.remoteImage) t.remoteImage = String(src.remoteImage);
        return t;
    }

    // Build the canonical 9-slot array from a parsed featured.json (or draft).
    function normalizeTiles(parsed) {
        var byId = {};
        var list = (parsed && Array.isArray(parsed.tiles)) ? parsed.tiles
                 : (Array.isArray(parsed) ? parsed : []);
        list.forEach(function (t) { if (t && t.id) byId[t.id] = t; });

        var out = [];
        for (var i = 1; i <= TILE_COUNT; i++) {
            var id = 'T' + i;
            out.push(normalizeTile(byId[id], id));
        }
        return out;
    }

    // Snapshot used for draft-vs-repository comparison (no transient fields).
    function snapshot(tiles) {
        return tiles.map(function (t) {
            return {
                id: t.id, title: t.title, price: t.price, url: t.url,
                alt: t.alt, enabled: t.enabled, mode: t.mode,
                localImage: t.localImage, remoteImage: t.remoteImage
            };
        });
    }

    function extOf(filename) {
        var m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
        return m ? m[1] : 'jpg';
    }

    function imagePathFor(id, filename) {
        return IMAGE_DIR + '/' + id + '.' + extOf(filename);
    }

    // Build the file set for a commit. Pure: no IO.
    //   tiles: live tile array (may carry _file for fresh uploads)
    // -> { files: [{path, content}], json: string }
    function buildFileSet(tiles) {
        var working = tiles.map(function (t) {
            var copy = normalizeTile(t, t.id);
            if (t.mode === 'local' && t._file) {
                copy.localImage = imagePathFor(t.id, t._file.name);
            }
            return copy;
        });

        var json = JSON.stringify({
            updatedAt: new Date().toISOString(),
            tiles: working
        }, null, 2); // featured.json has no trailing newline

        var files = [{ path: REPO_PATH, content: json }];
        tiles.forEach(function (t) {
            if (t.mode === 'local' && t._file) {
                files.push({ path: imagePathFor(t.id, t._file.name), content: t._file });
            }
        });
        return { files: files, json: json, tiles: working };
    }

    var pure = {
        defaultTile: defaultTile,
        normalizeTile: normalizeTile,
        normalizeTiles: normalizeTiles,
        snapshot: snapshot,
        extOf: extOf,
        imagePathFor: imagePathFor,
        buildFileSet: buildFileSet,
        TILE_COUNT: TILE_COUNT
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = pure;
        return;
    }
    root.FeaturedManagerLogic = pure;

    /* ---------------- Browser UI ---------------- */

    var AC = root.AdminCommon;
    var tiles = [];
    var repoSnap = null;      // normalized snapshot of what the repo/site holds
    var repoSource = null;    // 'repo' | 'http'
    var conflict = null;

    var $grid, $badge, $status, $conflict;

    function init() {
        $grid = document.getElementById('tilesGrid');
        $badge = document.getElementById('stateBadge');
        $status = document.getElementById('statusBar');
        $conflict = document.getElementById('conflictBanner');

        for (var i = 1; i <= TILE_COUNT; i++) {
            var t = defaultTile('T' + i);
            tiles.push(t);
            $grid.appendChild(buildEditor(t));
        }

        conflict = AC.mountConflictBanner($conflict, {
            onResume: function () { setBadge('draft'); },
            onLoadRepo: function () { applyTiles(repoSnap, true); setBadge(repoSource); saveDraft(); }
        });

        document.getElementById('reloadBtn').addEventListener('click', reloadFromRepository);
        document.getElementById('importBtn').addEventListener('click', function () {
            document.getElementById('importFile').click();
        });
        document.getElementById('importFile').addEventListener('change', handleImport);
        document.getElementById('clearBtn').addEventListener('click', clearDraft);
        document.getElementById('saveBtn').addEventListener('click', save);

        // mountRepoBar subscribes to RepoFS and fires onChange synchronously
        // with the initial state, which drives the first load. It fires again
        // whenever the connection is established or dropped.
        AC.mountRepoBar(document.getElementById('repoBar'), {
            statusEl: $status,
            onChange: function () { loadAuthoritative(); }
        });
    }

    function setBadge(kind) {
        if (kind === 'repo') AC.setBadge($badge, 'repo');
        else if (kind === 'http') AC.setBadge($badge, 'http');
        else if (kind === 'saved') AC.setBadge($badge, 'saved');
        else if (kind === 'empty') AC.setBadge($badge, 'empty');
        else AC.setBadge($badge, 'draft');
    }

    /* ---- Loading ---- */

    function loadAuthoritative() {
        AC.loadJSON({ repoPath: REPO_PATH, httpUrl: HTTP_URL }).then(function (res) {
            repoSnap = normalizeTiles(res.data);
            repoSource = res.source;

            var draft = readDraft();
            if (!draft) {
                applyTiles(repoSnap, true);
                setBadge(res.source);
                conflict.hide();
                AC.status($status, 'Loaded current featured.json from the ' +
                    (res.source === 'repo' ? 'connected repository' : 'live site') + '.', 'info');
                return;
            }

            var draftSnap = normalizeTiles({ tiles: draft.tiles });
            applyTiles(draftSnap, true);        // keep the user's edits visible
            restorePreviews(draft.tiles);

            if (AC.deepEqual(draftSnap, repoSnap)) {
                setBadge(res.source);
                conflict.hide();
                AC.status($status, 'Draft matches the repository.', 'info');
            } else {
                setBadge('draft');
                conflict.show();
                AC.status($status, 'Local draft differs from the repository — choose which to keep above.', 'warn');
            }
        }).catch(function (err) {
            var draft = readDraft();
            if (draft) {
                var draftSnap = normalizeTiles({ tiles: draft.tiles });
                applyTiles(draftSnap, true);
                restorePreviews(draft.tiles);
                setBadge('draft');
                AC.status($status, 'Could not reach featured.json (' + err.message +
                    '). Showing your local draft.', 'warn');
            } else {
                setBadge('empty');
                AC.status($status, 'Could not load featured.json and no local draft exists. ' +
                    'Connect the repository or serve the site over http://localhost.', 'error');
            }
        });
    }

    function reloadFromRepository() {
        var draft = readDraft();
        if (draft) {
            var draftSnap = normalizeTiles({ tiles: draft.tiles });
            if (repoSnap && !AC.deepEqual(draftSnap, repoSnap) &&
                !confirm('Discard the local draft and load the repository version?')) {
                return;
            }
        }
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        loadAuthoritative();
    }

    /* ---- Draft persistence ---- */

    function readDraft() {
        var raw;
        try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
        if (!raw) return null;
        try {
            var d = JSON.parse(raw);
            if (d && Array.isArray(d.tiles)) return d;
        } catch (e) {}
        return null;
    }

    function saveDraft() {
        var d = {
            timestamp: new Date().toISOString(),
            tiles: tiles.map(function (t) {
                return {
                    id: t.id, title: t.title, price: t.price, url: t.url,
                    alt: t.alt, enabled: t.enabled, mode: t.mode,
                    localImage: t.localImage, remoteImage: t.remoteImage,
                    _preview: t._preview || null,
                    _fileName: t._file ? t._file.name : null
                };
            })
        };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch (e) {}
        refreshBadgeAgainstRepo();
    }

    function refreshBadgeAgainstRepo() {
        if (!repoSnap) return;
        if (AC.deepEqual(snapshot(tiles), repoSnap)) setBadge(repoSource);
        else setBadge('draft');
    }

    function clearDraft() {
        if (!confirm('Clear the local draft? Unsaved edits will be lost; the repository is not touched.')) return;
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        loadAuthoritative();
        AC.status($status, 'Local draft cleared.', 'success');
    }

    /* ---- Import (legacy affordance) ---- */

    function handleImport(e) {
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function (ev) {
            try {
                var parsed = JSON.parse(ev.target.result);
                applyTiles(normalizeTiles(parsed), true);
                saveDraft();
                conflict.hide();
                AC.status($status, 'Imported ' + file.name + ' into the draft. Save to write it to the repository.', 'success');
            } catch (err) {
                AC.status($status, 'Could not parse that file: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    }

    /* ---- Apply data to the form ---- */

    function applyTiles(snap, clearFiles) {
        snap.forEach(function (s) {
            var t = tiles.find(function (x) { return x.id === s.id; });
            if (!t) return;
            t.title = s.title; t.price = s.price; t.url = s.url;
            t.alt = s.alt; t.enabled = s.enabled; t.mode = s.mode;
            t.localImage = s.localImage; t.remoteImage = s.remoteImage;
            if (clearFiles) { t._file = null; t._preview = null; }
            syncEditor(t);
        });
    }

    function restorePreviews(draftTiles) {
        draftTiles.forEach(function (dt) {
            if (!dt._preview) return;
            var t = tiles.find(function (x) { return x.id === dt.id; });
            if (!t) return;
            t._preview = dt._preview;
            t._linkedName = dt._fileName || null; // preview only; bytes are gone
            syncEditor(t);
        });
    }

    /* ---- Editor DOM ---- */

    function buildEditor(t) {
        var d = document.createElement('div');
        d.className = 'tile-editor';
        d.dataset.id = t.id;
        d.innerHTML =
            '<div class="tile-header">' +
                '<span class="tile-id">' + t.id + '</span>' +
                '<label class="checkbox-row"><input type="checkbox" data-f="enabled" checked> Shown on site</label>' +
            '</div>' +
            '<div class="form-group"><label>Title</label>' +
                '<input type="text" data-f="title" placeholder="e.g. Antique Silver Tea Set"></div>' +
            '<div class="form-group"><label>Price</label>' +
                '<input type="text" data-f="price" placeholder="e.g. $1,250.00"></div>' +
            '<div class="form-group"><label>eBay URL</label>' +
                '<input type="url" data-f="url" placeholder="https://www.ebay.com/itm/..."></div>' +
            '<div class="form-group"><label>Image alt text <span style="font-weight:400;color:#a8a29e">(optional — falls back to the title)</span></label>' +
                '<input type="text" data-f="alt" placeholder="Describes the photo for screen readers"></div>' +
            '<div class="form-group"><label>Image source</label>' +
                '<div class="mode-toggle">' +
                    '<button type="button" class="mode-btn" data-mode="local">Local upload</button>' +
                    '<button type="button" class="mode-btn" data-mode="remote">Remote URL</button>' +
                '</div>' +
                '<div data-sec="local">' +
                    '<div class="image-upload" tabindex="0">' +
                        '<div class="upload-icon">&#128247;</div>' +
                        '<div class="upload-text">Click or drop an image</div>' +
                        '<div class="upload-subtext">Written to ' + IMAGE_DIR + '/' + t.id + '.&lt;ext&gt; on save</div>' +
                    '</div>' +
                    '<input type="file" data-f="file" accept="image/*" hidden>' +
                    '<div class="preview-filename" data-el="filename"></div>' +
                '</div>' +
                '<div data-sec="remote" class="hidden">' +
                    '<input type="url" data-f="remoteImage" placeholder="https://i.ebayimg.com/...">' +
                '</div>' +
            '</div>' +
            '<div class="tile-preview">' +
                '<div class="tile-preview__label">Site preview</div>' +
                '<div class="preview-card">' +
                    '<div class="preview-card__img is-empty" data-el="pimg">no image</div>' +
                    '<div class="preview-card__body">' +
                        '<div class="preview-card__title" data-el="ptitle"></div>' +
                        '<div class="preview-card__price" data-el="pprice"></div>' +
                    '</div>' +
                '</div>' +
            '</div>';

        wireEditor(d, t);
        return d;
    }

    function wireEditor(d, t) {
        d.querySelectorAll('input[data-f]').forEach(function (input) {
            var f = input.dataset.f;
            if (f === 'file') {
                input.addEventListener('change', function (e) {
                    var file = e.target.files[0];
                    if (file) acceptImage(t, file);
                });
                return;
            }
            if (f === 'enabled') {
                input.addEventListener('change', function () {
                    t.enabled = input.checked;
                    d.classList.toggle('is-disabled', !t.enabled);
                    saveDraft();
                });
                return;
            }
            input.addEventListener('input', function () {
                t[f] = input.value;
                if (f === 'title' || f === 'price' || f === 'remoteImage' || f === 'alt') updatePreview(d, t);
                saveDraft();
            });
        });

        d.querySelectorAll('.mode-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                t.mode = btn.dataset.mode;
                syncEditor(t);
                saveDraft();
            });
        });

        var up = d.querySelector('.image-upload');
        var fileInput = d.querySelector('input[data-f="file"]');
        up.addEventListener('click', function () { fileInput.click(); });
        up.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
        });
        up.addEventListener('dragover', function (e) { e.preventDefault(); up.classList.add('dragover'); });
        up.addEventListener('dragleave', function () { up.classList.remove('dragover'); });
        up.addEventListener('drop', function (e) {
            e.preventDefault();
            up.classList.remove('dragover');
            var file = e.dataTransfer.files[0];
            if (file && file.type.indexOf('image/') === 0) acceptImage(t, file);
        });
    }

    function acceptImage(t, file) {
        t._file = file;
        t._linkedName = null;
        var reader = new FileReader();
        reader.onload = function (ev) {
            t._preview = ev.target.result;
            syncEditor(t);
            saveDraft();
        };
        reader.readAsDataURL(file);
    }

    // Push tile state -> its editor DOM.
    function syncEditor(t) {
        var d = $grid.querySelector('[data-id="' + t.id + '"]');
        if (!d) return;
        d.querySelector('[data-f="title"]').value = t.title;
        d.querySelector('[data-f="price"]').value = t.price;
        d.querySelector('[data-f="url"]').value = t.url;
        d.querySelector('[data-f="alt"]').value = t.alt;
        d.querySelector('[data-f="enabled"]').checked = t.enabled;
        d.querySelector('[data-f="remoteImage"]').value = t.remoteImage;
        d.classList.toggle('is-disabled', !t.enabled);

        d.querySelectorAll('.mode-btn').forEach(function (b) {
            b.classList.toggle('active', b.dataset.mode === t.mode);
        });
        d.querySelector('[data-sec="local"]').classList.toggle('hidden', t.mode !== 'local');
        d.querySelector('[data-sec="remote"]').classList.toggle('hidden', t.mode !== 'remote');

        var fn = d.querySelector('[data-el="filename"]');
        if (t._file) fn.textContent = 'New upload: ' + t._file.name + ' (saved as ' + imagePathFor(t.id, t._file.name) + ')';
        else if (t._preview && t._linkedName) fn.textContent = 'Linked image from draft: ' + t._linkedName + ' — re-upload to change the file';
        else fn.textContent = 'Current: ' + t.localImage;

        updatePreview(d, t);
    }

    function updatePreview(d, t) {
        d.querySelector('[data-el="ptitle"]').textContent = t.title || '(untitled)';
        d.querySelector('[data-el="pprice"]').textContent = t.price || '';
        var pimg = d.querySelector('[data-el="pimg"]');
        var srcCandidate = t._preview
            || (t.mode === 'remote' ? t.remoteImage : t.localImage);
        if (srcCandidate) {
            if (pimg.tagName !== 'IMG') {
                var img = document.createElement('img');
                img.className = 'preview-card__img';
                img.dataset.el = 'pimg';
                pimg.replaceWith(img);
                pimg = img;
            }
            pimg.className = 'preview-card__img';
            pimg.alt = t.alt || t.title || '';
            pimg.src = srcCandidate;
        } else {
            if (pimg.tagName === 'IMG') {
                var ph = document.createElement('div');
                ph.className = 'preview-card__img is-empty';
                ph.dataset.el = 'pimg';
                ph.textContent = 'no image';
                pimg.replaceWith(ph);
            }
        }
    }

    /* ---- Save ---- */

    function save() {
        var built = buildFileSet(tiles);
        var btn = document.getElementById('saveBtn');
        btn.disabled = true;
        AC.status($status, 'Saving…', 'info');

        AC.commit(built.files, { zipName: 'featured-repo-update.zip' }).then(function (result) {
            // Point every tile's localImage at its computed path.
            applyTiles(snapshot(built.tiles), false);

            if (result.mode === 'repo') {
                // Images are now really on disk -> drop the transient File objects.
                tiles.forEach(function (t) { t._file = null; t._linkedName = null; });
                repoSnap = snapshot(tiles);
                repoSource = 'repo';
                setBadge('saved');
                conflict.hide();
                AC.status($status, 'Wrote ' + result.paths.length + ' file(s) to the repository: ' +
                    result.paths.join(', ') + '. Review with git status, then commit & push.', 'success');
            } else if (result.mode === 'zip') {
                // Fallback: nothing is on disk yet. Keep the File objects so a
                // later direct save (or another export) still includes the images.
                setBadge('draft');
                AC.status($status, 'Downloaded featured-repo-update.zip — extract at the repository root ' +
                    '(paths already match), then commit & push.', 'success');
            } else {
                setBadge('draft');
                AC.status($status, 'Downloaded featured.json — replace the copy at the repository root, then commit & push.', 'success');
            }
            saveDraft();
        }).catch(function (err) {
            AC.status($status, 'Save failed: ' + (err.message || err), 'error');
        }).finally(function () {
            btn.disabled = false;
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})(typeof window !== 'undefined' ? window : this);
