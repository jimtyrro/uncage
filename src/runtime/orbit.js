/**
 * uncage-runtime: orbit
 *
 * A "wheel" of evenly-spaced badges/tags continuously rotating around a
 * shared pivot (confirmed live: dermato's hero, 8 service-name badges
 * arranged in a fan, each independently JS-updated every animation
 * frame). Structurally distinct from marquee (translate, seamless-loop
 * duplicated content) and entrance-reveal (opacity 0->1, fires once and
 * stays): this is a rotation-only, continuously-running animation with
 * no natural "settled" static value -- the crawler's scroll-then-reset
 * capture just freezes whatever angle each badge happened to be at that
 * instant, which is why only one badge ends up visible/legible without
 * this widget.
 *
 * Detection mirrors interactivity.ts's server-side check: >=3 sibling
 * elements, each individually carrying `will-change: transform` plus a
 * single `rotate(Ndeg)` transform (nothing else mixed in), whose
 * DOM-order angle deltas are consistent within a small tolerance.
 *
 * Reimplementation strategy: each badge already carries its own correct
 * positioning (transform-origin, radius, base angle) baked into the
 * captured CSS/inline style -- this only needs to keep incrementing each
 * badge's OWN rotate() angle by the same per-frame delta forever, which
 * automatically preserves the original relative spacing between badges
 * without this module needing to know the wheel's pivot geometry at all.
 */
(function () {
  'use strict';

  var DEGREES_PER_SECOND = 6;
  var rotateOnlyRe = /^rotate\(\s*(-?[\d.]+)deg\s*\)$/i;

  function parseAngle(el) {
    var style = el.getAttribute('style') || '';
    if (!/will-change/i.test(style)) return null;
    var m = style.match(/transform:\s*([^;]+)/i);
    if (!m) return null;
    var rm = m[1].trim().match(rotateOnlyRe);
    if (!rm) return null;
    return parseFloat(rm[1]);
  }

  function findWheels() {
    var all = document.querySelectorAll('*');
    var wheels = [];
    for (var i = 0; i < all.length; i++) {
      var kids = all[i].children;
      if (kids.length < 3) continue;
      var angles = [];
      var ok = true;
      for (var k = 0; k < kids.length; k++) {
        var a = parseAngle(kids[k]);
        if (a === null) { ok = false; break; }
        angles.push(a);
      }
      if (!ok) continue;
      var deltas = [];
      for (var d = 1; d < angles.length; d++) deltas.push(angles[d] - angles[d - 1]);
      var avg = deltas.reduce(function (a, b) { return a + b; }, 0) / deltas.length;
      if (Math.abs(avg) < 1) continue;
      var consistent = deltas.every(function (delta) { return Math.abs(delta - avg) < 3; });
      if (consistent) wheels.push(Array.prototype.slice.call(kids));
    }
    return wheels;
  }

  function spin(badges) {
    var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return; // captured static angles are still a coherent (if non-animated) fan

    var current = badges.map(parseAngle);
    var lastTime = null;

    function frame(time) {
      if (lastTime === null) lastTime = time;
      var deltaSeconds = (time - lastTime) / 1000;
      lastTime = time;
      var step = DEGREES_PER_SECOND * deltaSeconds;
      for (var i = 0; i < badges.length; i++) {
        current[i] += step;
        badges[i].style.transform = 'rotate(' + current[i] + 'deg)';
      }
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  function init() {
    var wheels = findWheels();
    for (var i = 0; i < wheels.length; i++) spin(wheels[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
