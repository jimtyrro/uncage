/**
 * uncage-runtime: scroll-pin
 *
 * The archiesta "What we do" pattern: a `position: sticky` section
 * containing several numbered panels (service 01, 02, 03...), where
 * scrolling through the section's own height crossfades between panels
 * instead of the browser just scrolling past them. `position: sticky`
 * itself is pure CSS and works with zero JS -- this module only adds the
 * panel-crossfade behavior on top of it.
 *
 * This is a best-effort GENERIC reproduction of the effect's shape (pin,
 * then step through panels as you scroll), not a pixel-identical clone of
 * any specific template's exact choreography (easing curves, precise
 * slide distances, counter-digit animation) -- astro.ts's opacity bake-in
 * pass already guarantees every panel is fully visible and correctly
 * laid out with zero JS, so this is additive polish, not something the
 * page's correctness depends on. Detection mirrors interactivity.ts:
 * finds `position: sticky` containers (parsed from real CSS rule text,
 * not a class-name guess) whose descendants carry the
 * will-change+transform JS-controlled signature.
 */
(function () {
  'use strict';

  function findStickyContainers() {
    var all = document.querySelectorAll('*');
    var containers = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (getComputedStyle(el).position !== 'sticky') continue;
      var animatedDescendant = el.querySelector('[style*="will-change"]');
      if (!animatedDescendant) continue;
      containers.push(el);
    }
    return containers;
  }

  function findPanels(container) {
    // Panels: direct children carrying the JS-controlled signature.
    // Falls back to all direct children if none match (still lets the
    // crossfade behavior degrade gracefully rather than doing nothing).
    var direct = Array.prototype.filter.call(container.children, function (c) {
      return /will-change/i.test(c.getAttribute('style') || '');
    });
    return direct.length >= 2 ? direct : Array.prototype.slice.call(container.children);
  }

  function setup(container) {
    var panels = findPanels(container);
    if (panels.length < 2) return;

    // The scrollable range this section occupies: `position: sticky`
    // only pins for as long as its PARENT is taller than the sticky
    // element itself -- that's the CSS mechanism that creates the
    // "scroll room" in the first place, confirmed live on archiesta's
    // own markup (a <section> wrapping the sticky panel, taller than
    // one viewport). Measuring the sticky element's OWN height instead
    // (an earlier version of this) is a bug: a sticky panel is normally
    // sized to ~one viewport itself, so `own height - viewport height`
    // is always ~0, and progress() would never advance past 0 no matter
    // how far the page actually scrolled through the section -- caught
    // by loading this against real synthetic markup, not just unit
    // logic, before this ever reached a real project.
    var scrollParent = container.parentElement || container;
    function progress() {
      var rect = scrollParent.getBoundingClientRect();
      var scrollable = rect.height - window.innerHeight;
      if (scrollable <= 0) return 0;
      var scrolled = -rect.top;
      return Math.max(0, Math.min(1, scrolled / scrollable));
    }

    function update() {
      var p = progress();
      var segment = 1 / panels.length;
      var t = 0.2; // crossfade transition width, as a fraction of one panel's own segment
      for (var i = 0; i < panels.length; i++) {
        var start = i * segment;
        var local = (p - start) / segment;
        var opacity;
        if (local < 0 || local > 1) {
          opacity = 0;
        } else if (local < t) {
          opacity = local / t; // crossfading in from the previous panel
        } else if (local > 1 - t) {
          opacity = (1 - local) / t; // crossfading out to the next panel
        } else {
          opacity = 1; // stable plateau -- this is the panel's own "on screen" segment
        }
        // Never fully hide a panel that has no other reveal mechanism --
        // floor at a low-but-present opacity rather than 0, so content
        // already confirmed correct by the bake-in pass is never made
        // to disappear entirely if this heuristic misjudges a boundary.
        panels[i].style.opacity = String(Math.max(0.15, opacity));
      }
    }

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  }

  function init() {
    var containers = findStickyContainers();
    for (var i = 0; i < containers.length; i++) setup(containers[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
