/* ============================================
   INSTAGRAM GRID LOADER
   Displays Instagram posts from Cloudflare Worker
   ============================================ */

(function() {
    'use strict';

    const WORKER_URL = 'https://instagram.andickso21.workers.dev/posts';

    /**
     * Load and display Instagram posts
     */
    async function loadInstagramPosts() {
        const container = document.getElementById('instagramGrid');
        
        if (!container) {
            console.error('Instagram grid container not found');
            return;
        }

        try {
            const response = await fetch(WORKER_URL);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            if (!data.posts || data.posts.length === 0) {
                console.warn('No Instagram posts found');
                return;
            }

            // Render posts
            renderInstagramGrid(data.posts, container);

            console.log(`✓ Loaded ${data.posts.length} Instagram posts`);

        } catch (error) {
            console.error('Error loading Instagram posts:', error);
            // Fail silently - section just won't appear
        }
    }

    /**
     * Render Instagram grid
     */
    function renderInstagramGrid(posts, container) {
        container.innerHTML = '';

        posts.forEach(post => {
            const tile = createInstagramTile(post);
            container.appendChild(tile);
        });
    }

    /**
     * Create a single Instagram tile
     */
    function createInstagramTile(post) {
        const tile = document.createElement('a');
        tile.className = 'instagram-tile';
        tile.href = post.url;
        tile.target = '_blank';
        tile.rel = 'noopener noreferrer';
        
        // Use caption for accessibility
        const altText = post.caption 
            ? post.caption.substring(0, 100) 
            : 'View this post on Instagram';
        tile.setAttribute('aria-label', altText);

        const img = document.createElement('img');
        img.src = post.image;
        img.alt = altText;
        img.loading = 'lazy';

        tile.appendChild(img);

        return tile;
    }

    // Load posts when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadInstagramPosts);
    } else {
        loadInstagramPosts();
    }

})();
