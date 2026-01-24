/* ============================================
   FEATURED TILES MANAGER - MAIN LOGIC
   ============================================ */

(function() {
    'use strict';

    // State
    let tiles = [];
    let importedData = null;
    const STORAGE_KEY = 'dickson_featured_draft';

    // Initialize
    function init() {
        generateTileEditors();
        loadFromLocalStorage();
        attachEventListeners();
        showStatus('Manager ready. Import featured.json or start editing.', 'info');
    }

    // Generate 9 tile editors
    function generateTileEditors() {
        const grid = document.getElementById('tilesGrid');
        
        for (let i = 1; i <= 9; i++) {
            const tileId = `T${i}`;
            const tile = {
                id: tileId,
                title: '',
                price: '',
                url: '',
                mode: 'local',
                localImage: `images/featured/${tileId}.jpg`,
                remoteImage: '',
                imageFile: null,
                imagePreview: null
            };
            tiles.push(tile);

            const editor = createTileEditor(tile);
            grid.appendChild(editor);
        }
    }

    // Create tile editor HTML
    function createTileEditor(tile) {
        const div = document.createElement('div');
        div.className = 'tile-editor';
        div.dataset.tileId = tile.id;
        
        div.innerHTML = `
            <div class="tile-header">
                <span class="tile-id">${tile.id}</span>
                <span class="tile-preview-mini"></span>
            </div>

            <div class="form-group">
                <label>Title</label>
                <input type="text" class="tile-title" placeholder="e.g., Antique Silver Tea Set">
            </div>

            <div class="form-group">
                <label>Price</label>
                <input type="text" class="tile-price" placeholder="e.g., $1,250.00">
            </div>

            <div class="form-group">
                <label>eBay URL</label>
                <input type="url" class="tile-url" placeholder="https://www.ebay.com/itm/...">
            </div>

            <div class="form-group">
                <label>Image Mode</label>
                <div class="mode-toggle">
                    <button class="mode-btn mode-local active" data-mode="local">📁 Local</button>
                    <button class="mode-btn mode-remote" data-mode="remote">🌐 Remote</button>
                </div>
            </div>

            <div class="image-section-local">
                <div class="form-group">
                    <label>Upload Image</label>
                    <div class="image-upload" data-tile-id="${tile.id}">
                        <div class="upload-icon">📷</div>
                        <div class="upload-text">Click or drag image here</div>
                        <div class="upload-subtext">JPG, PNG (recommended: 600x600px)</div>
                    </div>
                    <input type="file" class="image-file-input" accept="image/*" style="display: none;">
                    <div class="image-preview hidden">
                        <img class="preview-img" src="" alt="Preview">
                        <div class="preview-filename"></div>
                        <button class="clear-image">Clear Image</button>
                    </div>
                </div>
            </div>

            <div class="image-section-remote hidden">
                <div class="form-group">
                    <label>Remote Image URL</label>
                    <input type="url" class="tile-remote-image" placeholder="https://i.ebayimg.com/...">
                </div>
            </div>
        `;

        attachTileListeners(div, tile);
        return div;
    }

    // Attach listeners to a tile editor
    function attachTileListeners(editor, tile) {
        const tileId = tile.id;

        // Text inputs
        editor.querySelector('.tile-title').addEventListener('input', (e) => {
            tile.title = e.target.value;
            saveToLocalStorage();
        });

        editor.querySelector('.tile-price').addEventListener('input', (e) => {
            tile.price = e.target.value;
            saveToLocalStorage();
        });

        editor.querySelector('.tile-url').addEventListener('input', (e) => {
            tile.url = e.target.value;
            saveToLocalStorage();
        });

        editor.querySelector('.tile-remote-image').addEventListener('input', (e) => {
            tile.remoteImage = e.target.value;
            saveToLocalStorage();
        });

        // Mode toggle
        const modeButtons = editor.querySelectorAll('.mode-btn');
        modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                tile.mode = mode;
                
                modeButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Toggle sections
                if (mode === 'local') {
                    editor.querySelector('.image-section-local').classList.remove('hidden');
                    editor.querySelector('.image-section-remote').classList.add('hidden');
                } else {
                    editor.querySelector('.image-section-local').classList.add('hidden');
                    editor.querySelector('.image-section-remote').classList.remove('hidden');
                }

                saveToLocalStorage();
            });
        });

        // Image upload
        const uploadArea = editor.querySelector('.image-upload');
        const fileInput = editor.querySelector('.image-file-input');
        const preview = editor.querySelector('.image-preview');
        const previewImg = editor.querySelector('.preview-img');
        const previewFilename = editor.querySelector('.preview-filename');
        const clearBtn = editor.querySelector('.clear-image');

        uploadArea.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) handleImageFile(file, tile, preview, previewImg, previewFilename);
        });

        // Drag and drop
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) {
                handleImageFile(file, tile, preview, previewImg, previewFilename);
            }
        });

        // Clear image
        clearBtn.addEventListener('click', () => {
            tile.imageFile = null;
            tile.imagePreview = null;
            preview.classList.add('hidden');
            fileInput.value = '';
            saveToLocalStorage();
        });
    }

    // Handle image file upload
    function handleImageFile(file, tile, preview, previewImg, previewFilename) {
        tile.imageFile = file;

        const reader = new FileReader();
        reader.onload = (e) => {
            tile.imagePreview = e.target.result;
            previewImg.src = e.target.result;
            previewFilename.textContent = file.name;
            preview.classList.remove('hidden');
            saveToLocalStorage();
        };
        reader.readAsDataURL(file);
    }

    // Attach toolbar listeners
    function attachEventListeners() {
        document.getElementById('importBtn').addEventListener('click', () => {
            document.getElementById('importFile').click();
        });

        document.getElementById('importFile').addEventListener('change', handleImport);
        document.getElementById('resetBtn').addEventListener('click', resetToImported);
        document.getElementById('clearBtn').addEventListener('click', clearDraft);
        document.getElementById('exportBtn').addEventListener('click', exportData);
    }

    // Import featured.json
    function handleImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);
                importedData = data;
                populateFromData(data);
                saveToLocalStorage();
                showStatus('✓ Imported successfully!', 'success');
            } catch (error) {
                showStatus('✗ Error importing JSON: ' + error.message, 'error');
            }
        };
        reader.readAsText(file);
    }

    // Populate tiles from data
    function populateFromData(data) {
        data.tiles.forEach(tileData => {
            const tile = tiles.find(t => t.id === tileData.id);
            if (!tile) return;

            tile.title = tileData.title || '';
            tile.price = tileData.price || '';
            tile.url = tileData.url || '';
            tile.mode = tileData.mode || 'local';
            tile.localImage = tileData.localImage || `images/featured/${tile.id}.jpg`;
            tile.remoteImage = tileData.remoteImage || '';

            updateEditorUI(tile);
        });
    }

    // Update editor UI from tile data
    function updateEditorUI(tile) {
        const editor = document.querySelector(`[data-tile-id="${tile.id}"]`);
        if (!editor) return;

        editor.querySelector('.tile-title').value = tile.title;
        editor.querySelector('.tile-price').value = tile.price;
        editor.querySelector('.tile-url').value = tile.url;
        editor.querySelector('.tile-remote-image').value = tile.remoteImage;

        // Update mode buttons
        const modeButtons = editor.querySelectorAll('.mode-btn');
        modeButtons.forEach(btn => {
            if (btn.dataset.mode === tile.mode) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Show/hide sections
        if (tile.mode === 'local') {
            editor.querySelector('.image-section-local').classList.remove('hidden');
            editor.querySelector('.image-section-remote').classList.add('hidden');
        } else {
            editor.querySelector('.image-section-local').classList.add('hidden');
            editor.querySelector('.image-section-remote').classList.remove('hidden');
        }
    }

    // Reset to imported data
    function resetToImported() {
        if (!importedData) {
            showStatus('No imported data to reset to', 'error');
            return;
        }
        populateFromData(importedData);
        saveToLocalStorage();
        showStatus('✓ Reset to imported data', 'success');
    }

    // Clear draft
    function clearDraft() {
        if (!confirm('Clear all draft data? This cannot be undone.')) return;

        localStorage.removeItem(STORAGE_KEY);
        tiles.forEach(tile => {
            tile.title = '';
            tile.price = '';
            tile.url = '';
            tile.mode = 'local';
            tile.remoteImage = '';
            tile.imageFile = null;
            tile.imagePreview = null;
            updateEditorUI(tile);
            
            // Clear previews
            const editor = document.querySelector(`[data-tile-id="${tile.id}"]`);
            editor.querySelector('.image-preview').classList.add('hidden');
            editor.querySelector('.image-file-input').value = '';
        });

        showStatus('✓ Draft cleared', 'success');
    }

    // Save to localStorage
    function saveToLocalStorage() {
        const draft = {
            timestamp: new Date().toISOString(),
            tiles: tiles.map(t => ({
                id: t.id,
                title: t.title,
                price: t.price,
                url: t.url,
                mode: t.mode,
                localImage: t.localImage,
                remoteImage: t.remoteImage,
                imagePreview: t.imagePreview
            }))
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    }

    // Load from localStorage
    function loadFromLocalStorage() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return;

        try {
            const draft = JSON.parse(saved);
            draft.tiles.forEach(tileData => {
                const tile = tiles.find(t => t.id === tileData.id);
                if (!tile) return;

                Object.assign(tile, tileData);
                updateEditorUI(tile);

                // Restore image preview if exists
                if (tile.imagePreview) {
                    const editor = document.querySelector(`[data-tile-id="${tile.id}"]`);
                    const preview = editor.querySelector('.image-preview');
                    const previewImg = editor.querySelector('.preview-img');
                    previewImg.src = tile.imagePreview;
                    preview.classList.remove('hidden');
                }
            });

            showStatus('✓ Draft loaded from browser storage', 'info');
        } catch (error) {
            console.error('Error loading draft:', error);
        }
    }

    // Export data
    async function exportData() {
        try {
            // Create JSON
            const jsonData = {
                updatedAt: new Date().toISOString(),
                tiles: tiles.map(t => ({
                    id: t.id,
                    title: t.title,
                    price: t.price,
                    url: t.url,
                    mode: t.mode,
                    localImage: t.localImage,
                    remoteImage: t.remoteImage
                }))
            };

            // Download JSON
            downloadJSON(jsonData);

            // Check if we need to create a ZIP with images
            const tilesWithImages = tiles.filter(t => t.mode === 'local' && t.imageFile);
            
            if (tilesWithImages.length > 0) {
                await createImageZip(tilesWithImages);
                showStatus(`✓ Exported JSON + ZIP with ${tilesWithImages.length} images`, 'success');
            } else {
                showStatus('✓ Exported JSON (no local images to zip)', 'success');
            }

        } catch (error) {
            showStatus('✗ Export error: ' + error.message, 'error');
        }
    }

    // Download JSON file
    function downloadJSON(data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'featured.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    // Create and download ZIP with images
    async function createImageZip(tilesWithImages) {
        const zip = new JSZip();
        const imagesFolder = zip.folder('images').folder('featured');

        for (const tile of tilesWithImages) {
            if (tile.imageFile) {
                // Get file extension
                const ext = tile.imageFile.name.split('.').pop();
                const filename = `${tile.id}.${ext}`;
                
                // Add to ZIP
                imagesFolder.file(filename, tile.imageFile);
            }
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'featured-images.zip';
        a.click();
        URL.revokeObjectURL(url);
    }

    // Show status message
    function showStatus(message, type = 'info') {
        const statusBar = document.getElementById('statusBar');
        statusBar.textContent = message;
        statusBar.className = `status-bar show ${type}`;

        setTimeout(() => {
            statusBar.classList.remove('show');
        }, 5000);
    }

    // Initialize on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
