/**
 * uncage-runtime: header-hide
 *
 * A sticky nav/header that hides on scroll-down and reveals on scroll-up
 * (confirmed live: dermato's header, driven by a JS scroll listener that
 * continuously writes a translateY onto the sticky container -- gone
 * once the original site's own hydration JS is stripped, so the header
 * stays permanently shown and visually sits on top of whatever content
 * scrolls under it).
 *
 * Detection mirrors interactivity.ts's server-side check: a `position:
 * sticky` element carrying `will-change: transform` on itself (not a
 * descendant -- that's scroll-pin's signal instead) that is or contains
 * a real <header>/<nav> landmark. A plain always-visible sticky header
 * authored in pure CSS has no reason to declare `will-change: transform`
 * on itself, so this correctly stays inert on sites that want the header
 * to never hide.
 *
 * Best-effort generic reproduction of the effect's shape (hide past a
 * small scroll threshold when moving down, reveal immediately when
 * moving up, always shown near the very top) -- not a clone of any
 * specific template's exact thresholds/easing.
 */
(function () {
  'use strict';

  function findStickyHeaders() {
    var all = document.querySelectorAll('*');
    var found = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var style = el.getAttribute('style') || '';
      if (!/will-change/i.test(style) || !/transform/i.test(style)) continue;
      if (getComputedStyle(el).position !== 'sticky') continue;
      if (el.tagName !== 'HEADER' && el.tagName !== 'NAV' && !el.querySelector('header, nav')) continue;
      found.push(el);
    }
    return found;
  }

  function setup(el) {
    var height = el.getBoundingClientRect().height || 0;
    var lastY = window.scrollY;
    var hidden = false;
    var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    el.style.transition = reducedMotion ? 'none' : 'transform 0.25s ease';

    function onScroll() {
      var y = window.scrollY;
      var goingDown = y > lastY;
      var pastThreshold = y > Math.max(height, 80);

      if (goingDown && pastThreshold && !hidden) {
        el.style.transform = 'translateY(-100%)';
        hidden = true;
      } else if ((!goingDown || y <= 4) && hidden) {
        el.style.transform = 'none';
        hidden = false;
      }
      lastY = y;
    }

    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function init() {
    var headers = findStickyHeaders();
    for (var i = 0; i < headers.length; i++) setup(headers[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
