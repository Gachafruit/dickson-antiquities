/* ============================================
   DICKSON ANTIQUITIES - JAVASCRIPT
   Minimal vanilla JS for interactions
   ============================================ */

// ============================================
// MOBILE NAVIGATION TOGGLE
// ============================================
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');

if (navToggle) {
    navToggle.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        navToggle.classList.toggle('active');
    });

    // Close menu when clicking a link
    const navItems = document.querySelectorAll('.nav-links a:not(.btn-primary)');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navLinks.classList.remove('active');
            navToggle.classList.remove('active');
        });
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (!navToggle.contains(e.target) && !navLinks.contains(e.target)) {
            navLinks.classList.remove('active');
            navToggle.classList.remove('active');
        }
    });
}

// ============================================
// SMOOTH SCROLL FOR ANCHOR LINKS
// ============================================
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        
        // Skip if it's just "#" (empty anchor)
        if (href === '#') {
            e.preventDefault();
            return;
        }
        
        const target = document.querySelector(href);
        
        if (target) {
            e.preventDefault();
            
            // Get nav height for offset
            const nav = document.querySelector('.nav-bar');
            const navHeight = nav ? nav.offsetHeight : 0;
            
            const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navHeight;
            
            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });
        }
    });
});

// ============================================
// HORIZONTAL SCROLL NAVIGATION
// ============================================
const scrollContainer = document.querySelector('.scroll-container');
const scrollBtnLeft = document.querySelector('.scroll-btn-left');
const scrollBtnRight = document.querySelector('.scroll-btn-right');

if (scrollContainer && scrollBtnLeft && scrollBtnRight) {
    // Scroll amount (adjust as needed)
    const scrollAmount = 300;
    
    scrollBtnLeft.addEventListener('click', () => {
        scrollContainer.scrollBy({
            left: -scrollAmount,
            behavior: 'smooth'
        });
    });
    
    scrollBtnRight.addEventListener('click', () => {
        scrollContainer.scrollBy({
            left: scrollAmount,
            behavior: 'smooth'
        });
    });
    
    // Update button visibility based on scroll position
    function updateScrollButtons() {
        const scrollLeft = scrollContainer.scrollLeft;
        const scrollWidth = scrollContainer.scrollWidth;
        const clientWidth = scrollContainer.clientWidth;
        
        // Hide left button if at start
        if (scrollLeft <= 0) {
            scrollBtnLeft.style.opacity = '0.3';
            scrollBtnLeft.style.pointerEvents = 'none';
        } else {
            scrollBtnLeft.style.opacity = '1';
            scrollBtnLeft.style.pointerEvents = 'all';
        }
        
        // Hide right button if at end
        if (scrollLeft + clientWidth >= scrollWidth - 1) {
            scrollBtnRight.style.opacity = '0.3';
            scrollBtnRight.style.pointerEvents = 'none';
        } else {
            scrollBtnRight.style.opacity = '1';
            scrollBtnRight.style.pointerEvents = 'all';
        }
    }
    
    // Check on scroll
    scrollContainer.addEventListener('scroll', updateScrollButtons);
    
    // Check on load and resize
    window.addEventListener('load', updateScrollButtons);
    window.addEventListener('resize', updateScrollButtons);
}

// ============================================
// NAV BAR SHADOW ON SCROLL
// ============================================
const nav = document.querySelector('.nav-bar');

if (nav) {
    window.addEventListener('scroll', () => {
        if (window.scrollY > 10) {
            nav.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.05)';
        } else {
            nav.style.boxShadow = 'none';
        }
    });
}

// ============================================
// LAZY LOADING FOR IMAGES (when you add real images)
// ============================================
// Uncomment this section when you replace placeholder divs with real images

/*
const lazyImages = document.querySelectorAll('img[data-src]');

const imageObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const img = entry.target;
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
            observer.unobserve(img);
        }
    });
});

lazyImages.forEach(img => imageObserver.observe(img));
*/

// ============================================
// OPTIONAL: FADE IN ANIMATION ON SCROLL
// ============================================
// Uncomment if you want elements to fade in as you scroll

/*
const fadeElements = document.querySelectorAll('.product-card, .social-card');

const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, {
    threshold: 0.1
});

fadeElements.forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    fadeObserver.observe(el);
});
*/

// ============================================
// CONSOLE MESSAGE (Optional - remove if not needed)
// ============================================
console.log('%cDickson Antiquities', 'font-size: 20px; font-weight: bold; color: #a67c52;');
console.log('%cStatic site ready. Remember to:', 'font-size: 14px; color: #666;');
console.log('1. Replace all placeholder images with real product photos');
console.log('2. Update all URLs with your actual eBay store link');
console.log('3. Add your eBay widget embed code in the Newest Listings section');
console.log('4. Update contact information and social media links');
console.log('5. Replace placeholder copy with your actual business description');