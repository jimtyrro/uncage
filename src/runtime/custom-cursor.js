/**
 * uncage-runtime: custom-cursor
 *
 * SCOPED FALLBACK, not a faithful reproduction. Framer's `data-framer-
 * cursor` attribute takes two different shapes on real captures:
 *   1. A literal keyword ("pointer", "grab") -- already handled by plain
 *      CSS attribute selectors Framer itself ships
 *      ([data-framer-cursor=pointer]{cursor:pointer}), confirmed present
 *      in every captured stylesheet. Needs no JS at all.
 *   2. An opaque internal reference hash (e.g. "1yrl2kp" on arkitect's
 *      page-root wrapper, "xvuzte" on its individual link buttons) that
 *      doesn't correspond to anything else in the captured HTML or CSS --
 *      it's a lookup key into Framer's own component-config data,
 *      resolved entirely by Framer's JS at runtime into whatever bespoke
 *      cursor visual (a custom icon, a trailing dot, a magnetic hover
 *      effect) that specific project's designer configured. That
 *      configuration isn't present in the captured output in any
 *      reproducible form -- it's the same category of "opaque,
 *      proprietary, per-template" problem as a bespoke Framer code
 *      component, not something a generic marker-based reimplementation
 *      can faithfully reconstruct.
 *
 * Rather than fake an unknown visual (risking something that looks
 * actively wrong), this only guarantees the safe, always-correct
 * fallback: elements Framer marked cursor-interactive get a sensible
 * `cursor: pointer`, so hover affordance isn't silently lost even where
 * the original bespoke visual can't be reproduced.
 *
 * The acceptance-gate script (scripts/acceptance-gate.ts) caught a real
 * bug in this fallback: the opaque hash is sometimes carried by the
 * page's own root layout wrapper (Framer marks that element
 * `data-layout-template="true"`, confirmed on every capture that has
 * this pattern), not by a specific interactive widget. On arkitect that
 * root hash is almost certainly the site's page-wide custom-cursor
 * effect (hide the native cursor, render a tracking dot) -- setting
 * `cursor: pointer` there doesn't approximate that, it cascades
 * `pointer` onto every single descendant on the page via inheritance
 * (confirmed live: 352 elements picked up a spurious cursor change on
 * arkitect's homepage alone), making the entire page look clickable.
 * That's a worse, more visible regression than doing nothing, so the
 * root wrapper is explicitly skipped -- the fallback only fires for
 * actual small interactive elements (links, buttons), where "pointer"
 * is always a safe, correct affordance.
 */
(function () {
  'use strict';

  var els = document.querySelectorAll('[data-framer-cursor]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    // Page-root layout wrapper, not a real interactive element -- see
    // header comment. Skipping it stops "pointer" from cascading onto
    // every descendant on the page via CSS inheritance.
    if (el.getAttribute('data-layout-template') === 'true') continue;
    var value = el.getAttribute('data-framer-cursor') || '';
    // Literal CSS keywords are already handled by the page's own
    // captured stylesheet -- only patch the opaque-hash case, where
    // nothing else would otherwise set a cursor at all.
    if (value === 'pointer' || value === 'grab' || value === 'grabbing' || value === 'none') continue;
    if (getComputedStyle(el).cursor === 'auto') {
      el.style.cursor = 'pointer';
    }
  }
})();
