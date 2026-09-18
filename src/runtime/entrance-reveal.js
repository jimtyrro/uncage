/**
 * uncage-runtime: entrance-reveal
 *
 * Replaces Framer/Webflow's own scroll-triggered "fade + slide up" entrance
 * animation. astro.ts's compile-time bake-in pass already forces every
 * JS-controlled element's opacity to 1 (see the "bake settled opacity"
 * comment in astro.ts) so the page is correct with zero JS -- this module
 * re-adds the reveal-on-scroll *effect* as progressive enhancement: it
 * hides matching elements again on load, then reveals each one exactly
 * once when it scrolls into view.
 *
 * Targets the same detection signature astro.ts and interactivity.ts both
 * use: an inline style containing `will-change` (a CSS hint browsers only
 * get when JS is about to animate that property, never present on
 * authored CSS) -- so this only touches elements that were genuinely
 * JS-controlled in the original captured page, not incidental content.
 *
 * Excludes orbit's target elements specifically: a real conflict found
 * live on dermato once the `orbit` widget was added -- this module's
 * client-side check was will-change-only (no opacity check), broader
 * than its own server-side interactivity.ts counterpart (which requires
 * opacity < 1), so it was also matching orbit's continuously-rotating
 * badges (will-change:transform, opacity already 1, transform a pure
 * rotate()) and, since they're above the fold, revealing them on init --
 * which hardcodes `transform: none`, permanently overwriting orbit's
 * captured rotation angle before orbit.js's own init ever got to read
 * it. A pure `rotate(Ndeg)` transform is exactly orbit's signature and
 * never entrance-reveal's own (which bakes to `translateY(...)
 * scale(...)` or similar, never a bare rotate), so excluding it here is
 * precise, not a broad carve-out.
 */
(function () {
  'use strict';

  var SELECTOR = '[style*="will-change"]';
  var REVEAL_CLASS = 'uncage-revealed';
  var HIDDEN_STYLE_ATTR = 'data-uncage-reveal-hidden';
  var PURE_ROTATE_RE = /^rotate\(\s*-?[\d.]+deg\s*\)$/i;

  function isOrbitTarget(el) {
    var style = el.getAttribute('style') || '';
    var m = style.match(/transform:\s*([^;]+)/i);
    return !!m && PURE_ROTATE_RE.test(m[1].trim());
  }

  function isRevealCandidate(el) {
    var style = el.getAttribute('style') || '';
    return /will-change/i.test(style) && !isOrbitTarget(el);
  }

  function hideInitially(el) {
    // Store the element's own transform so the reveal can restore it
    // exactly, rather than guessing a target offset -- the captured
    // style already encodes whatever the original design's animation
    // target was (opacity:1, transform baked to identity by astro.ts's
    // compile-time pass).
    if (el.hasAttribute(HIDDEN_STYLE_ATTR)) return;
    el.setAttribute(HIDDEN_STYLE_ATTR, '1');
    el.style.opacity = '0';
    el.style.transform = 'translateY(24px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
  }

  function reveal(el) {
    if (el.classList.contains(REVEAL_CLASS)) return;
    el.classList.add(REVEAL_CLASS);
    el.style.opacity = '1';
    el.style.transform = 'none';
  }

  function init() {
    var candidates = document.querySelectorAll(SELECTOR);
    if (!candidates.length) return;

    if (typeof IntersectionObserver === 'undefined') {
      // No observer support: reveal everything immediately rather than
      // leaving content permanently hidden -- correctness over polish.
      for (var i = 0; i < candidates.length; i++) {
        if (isRevealCandidate(candidates[i])) reveal(candidates[i]);
      }
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].isIntersecting) {
            reveal(entries[j].target);
            observer.unobserve(entries[j].target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.1 }
    );

    for (var k = 0; k < candidates.length; k++) {
      var el = candidates[k];
      if (!isRevealCandidate(el)) continue;
      var rect = el.getBoundingClientRect();
      var alreadyInView = rect.top < window.innerHeight && rect.bottom > 0;
      if (alreadyInView) {
        // Above-the-fold content reveals immediately -- matches how the
        // original page behaved for content visible at first paint,
        // never made a visitor wait for content already on screen.
        reveal(el);
        continue;
      }
      hideInitially(el);
      observer.observe(el);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
