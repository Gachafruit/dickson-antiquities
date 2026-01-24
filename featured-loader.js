/* ============================================
   FEATURED TILES LOADER
   Loads featured.json and populates the 9 tiles
   ============================================ */

(function() {
    'use strict';

    // Load and populate featured tiles on page load
    async function loadFeaturedTiles() {
        try {
            const response = await fetch('/featured.json');
            if (!response.ok) {
                console.warn('featured.json not found, keeping placeholder data');
                return;
            }

            const data = await response.json();
            
            // Get all product cards in the featured section
            const featuredSection = document.querySelector('#featured .product-grid');
            if (!featuredSection) {
                console.error('Featured section not found');
                return;
            }

            const productCards = featuredSection.querySelectorAll('.product-card');
            
            // Map tiles by ID for easy lookup
            const tilesMap = {};
            data.tiles.forEach(tile => {
                tilesMap[tile.id] = tile;
            });

            // Populate each card (T1-T9 correspond to first 9 cards in DOM order)
            productCards.forEach((card, index) => {
                const tileId = `T${index + 1}`;
                const tileData = tilesMap[tileId];

                if (!tileData) {
                    console.warn(`No data for tile ${tileId}`);
                    return;
                }

                // Update image
                const imageContainer = card.querySelector('.product-image');
                if (imageContainer) {
                    // Remove placeholder if exists
                    const placeholder = imageContainer.querySelector('.placeholder-img');
                    if (placeholder) {
                        placeholder.remove();
                    }

                    // Get or create img element
                    let img = imageContainer.querySelector('img');
                    if (!img) {
                        img = document.createElement('img');
                        imageContainer.appendChild(img);
                    }

                    // Set image source based on mode
                    if (tileData.mode === 'remote' && tileData.remoteImage) {
                        img.src = tileData.remoteImage;
                    } else if (tileData.mode === 'local' && tileData.localImage) {
                        img.src = tileData.localImage;
                    }

                    img.alt = tileData.title;
                    img.style.display = 'block';
                }

                // Update title
                const titleElement = card.querySelector('.product-title');
                if (titleElement && tileData.title) {
                    titleElement.textContent = tileData.title;
                }

                // Update price
                const priceElement = card.querySelector('.product-price');
                if (priceElement && tileData.price) {
                    priceElement.textContent = tileData.price;
                }

                // Update link
                const linkElement = card.querySelector('.product-link');
                if (linkElement && tileData.url) {
                    linkElement.href = tileData.url;
                    linkElement.target = '_blank';
                    linkElement.rel = 'noopener noreferrer';
                }
            });

            console.log('✓ Featured tiles loaded successfully');

        } catch (error) {
            console.error('Error loading featured tiles:', error);
        }
    }

    // Load tiles when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadFeaturedTiles);
    } else {
        loadFeaturedTiles();
    }

})();
