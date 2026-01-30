/* ============================================
   SHOWCASE SECTION LOADER
   Fetches random items from Cloudflare Worker
   ============================================ */

(function() {
    'use strict';

    const WORKER_URL = 'https://showcase.andickso21.workers.dev/showcase';
    const RETRY_DELAY = 3000; // 3 seconds

    /**
     * Load and display showcase items
     */
    async function loadShowcaseItems() {
        const container = document.getElementById('showcaseItemsList');
        const errorMessage = document.getElementById('showcaseError');
        const loadingMessage = document.getElementById('showcaseLoading');

        if (!container) {
            console.error('Showcase container not found');
            return;
        }

        try {
            // Show loading
            if (loadingMessage) loadingMessage.style.display = 'block';
            if (errorMessage) errorMessage.style.display = 'none';

            const response = await fetch(WORKER_URL);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            // Hide loading
            if (loadingMessage) loadingMessage.style.display = 'none';

            // Check if we have items
            if (!data.items || data.items.length === 0) {
                showError('No items available at the moment. Please check back soon.');
                return;
            }

            // Render items
            renderShowcaseItems(data.items, container);

            console.log(`✓ Loaded ${data.items.length} showcase items`);

        } catch (error) {
            console.error('Error loading showcase items:', error);
            if (loadingMessage) loadingMessage.style.display = 'none';
            showError('Unable to load items. Please refresh the page.');
        }
    }

    /**
     * Render showcase items as vertical list
     */
    function renderShowcaseItems(items, container) {
        container.innerHTML = '';

        items.forEach(item => {
            const itemElement = createShowcaseItem(item);
            container.appendChild(itemElement);
        });
    }

    /**
     * Create a single showcase item element
     */
    function createShowcaseItem(item) {
        const article = document.createElement('article');
        article.className = 'showcase-item';

        // Format price
        const formattedPrice = formatPrice(item.price, item.currency);

        article.innerHTML = `
            <a href="${escapeHtml(item.url)}" class="showcase-link" target="_blank" rel="noopener noreferrer">
                <div class="showcase-image">
                    <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy">
                </div>
                <div class="showcase-details">
                    <h3 class="showcase-title">${escapeHtml(item.title)}</h3>
                    <p class="showcase-price">${formattedPrice}</p>
                </div>
            </a>
        `;

        return article;
    }

    /**
     * Format price with currency
     */
    function formatPrice(price, currency) {
        if (!price || price === 0) return 'Price on request';

        const formatted = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency || 'USD',
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
        }).format(price);

        return formatted;
    }

    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Show error message
     */
    function showError(message) {
        const errorMessage = document.getElementById('showcaseError');
        if (errorMessage) {
            errorMessage.textContent = message;
            errorMessage.style.display = 'block';
        }
    }

    // Load items when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadShowcaseItems);
    } else {
        loadShowcaseItems();
    }

})();
