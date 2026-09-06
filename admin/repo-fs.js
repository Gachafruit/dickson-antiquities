/* ============================================
   DICKSON ANTIQUITIES - RepoFS
   Thin wrapper around the File System Access API for direct
   repository reads/writes from the admin tools.

   Shared, unmodified, across every Dickson admin tool: connecting
   the repo folder once from any tool makes every other tool see it
   connected (same IndexedDB key).

   Requirements:
   - Served via http://localhost or http://127.0.0.1 (or the deployed
     origin) -- NOT opened via file://. Loopback origins are treated as
     trustworthy by browsers even over plain http.
   - Chromium-based browser (Chrome, Edge, Brave, Opera). Other browsers
     fall back to ZIP/JSON downloads (handled in admin-common.js).
   ============================================ */

(function (root) {
    'use strict';

    var DB_NAME = 'dickson-admin';
    var STORE = 'handles';
    var HANDLE_KEY = 'repo';
    var PICKER_ID = 'dickson-antiquities-repo';

    // Sentinels expected at the Dickson Antiquities repository root.
    // Chosen after inspecting THIS repo -- not copied from Gachafruit.
    var REQUIRED_FILES = ['index.html', 'featured.json', 'showcase.json'];
    var REQUIRED_DIRS = ['images'];

    var dirHandle = null;   // FileSystemDirectoryHandle once picked/restored
    var connected = false;  // true only when readwrite permission is granted
    var listeners = new Set();

    function supported() {
        return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
    }

    /* ---------- IndexedDB (persist the directory handle) ---------- */

    function openDb() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                if (!req.result.objectStoreNames.contains(STORE)) {
                    req.result.createObjectStore(STORE);
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function idbGet(key) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readonly');
                var req = tx.objectStore(STORE).get(key);
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function idbSet(key, val) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(val, key);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function idbDel(key) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).delete(key);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    /* ---------- State / subscription ---------- */

    function state() {
        return {
            supported: supported(),
            connected: connected,
            hasHandle: !!dirHandle,
            needsReconnect: !!dirHandle && !connected,
            folderName: dirHandle ? dirHandle.name : null
        };
    }

    function notify() {
        var s = state();
        listeners.forEach(function (fn) {
            try { fn(s); } catch (e) { /* isolate listener errors */ }
        });
    }

    function onChange(fn) {
        listeners.add(fn);
        try { fn(state()); } catch (e) {}
        return function () { listeners.delete(fn); };
    }

    /* ---------- Permission helpers ---------- */

    function queryPerm(handle) {
        if (!handle.queryPermission) return Promise.resolve('granted');
        return handle.queryPermission({ mode: 'readwrite' });
    }

    function requestPerm(handle) {
        if (!handle.requestPermission) return Promise.resolve('granted');
        return handle.requestPermission({ mode: 'readwrite' });
    }

    /* ---------- Root validation ---------- */

    function validateRoot(handle) {
        var checks = REQUIRED_FILES.map(function (name) {
            return handle.getFileHandle(name).then(
                function () { return null; },
                function () { return 'file "' + name + '"'; }
            );
        }).concat(REQUIRED_DIRS.map(function (name) {
            return handle.getDirectoryHandle(name).then(
                function () { return null; },
                function () { return 'folder "' + name + '/"'; }
            );
        }));

        return Promise.all(checks).then(function (results) {
            var missing = results.filter(Boolean);
            if (missing.length) {
                throw new Error(
                    'That folder does not look like the Dickson Antiquities repository ' +
                    '(missing ' + missing.join(', ') + '). Pick the repository root.'
                );
            }
        });
    }

    /* ---------- Connect / restore / reconnect / disconnect ---------- */

    function connect() {
        if (!supported()) {
            return Promise.reject(new Error(
                'This browser cannot write to the repository directly. Use Chrome, Edge, ' +
                'or Brave served over http://localhost, or use the ZIP download fallback.'
            ));
        }
        return window.showDirectoryPicker({ id: PICKER_ID, mode: 'readwrite' })
            .then(function (handle) {
                return validateRoot(handle).then(function () { return handle; });
            })
            .then(function (handle) {
                return queryPerm(handle).then(function (p) {
                    return p === 'granted' ? handle : requestPerm(handle).then(function (p2) {
                        if (p2 !== 'granted') throw new Error('Write permission was not granted.');
                        return handle;
                    });
                });
            })
            .then(function (handle) {
                dirHandle = handle;
                connected = true;
                return idbSet(HANDLE_KEY, handle).catch(function () {})
                    .then(function () { notify(); return state(); });
            });
    }

    // Called automatically on page load by every tool. Never prompts.
    function restore() {
        if (!supported()) { notify(); return Promise.resolve(state()); }
        return idbGet(HANDLE_KEY).catch(function () { return null; }).then(function (handle) {
            if (!handle) { notify(); return state(); }
            dirHandle = handle;
            return queryPerm(handle).then(function (p) {
                connected = (p === 'granted');
                notify();
                return state();
            });
        });
    }

    // Must be called from within a user gesture (button click).
    function reconnect() {
        if (!dirHandle) return connect();
        return requestPerm(dirHandle).then(function (p) {
            if (p !== 'granted') throw new Error('Write permission was not granted.');
            return validateRoot(dirHandle);
        }).then(function () {
            connected = true;
            notify();
            return state();
        });
    }

    function disconnect() {
        dirHandle = null;
        connected = false;
        return idbDel(HANDLE_KEY).catch(function () {}).then(function () {
            notify();
            return state();
        });
    }

    /* ---------- File IO ---------- */

    function splitPath(path) {
        var parts = String(path).split('/').filter(Boolean);
        var name = parts.pop();
        return { dirs: parts, name: name };
    }

    function resolveDir(create) {
        return function (segments) {
            var chain = Promise.resolve(dirHandle);
            segments.forEach(function (seg) {
                chain = chain.then(function (d) {
                    return d.getDirectoryHandle(seg, { create: create });
                });
            });
            return chain;
        };
    }

    function readFile(path) {
        if (!connected || !dirHandle) return Promise.reject(new Error('Not connected to the repository.'));
        var p = splitPath(path);
        return resolveDir(false)(p.dirs)
            .then(function (d) { return d.getFileHandle(p.name); })
            .then(function (fh) { return fh.getFile(); });
    }

    function readJSON(path) {
        return readFile(path).then(function (file) { return file.text(); }).then(JSON.parse);
    }

    // data: string | Blob | File. Creates intermediate directories as needed.
    function writeFile(path, data) {
        if (!connected || !dirHandle) return Promise.reject(new Error('Not connected to the repository.'));
        var p = splitPath(path);
        return resolveDir(true)(p.dirs)
            .then(function (d) { return d.getFileHandle(p.name, { create: true }); })
            .then(function (fh) { return fh.createWritable(); })
            .then(function (w) {
                return Promise.resolve(w.write(data)).then(function () { return w.close(); });
            });
    }

    var api = {
        supported: supported,
        state: state,
        onChange: onChange,
        connect: connect,
        restore: restore,
        reconnect: reconnect,
        disconnect: disconnect,
        readFile: readFile,
        readJSON: readJSON,
        writeFile: writeFile,
        isConnected: function () { return connected; },
        // exposed for tests
        _internals: { REQUIRED_FILES: REQUIRED_FILES, REQUIRED_DIRS: REQUIRED_DIRS, validateRoot: validateRoot }
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.RepoFS = api;
    }

})(typeof window !== 'undefined' ? window : this);
