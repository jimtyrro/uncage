import type * as cheerio from 'cheerio';

/**
 * Widget archetypes uncage-runtime provides vanilla-JS replacements for.
 * Detection is intentionally conservative: false negatives just mean a
 * widget stays inert (same as any other un-reimplemented interaction)
 * rather than something breaking, whereas a false positive would inject
 * dead JS that tries to drive markup it doesn't actually match. Coverage
 * here is scoped to markers directly confirmed this session across the
 * real captured projects (dermato, bakery-co, arkitect-astro, tripora,
 * archiesta) -- Webflow's `w-*` component classes are stable and
 * officially documented, so detection there is reliable; Framer's own
 * classes are per-project content hashes with no stable name, so Framer
 * detection instead keys on the handful of markers that ARE stable:
 * `data-framer-cursor`, the `data-framer-components` library manifest
 * Framer itself emits, and `position: sticky` + JS-driven-transform
 * structural shape for the scroll-pin/header-hide/orbit patterns.
 * Extending coverage to a template not yet seen is expected to mean
 * adding a new marker here, not rewriting the mechanism.
 */
export type WidgetKind =
  | 'carousel'
  | 'nav-dropdown'
  | 'tabs'
  | 'custom-cursor'
  | 'entrance-reveal'
  | 'marquee'
  | 'scroll-pin'
  | 'header-hide'
  | 'orbit';

export interface WidgetDetection {
  kind: WidgetKind;
  /** Number of matching elements/signals found, for diagnostics and tests. */
  count: number;
}

