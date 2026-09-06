/* ============================================
   DICKSON ANTIQUITIES - AdminCommon
   Shared helpers for the Dickson admin tools. Only genuinely
   repeated behaviour lives here:
     - repository connection/status bar wiring (uses window.RepoFS)
     - authoritative JSON loading (repo -> served HTTP fallback)
     - draft vs repository conflict detection
     - loaded / draft / saved state badges
     - status messages
     - commit: direct RepoFS writes, else one repo-path-mirroring ZIP
       (JSON + images) or a plain JSON download (JSON only)

   The pure helpers (deepEqual, stringify*, commitMode, etc.) are also
   exported for Node so they can be unit-tested without a browser.
   ============================================ */

(function (root) {
    'use strict';

    var RepoFS = (typeof module !== 'undefined' && module.exports)
        ? require('./repo-fs.js')
        : root.RepoFS;

    /* ------------------------------------------------------------------
       Pure helpers
       ------------------------------------------------------------------ */

    function deepEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== typeof b) return false;
        if (a === null || b === null) return a === b;
        if (typeof a !== 'object') return a === b;

        var aArr = Array.isArray(a), bArr = Array.isArray(b);
        if (aArr !== bArr) return false;
        if (aArr) {
            if (a.length !== b.length) return false;
            for (var i = 0; i < a.length; i++) {
                if (!deepEqual(a[i], b[i])) return false;
            }
            return true;
        }
        var ak = Object.keys(a), bk = Object.keys(b);
        if (ak.length !== bk.length) return false;
        for (var j = 0; j < ak.length; j++) {
            if (!Object.prototype.hasOwnProperty.call(b, ak[j])) return false;
            if (!deepEqual(a[ak[j]], b[ak[j]])) return false;
        }
        return true;
    }

    // Match the existing on-disk style of each file.
    function stringifyJSON(data, opts) {
        opts = opts || {};
        var out = JSON.stringify(data, null, 2);
        if (opts.trailingNewline) out += '\n';
        return out;
    }

    function isBinary(content) {
        return (typeof Blob !== 'undefined' && content instanceof Blob) ||
               (typeof File !== 'undefined' && content instanceof File);
    }

    // Decide how a commit will be delivered. Pure + testable.
    //   files: [{ path, content }]
    //   connected: boolean (RepoFS connected)
    // -> 'repo' | 'zip' | 'json'
    function commitMode(files, connected) {
        if (connected) return 'repo';
        var hasBinary = files.some(function (f) { return isBinary(f.content); });
        if (hasBinary) return 'zip';
        return (files.length === 1) ? 'json' : 'zip';
    }

    function basename(path) {
        var parts = String(path).split('/');
        return parts[parts.length - 1];
    }

    /* ------------------------------------------------------------------
       Browser-only helpers
       ------------------------------------------------------------------ */

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    /* ---- Status bar ---- */
    function status(container, message, type) {
        if (!container) return;
        container.textContent = message;
        container.className = 'status-bar ' + (type || 'info');
        container.hidden = false;
    }

    /* ---- State badge ---- */
    // kind: 'repo' | 'http' | 'saved' | 'draft' | 'empty'
    var BADGE_TEXT = {
        repo: 'Loaded from repository',
        http: 'Loaded from live site',
        saved: 'Saved to repository',
        draft: 'Local draft · unsaved edits',
        empty: 'No data loaded'
    };
    function setBadge(node, kind, textOverride) {
        if (!node) return;
        node.className = 'state-badge badge-' + kind;
        node.textContent = textOverride || BADGE_TEXT[kind] || kind;
    }

    /* ---- Repo connection bar ---- */
    // opts.onChange(state)  -> called after every connection-state change,
    //                          including the initial restore().
    function mountRepoBar(container, opts) {
        opts = opts || {};
        if (!container) return;

        var dot = el('span', 'repo-bar__dot');
        var text = el('span', 'repo-bar__text');
        var spacer = el('span', 'repo-bar__spacer');
        var actions = el('span', 'repo-bar__actions');
        container.className = 'repo-bar';
        container.innerHTML = '';
        container.append(dot, text, spacer, actions);

        function button(label, cls, handler) {
            var b = el('button', 'btn btn-sm ' + cls, label);
            b.addEventListener('click', function () {
                b.disabled = true;
                Promise.resolve()
                    .then(handler)
                    .catch(function (err) {
                        if (opts.statusEl) status(opts.statusEl, err.message || String(err), 'error');
                        else alert(err.message || String(err));
                    })
                    .finally(function () { b.disabled = false; });
            });
            return b;
        }

        function render(s) {
            actions.innerHTML = '';
            container.classList.remove('is-connected', 'needs-reconnect', 'is-unsupported');

            if (!s.supported) {
                container.classList.add('is-unsupported');
                text.innerHTML = '<strong>Download mode.</strong> This browser can’t write to the repo directly — saves produce a repo-ready ZIP/JSON to commit.';
                return;
            }
            if (s.connected) {
                container.classList.add('is-connected');
                text.innerHTML = 'Connected to <strong>' + (s.folderName || 'repository') + '</strong> — saves write directly to the working copy.';
                actions.append(button('Disconnect', 'btn-secondary', function () { return RepoFS.disconnect(); }));
            } else if (s.needsReconnect) {
                container.classList.add('needs-reconnect');
                text.innerHTML = 'Repository folder remembered — <strong>reconnect to grant access for this session.</strong>';
                actions.append(button('Reconnect', 'btn-primary', function () { return RepoFS.reconnect(); }));
                actions.append(button('Disconnect', 'btn-secondary', function () { return RepoFS.disconnect(); }));
            } else {
                text.innerHTML = 'Not connected. <strong>Connect the repository folder</strong> for one-click saves, or use download mode.';
                actions.append(button('Connect repository…', 'btn-primary', function () { return RepoFS.connect(); }));
            }
        }

        var lastConnected = null;
        RepoFS.onChange(function (s) {
            render(s);
            if (s.connected !== lastConnected) {
                lastConnected = s.connected;
                if (opts.onChange) opts.onChange(s);
            }
        });
        // Never prompts; resolves stored-handle permission silently.
        RepoFS.restore();
    }

    /* ---- Conflict banner ---- */
    // Returns { show(), hide() }. onResume / onLoadRepo are called on click.
    function mountConflictBanner(container, opts) {
        opts = opts || {};
        container.className = 'conflict-banner';
        container.hidden = true;
        container.innerHTML =
            '<h3>This browser has an unsaved draft that differs from the repository.</h3>' +
            '<p>Choose which version to work from. Nothing is overwritten until you save.</p>' +
            '<div class="conflict-actions">' +
            '<button class="btn btn-sm btn-primary" data-act="resume">Resume draft</button>' +
            '<button class="btn btn-sm btn-secondary" data-act="repo">Load repository version</button>' +
            '</div>';
        container.querySelector('[data-act="resume"]').addEventListener('click', function () {
            container.hidden = true;
            if (opts.onResume) opts.onResume();
        });
        container.querySelector('[data-act="repo"]').addEventListener('click', function () {
            container.hidden = true;
            if (opts.onLoadRepo) opts.onLoadRepo();
        });
        return {
            show: function () { container.hidden = false; },
            hide: function () { container.hidden = true; }
        };
    }

    /* ---- Authoritative JSON loading ----
       Order: connected repo file  ->  served HTTP file.
       Returns { data, source: 'repo' | 'http' }. Throws only if both fail. */
    function loadJSON(cfg) {
        var attempts = [];
        if (RepoFS && RepoFS.isConnected && RepoFS.isConnected()) {
            attempts.push(function () {
                return RepoFS.readJSON(cfg.repoPath).then(function (data) {
                    return { data: data, source: 'repo' };
                });
            });
        }
        attempts.push(function () {
            return fetch(cfg.httpUrl, { cache: 'no-store' }).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + cfg.httpUrl);
                return r.json();
            }).then(function (data) {
                return { data: data, source: 'http' };
            });
        });

        return attempts.reduce(function (chain, attempt) {
            return chain.catch(function () { return attempt(); });
        }, Promise.reject());
    }

    /* ---- Commit ----
       files: [{ path, content }]   content: string | Blob | File
       opts.zipName: filename for the fallback ZIP
       -> resolves { mode: 'repo' | 'zip' | 'json', paths: [...] } */
    function commit(files, opts) {
        opts = opts || {};
        var connected = !!(RepoFS && RepoFS.isConnected && RepoFS.isConnected());
        var mode = commitMode(files, connected);
        var paths = files.map(function (f) { return f.path; });

        if (mode === 'repo') {
            return files.reduce(function (chain, f) {
                return chain.then(function () { return RepoFS.writeFile(f.path, f.content); });
            }, Promise.resolve()).then(function () {
                return { mode: 'repo', paths: paths };
            });
        }

        if (mode === 'json') {
            var f = files[0];
            var blob = (typeof f.content === 'string')
                ? new Blob([f.content], { type: 'application/json' })
                : f.content;
            downloadBlob(blob, basename(f.path));
            return Promise.resolve({ mode: 'json', paths: paths });
        }

        // mode === 'zip' : one repo-ready archive, internal paths mirror the repo.
        if (typeof JSZip === 'undefined') {
            return Promise.reject(new Error('JSZip is not loaded; cannot build the fallback ZIP.'));
        }
        var zip = new JSZip();
        files.forEach(function (file) {
            zip.file(file.path, file.content);
        });
        return zip.generateAsync({ type: 'blob' }).then(function (blob) {
            downloadBlob(blob, opts.zipName || 'dickson-repo-update.zip');
            return { mode: 'zip', paths: paths };
        });
    }

    var api = {
        deepEqual: deepEqual,
        stringifyJSON: stringifyJSON,
        commitMode: commitMode,
        isBinary: isBinary,
        basename: basename,
        // browser-only
        mountRepoBar: mountRepoBar,
        mountConflictBanner: mountConflictBanner,
        loadJSON: loadJSON,
        commit: commit,
        status: status,
        setBadge: setBadge,
        downloadBlob: downloadBlob
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.AdminCommon = api;
    }

})(typeof window !== 'undefined' ? window : this);
