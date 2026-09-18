/**
 * uncage-runtime: marquee
 *
 * Seamless-loop scrolling row (testimonials, logo strips, ticker text).
 * Runs its own client-side detection mirroring interactivity.ts's
 * server-side check (a container whose children split into two identical
 * halves -- the standard technique for a gapless loop: animate to -50%,
 * then reset, so the seam between the duplicated content is never seen)
 * rather than relying on any server-side marker, keeping this module
 * self-contained like uncage-runtime's other pieces.
 *
 * Deliberately non-destructive: only adds the transform animation and
 * `overflow: hidden` needed for the loop to read correctly. Never
 * touches each child's own layout (flex-direction, gap, sizing, ...) --
 * that's already correct in the captured CSS, and rewriting it risks
 * breaking a container that only coincidentally has duplicated content.
 */
(function () {
  'use strict';

  var ANIMATED_CLASS = 'uncage-marquee-track';
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function textSignature(el) {
    var img = el.tagName === 'IMG' ? el : el.querySelector('img');
    var imgSig = img ? (img.getAttribute('src') || '') + '|' + (img.getAttribute('alt') || '') : '';
    return (el.textContent || '').trim() + '|' + imgSig;
  }

  function isSeamlessLoop(container) {
    var kids = container.children;
    if (kids.length < 4 || kids.length % 2 !== 0) return false;
    var half = kids.length / 2;
    var firstSigs = [];
    var secondSigs = [];
    var contentLength = 0;
    for (var i = 0; i < half; i++) {
      var sig = textSignature(kids[i]);
      firstSigs.push(sig);
      contentLength += sig.replace(/\|/g, '').length;
    }
    for (var j = half; j < kids.length; j++) {
      secondSigs.push(textSignature(kids[j]));
    }
    return contentLength >= 12 && firstSigs.join(',') === secondSigs.join(',');
  }

  function animate(container) {
    if (container.classList.contains(ANIMATED_CLASS)) return;
    container.classList.add(ANIMATED_CLASS);
    container.style.overflow = 'hidden';
    if (reducedMotion) return; // static seamless-loop content is still correct without motion
    var inner = container;
    inner.style.display = inner.style.display || 'flex';
    inner.style.width = 'max-content';
    inner.style.animation = 'uncage-marquee-scroll 30s linear infinite';
    container.addEventListener('mouseenter', function () {
      inner.style.animationPlayState = 'paused';
    });
    container.addEventListener('mouseleave', function () {
      inner.style.animationPlayState = 'running';
    });
  }

  function injectKeyframes() {
    if (document.getElementById('uncage-marquee-keyframes')) return;
    var style = document.createElement('style');
    style.id = 'uncage-marquee-keyframes';
    style.textContent =
      '@keyframes uncage-marquee-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }';
    document.head.appendChild(style);
  }

  function init() {
    var all = document.querySelectorAll('*');
    var found = [];
    for (var i = 0; i < all.length; i++) {
      if (isSeamlessLoop(all[i])) found.push(all[i]);
    }
    if (!found.length) return;
    injectKeyframes();
    for (var k = 0; k < found.length; k++) animate(found[k]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