export function detectWidgets($: cheerio.CheerioAPI, cssText = ''): WidgetDetection[] {
  const out: WidgetDetection[] = [];

  const push = (kind: WidgetKind, count: number) => {
    if (count > 0) out.push({ kind, count });
  };

  // --- carousel --------------------------------------------------------
  // Webflow: .w-slider is the component root, always paired with at least
  // one .w-slide child. Framer: no stable class, but Framer itself
  // declares which internal library components a page uses via
  // data-framer-components on <html> (confirmed live: dermato's single
  // slideshow instance showed up as literally "framer-slideshow-component"
  // in that attribute).
  const wSliders = $('.w-slider').length;
  const framerSlideshow = $('html[data-framer-components*="framer-slideshow-component"]').length > 0
    || $('[data-framer-components*="framer-slideshow-component"]').length;
  push('carousel', wSliders + (framerSlideshow ? 1 : 0));

  // --- nav-dropdown ------------------------------------------------------
  // Webflow's nav component: .w-nav is the bar, .w-nav-button the
  // hamburger toggle, .w-nav-menu the collapsible panel; .w-dropdown is
  // the separate, more general dropdown-menu component (not necessarily
  // navigation, e.g. a "resources" menu). Framer has no equivalent stable
  // class; detected here via an aria-labelled toggle control paired with
  // a nav landmark, the one structurally reliable cross-platform signal
  // (any accessible hamburger menu implementation needs a labeled control
  // to be usable at all).
  const wNavButtons = $('.w-nav-button').length;
  const wDropdowns = $('.w-dropdown').length;
  const ariaMenuToggles = $(
    'button[aria-label*="menu" i], button[aria-label*="toggle" i], [aria-haspopup="true"]'
  ).length;
  push('nav-dropdown', wNavButtons + wDropdowns + ariaMenuToggles);

  // --- tabs --------------------------------------------------------------
  // Webflow: .w-tab-link triggers, .w-tab-pane content panels. Cross-
  // platform: proper ARIA tablist markup, when present, is unambiguous.
  const wTabs = $('.w-tab-link').length;
  const ariaTabs = $('[role="tab"]').length;
  push('tabs', wTabs + ariaTabs);

  // --- custom-cursor -------------------------------------------------------
  // Framer's own marker for an element with a custom hover cursor
  // (confirmed live: 282 occurrences across the three Framer captures).
  push('custom-cursor', $('[data-framer-cursor]').length);

  // --- entrance-reveal -----------------------------------------------------
  // Elements the opacity bake-in pass (astro.ts) had to touch are exactly
  // the ones that need a *replacement* reveal-on-scroll effect once
  // Framer/Webflow's own JS is gone -- otherwise baking opacity:1
  // statically means content that was meant to animate in on scroll
  // instead just appears instantly, fully visible, on page load. Uses the
  // identical detection condition as that pass so the two stay in sync:
  // opacity exactly 0, or partial opacity alongside `will-change`.
  let revealCount = 0;
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const m = style.match(/opacity:\s*([\d.]+)/);
    if (!m) return;
    const value = parseFloat(m[1]!);
    if (value >= 1) return;
    if (value === 0 || style.includes('will-change')) revealCount++;
  });
  push('entrance-reveal', revealCount);

  // --- marquee -------------------------------------------------------------
  // No stock component on either platform -- always custom-built. The one
  // structurally reliable signal for a seamless-loop marquee: a
  // horizontally-scrolling container whose immediate children repeat the
  // same content TWICE in a row (the standard technique for a gapless
  // loop -- animate -50% then reset, so the visual seam is never visible).
  // Detected by hashing each child's own text/image content and checking
  // for an exact adjacent repeat of the full child sequence.
  //
  // Signature must include actual identifying content (text, or an <img>
  // src/alt), not just the class attribute, and the combined signature
  // across all children must clear a minimum length -- confirmed a naive
  // class-only signature false-matches tripora's `.footer-social-inline`
  // (four icon-only links, empty text, so both "halves" trivially matched
  // as all-blank strings; not a marquee, just a row of social icons).
  let marqueeCount = 0;
  $('*').each((_, el) => {
    const kids = $(el).children().toArray();
    if (kids.length < 4 || kids.length % 2 !== 0) return;
    const half = kids.length / 2;
    const sig = (node: any) => {
      const $node = $(node);
      const img = $node.is('img') ? $node : $node.find('img').first();
      const imgSig = img.length ? `${img.attr('src') || ''}|${img.attr('alt') || ''}` : '';
      return `${$node.text().trim()}|${imgSig}`;
    };
    const firstSigs = kids.slice(0, half).map(sig);
    const secondSigs = kids.slice(half).map(sig);
    const firstHalf = firstSigs.join(',');
    const secondHalf = secondSigs.join(',');
    const contentLength = firstSigs.join('').replace(/\|/g, '').trim().length;
    if (contentLength >= 12 && firstHalf === secondHalf) marqueeCount++;
  });
  push('marquee', marqueeCount);

  // --- scroll-pin ----------------------------------------------------------
  // The archiesta "What we do" pattern: a `position: sticky` wrapper
  // whose children get scroll-scrubbed transforms. Confirmed live this is
  // authored as a genuine CSS rule, not an inline style -- and confirmed
  // the class NAME is not a reliable signal either: one real capture used
  // a semantic name (`.service-one-service-wrapper`), another instance of
  // the same site used a generic utility class (`.position-sticky`). The
  // only thing actually reliable is the CSS property itself, so this
  // parses the real stylesheet text for rules containing
  // `position: sticky` and checks whether the matching selector has any
  // element in this page's DOM. cssText is the same per-page style-block
  // text astro.ts's Pass 1 already extracts (plus any external
  // stylesheets the caller concatenates in -- Webflow templates in
  // particular keep utility classes like `.position-sticky` in an
  // external CSS file, not inline, confirmed on archiesta), passed in
  // here before those blocks are pulled out of the page.
  //
  // Plain `position: sticky` alone is NOT enough: it's also the standard,
  // pure-CSS way to build a sticky navbar/header, confirmed matching on
  // dermato (a dermatology clinic site with no scroll-scrubbed sections
  // at all) -- a sticky navbar needs zero JS and would be a pure false
  // positive here. The differentiator: archiesta's real pattern has
  // descendant elements INSIDE the sticky container carrying JS-driven
  // transform styling (the panels being scrubbed); a plain sticky navbar
  // doesn't. Reuses the same will-change/animated-opacity signal as
  // entrance-reveal, scoped to descendants of the sticky element.
  let scrollPinCount = 0;
  const stickyRuleRe = /([^{}]+)\{[^{}]*position:\s*sticky[^{}]*\}/gi;
  for (const m of cssText.matchAll(stickyRuleRe)) {
    const selectorList = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    for (const selector of selectorList) {
      // Skip at-rules (@media, @supports, ...) and anything cheerio's
      // selector engine can't parse (pseudo-elements, etc.) -- a
      // selector this can't evaluate just doesn't count toward
      // detection, it doesn't fail the page.
      if (selector.startsWith('@')) continue;
      let matches;
      try {
        matches = $(selector);
      } catch {
        continue;
      }
      matches.each((_, el) => {
        const hasAnimatedDescendant = $(el)
          .find('[style]')
          .toArray()
          .some((child) => {
            const style = $(child).attr('style') || '';
            return style.includes('will-change') && /transform:\s*(?!none)/i.test(style);
          });
        if (hasAnimatedDescendant) scrollPinCount++;
      });
    }
  }
  push('scroll-pin', scrollPinCount);

  // --- header-hide -----------------------------------------------------
  // A sticky nav/header (`position: sticky`, parsed the same way as
  // scroll-pin, reusing stickyRuleRe) that carries `will-change:
  // transform` on the STICKY ELEMENT ITSELF -- not a descendant, which is
  // scroll-pin's signal instead. Confirmed live on dermato: the real site
  // hides this header via a JS scroll listener that continuously writes
  // a translateY onto exactly this element (direction-aware: hides
  // scrolling down past a small threshold, reveals scrolling back up).
  // `will-change: transform` on the container itself is the one marker
  // of that JS control that survives the crawler's scroll-then-reset-to-
  // 0 capture -- the actual translateY value doesn't (it's always back
  // at "shown" once scroll resets to 0), which is exactly why this
  // needs a real runtime replacement rather than baking the captured
  // value: there's only ever one static value to bake, and it's the
  // "shown" one, permanently. Confirmed NOT present on the three other
  // real captures with sticky headers (arkitect, bakery-co, tripora) --
  // a plain always-visible sticky header authored in pure CSS has no
  // reason to declare `will-change: transform` on itself, so this stays
  // a non-firing signal on sites that genuinely want the header to never
  // hide. Scoped to containing (or being) a real <header>/<nav> landmark
  // so it can't collide with some unrelated sticky+will-change element.
  let headerHideCount = 0;
  const stickyRuleRe2 = /([^{}]+)\{[^{}]*position:\s*sticky[^{}]*\}/gi;
  for (const m of cssText.matchAll(stickyRuleRe2)) {
    const selectorList = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    for (const selector of selectorList) {
      if (selector.startsWith('@')) continue;
      let matches;
      try {
        matches = $(selector);
      } catch {
        continue;
      }
      matches.each((_, el) => {
        const style = $(el).attr('style') || '';
        if (!style.includes('will-change') || !/transform/i.test(style)) return;
        const $el = $(el);
        if (!$el.is('header, nav') && $el.find('header, nav').length === 0) return;
        headerHideCount++;
      });
    }
  }
  push('header-hide', headerHideCount);

  // --- orbit -----------------------------------------------------------
  // A "wheel" of evenly-spaced badges/tags continuously rotating around
  // a shared pivot (confirmed live: dermato's hero, 8 service-name
  // badges arranged in a fan, each independently JS-updated every
  // frame). Structurally distinct from entrance-reveal (opacity 0->1,
  // fires once and stays) and marquee (translate, not rotate): this is a
  // *rotation*-only, continuously-running animation with no natural
  // "settled" static value to bake -- the crawler's scroll-then-reset
  // capture just freezes whatever angle each badge happened to be at
  // that instant, which is why only one badge ends up visible/legible
  // without this widget. Detection: >=3 sibling elements, each
  // individually carrying `will-change: transform` plus a *single*
  // `rotate(Ndeg)` transform (nothing else mixed in), whose DOM-order
  // angle deltas are consistent within a small tolerance -- the one
  // structurally reliable signature of "evenly spaced around a wheel"
  // that's unlikely to occur by coincidence on unrelated content.
  let orbitCount = 0;
  const rotateOnlyRe = /^rotate\(\s*(-?[\d.]+)deg\s*\)$/i;
  $('*').each((_, el) => {
    const kids = $(el).children().toArray();
    if (kids.length < 3) return;
    const angles: number[] = [];
    for (const kid of kids) {
      const style = $(kid).attr('style') || '';
      if (!style.includes('will-change')) return;
      const tm = style.match(/transform:\s*([^;]+)/i);
      if (!tm) return;
      const rm = tm[1]!.trim().match(rotateOnlyRe);
      if (!rm) return;
      angles.push(parseFloat(rm[1]!));
    }
    const deltas: number[] = [];
    for (let i = 1; i < angles.length; i++) deltas.push(angles[i]! - angles[i - 1]!);
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (Math.abs(avg) < 1) return; // near-zero spacing isn't a wheel, just coincidentally-similar angles
    const consistent = deltas.every((d) => Math.abs(d - avg) < 3);
    if (consistent) orbitCount++;
  });
  push('orbit', orbitCount);

  return out;
}
