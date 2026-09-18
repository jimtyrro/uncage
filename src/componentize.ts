/**
 * Cross-page componentization: turns N flat pages (each carrying its own
 * full <html><head>...<body> boilerplate, copy-pasted nav/footer, etc.)
 * into a real Astro shape -- one shared Layout.astro plus extracted
 * components for whatever markup repeats verbatim across pages.
 *
 * Deliberately a separate module from astro.ts's per-page fixes (opacity
 * bake-in, orphaned-image safety net, JS stripping): those operate on ONE
 * page at a time and don't need to see the rest of the site. Everything
 * here is inherently cross-page -- "is this the same across every page" is
 * the whole question -- so it runs as its own pass over all pages at once,
 * after the per-page fixes have already settled each page's own markup.
 */
import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Head: known per-page SEO/meta tags, extracted as Layout props
// ---------------------------------------------------------------------------

export interface PageMetaProps {
  title: string;
  description: string | null;
  canonical: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogUrl: string | null;
  ogImage: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
}

/**
 * Pulls the well-known, near-universal SEO meta tags out of a page's
 * <head> and returns their values, REMOVING those nodes from $ in the
 * process. What's left in <head> after this is either genuine site-wide
 * boilerplate (favicons, charset, guard scripts, ...) or something
 * page-specific this function doesn't recognize -- computeHeadBoilerplate
 * below decides which.
 *
 * Scoped to tag+attribute PATTERNS (meta[property^="og:"], not a hardcoded
 * selector list) so this isn't tied to Framer's or Webflow's specific
 * attribute-ordering quirks (confirmed live: Framer writes
 * name="description" content="...", Webflow writes content="..."
 * name="description" -- same tag, different attribute order; matching by
 * pattern rather than exact selector handles both without special-casing
 * either platform).
 */
export function extractMetaProps($: cheerio.CheerioAPI): PageMetaProps {
  const titleEl = $('head > title').first();
  const title = titleEl.text();
  titleEl.remove();

  function pullMeta(selector: string): string | null {
    const el = $(selector).first();
    if (el.length === 0) return null;
    const value = el.attr('content') ?? null;
    el.remove();
    return value;
  }

  function pullLink(selector: string): string | null {
    const el = $(selector).first();
    if (el.length === 0) return null;
    const value = el.attr('href') ?? null;
    el.remove();
    return value;
  }

  const description = pullMeta('head > meta[name="description"]');
  const canonical = pullLink('head > link[rel="canonical"]');
  const ogTitle = pullMeta('head > meta[property="og:title"]');
  const ogDescription = pullMeta('head > meta[property="og:description"]');
  const ogUrl = pullMeta('head > meta[property="og:url"]');
  const ogImage = pullMeta('head > meta[property="og:image"]');
  const twitterTitle = pullMeta('head > meta[name="twitter:title"]');
  const twitterDescription = pullMeta('head > meta[name="twitter:description"]');

  return { title, description, canonical, ogTitle, ogDescription, ogUrl, ogImage, twitterTitle, twitterDescription };
}

/**
 * Normalizes head HTML for cross-page identity comparison -- strips the
 * specific per-page markers confirmed live to vary even on otherwise-
 * boilerplate content:
 *   - Webflow's <html data-wf-page="..."> (a page-specific internal id;
 *     harmless to drop outright since webflow.js, the only thing that ever
 *     read it, is already stripped elsewhere in this pipeline)
 *   - <html class="..."> token order (confirmed live on tripora: same SET
 *     of Webflow font-detection classes on every page, just appended in a
 *     different order depending on async font-load timing during the
 *     crawl -- sorted comparison treats that correctly as "the same")
 */
function normalizeHeadForComparison(html: string): string {
  let out = html.replace(/data-wf-page="[^"]*"\s*/g, '');
  out = out.replace(/(<html\b[^>]*\bclass=")([^"]*)(")/i, (_full, pre: string, classes: string, post: string) => {
    const sorted = classes.split(/\s+/).filter(Boolean).sort().join(' ');
    return pre + sorted + post;
  });
  return out;
}

export interface HeadBoilerplateResult {
  /** Static head HTML shared by every page, safe to hardcode into Layout.astro. Null if no page-independent boilerplate could be established (e.g. a single-page site). */
  boilerplate: string | null;
  /** Per-route leftover head content that didn't match the shared boilerplate (rare -- e.g. a one-off empty CSS-in-JS placeholder tag on a single page) and must stay in that page's own output via a head slot. */
  perPageExtra: Map<string, string>;
  /** The <html ...> opening tag's attributes, taken from whichever page had the most complete set (Webflow's data-wf-page varies per page and is dropped; everything else is expected constant). */
  htmlAttrs: string;
}

/**
 * Given every page's <head> with the known SEO/meta tags already pulled
 * out (extractMetaProps), determines what's left is genuinely shared
 * boilerplate vs. page-specific leftovers. Never silently drops content:
 * anything that doesn't match the majority pattern stays attached to its
 * own page instead of being assumed away.
 */
export function computeHeadBoilerplate(
  pages: Array<{ route: string; headInnerHtml: string; htmlAttrs: string }>,
): HeadBoilerplateResult {
  if (pages.length === 0) return { boilerplate: null, perPageExtra: new Map(), htmlAttrs: '' };

  const normalized = pages.map((p) => ({ route: p.route, norm: normalizeHeadForComparison(p.headInnerHtml), raw: p.headInnerHtml }));
  const counts = new Map<string, number>();
  for (const p of normalized) counts.set(p.norm, (counts.get(p.norm) || 0) + 1);

  // Majority vote: whichever exact (normalized) head content appears on
  // the most pages is the boilerplate. Only worth extracting into Layout
  // if it covers more than one page -- a single-page site has nothing to
  // share by definition.
  let bestNorm: string | null = null;
  let bestCount = 0;
  for (const [norm, count] of counts) {
    if (count > bestCount) {
      bestNorm = norm;
      bestCount = count;
    }
  }

  const perPageExtra = new Map<string, string>();
  if (!bestNorm || bestCount < 2) {
    for (const p of pages) perPageExtra.set(p.route, p.headInnerHtml);
    return { boilerplate: null, perPageExtra, htmlAttrs: pages[0]!.htmlAttrs };
  }

  // Representative raw (non-normalized) boilerplate text -- take it from
  // an actual page that matched, not the normalized string itself (which
  // has sorted classes / stripped attrs, not valid to emit verbatim).
  const boilerplate = normalized.find((p) => p.norm === bestNorm)!.raw;

  for (const p of normalized) {
    if (p.norm !== bestNorm) perPageExtra.set(p.route, p.raw);
  }

  // html tag attrs: prefer a page whose head matched the majority boilerplate.
  const repIdx = pages.findIndex((p) => normalizeHeadForComparison(p.headInnerHtml) === bestNorm);
  const htmlAttrs = pages[repIdx >= 0 ? repIdx : 0]!.htmlAttrs.replace(/\sdata-wf-page="[^"]*"/, '');

  return { boilerplate, perPageExtra, htmlAttrs };
}

// ---------------------------------------------------------------------------
// Body: markup blocks that repeat verbatim across pages (nav, footer, ...)
// ---------------------------------------------------------------------------

export interface ComponentCandidate {
  /** PascalCase component name, e.g. "Nav", "Footer", "Section1". */
  name: string;
  /** Raw HTML (from one representative page) used to generate the component file. */
  representativeHtml: string;
  /** Routes where this exact (post-normalization) block was found, each paired with the actual matched element in that page's own $ (for excising it and substituting a component reference). */
  occurrences: Array<{ route: string; el: any }>;
}

const CONTAINER_TAGS = new Set(['div', 'nav', 'footer', 'header', 'section', 'aside', 'ul']);

/**
 * Same per-page "active state" markers as the head/html normalization
 * above, but scoped to what shows up WITHIN nav/footer link lists
 * specifically -- confirmed live this session on both platforms:
 *   - Framer: data-framer-page-link-current="true" moves between whichever
 *     <a> matches the current route (confirmed identical pattern in both
 *     dermato's nav and arkitect's footer sitemap links).
 *   - Webflow: BOTH the .w--current class token AND a separate
 *     aria-current="page" attribute move between whichever <a> matches the
 *     current route (confirmed live on tripora -- Webflow emits both
 *     markers on the same link, not just the class).
 * Stripped before comparing so a block that's identical except for WHICH
 * link is marked active is still recognized as "the same component."
 *
 * Also normalizes native lazy-loading hints (loading="eager"/"lazy" on
 * <img>): confirmed live on tripora that otherwise-identical nav markup
 * can carry a different eager/lazy split per page (the crawler's own
 * above-the-fold detection at capture time, not a real content
 * difference) -- stripped rather than treated as a per-page prop since
 * it's a performance hint with no visible effect worth preserving
 * per-route fidelity for.
 */
function normalizeBodyBlockForComparison(html: string): string {
  let out = html.replace(/\sdata-framer-page-link-current="true"/g, '');
  // Webflow's own per-page form-tracking id (confirmed live on tripora's
  // newsletter subscribe form in the footer) -- same vestigial category
  // as <html data-wf-page>, dead now that webflow.js (the only thing that
  // ever read it) is already stripped elsewhere in this pipeline.
  out = out.replace(/\sdata-wf-page-id="[^"]*"/g, '');
  // Rebuild each class attribute's token list rather than regex-deleting
  // "w--current" in place -- deleting just the token left a stray space
  // behind whenever it was the last class (`"nav-link-item "` vs
  // `"nav-link-item"`), which broke exact-string comparison on every
  // OTHER link in the same nav even though none of them actually differ.
  // Confirmed live on tripora: this alone was why the whole nav failed to
  // match despite the real active-link marker already being stripped.
  out = out.replace(/class="([^"]*)"/g, (full: string, classes: string) => {
    if (!classes.includes('w--current')) return full;
    const kept = classes.split(/\s+/).filter((c) => c && c !== 'w--current').join(' ');
    return `class="${kept}"`;
  });
  out = out.replace(/\saria-current="page"/g, '');
  out = out.replace(/\sloading="(eager|lazy)"/g, '');
  out = out.replace(/\sclass=""/g, '');
  return out;
}

function candidateName($: cheerio.CheerioAPI, el: any, counter: { n: number }): string {
  const tag = ($(el).prop('tagName') as string | undefined)?.toLowerCase() ?? '';
  if (tag === 'nav') return 'Nav';
  if (tag === 'footer') return 'Footer';
  if (tag === 'header') return 'Header';
  const framerName = $(el).attr('data-framer-name');
  if (framerName) {
    const pascal = framerName.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
    if (pascal) return pascal;
  }
  const cls = ($(el).attr('class') || '').split(/\s+/).filter(Boolean)[0];
  if (cls) {
    const pascal = cls.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
    if (pascal) return pascal;
  }
  counter.n += 1;
  return `Section${counter.n}`;
}

/**
 * Finds markup blocks that appear, byte-identical after normalization,
 * across (nearly) every page of the site -- the actual "componentize"
 * step. Deliberately NOT scoped to specific tags/classes (confirmed live
 * this session: the same footer content shows up as a semantic <footer>
 * on arkitect but as a plain <div data-framer-name="Footer"> on
 * bakery-co) -- instead this looks at every container-ish element above a
 * minimum size and asks "does this exact content, allowing for known
 * active-link differences, exist on (nearly) every other page too."
 *
 * Tolerates the block being MISSING on up to one page (e.g. a landing
 * page with no header) rather than requiring literal 100% presence, but
 * requires at least 2 pages carrying it (nothing to share on a one-page
 * site) and at least `minPages` overall so a two-page site doesn't
 * "extract" something from a coincidental match.
 */
export function findSharedBodyComponents(pages: Array<{ route: string; $: cheerio.CheerioAPI }>): ComponentCandidate[] {
  if (pages.length < 2) return [];

  interface Occurrence {
    route: string;
    raw: string;
    norm: string;
    size: number;
    el: any;
  }
  const occurrences: Occurrence[] = [];

  for (const { route, $ } of pages) {
    $('body *').each((_, el) => {
      const tag = ($ as any)(el).prop('tagName')?.toLowerCase();
      if (!tag || !CONTAINER_TAGS.has(tag)) return;
      const raw = $.html(el as any);
      if (raw.length < 400) return; // skip trivially small elements
      const norm = normalizeBodyBlockForComparison(raw);
      occurrences.push({ route, raw, norm, size: raw.length, el });
    });
  }

  const totalPages = pages.length;
  // Percentage-based, not a flat "all but one" -- confirmed live on
  // tripora (50 pages): its real, genuinely shared footer is legitimately
  // absent on 2 pages (404, and one other special-layout page), not just
  // one, so a flat N-1 tolerance missed it entirely on a site this size.
  // 85% comfortably covers a handful of outlier pages on a large site
  // while still requiring true near-universal presence, not just "used on
  // a plurality of pages" (which would risk extracting something that's
  // actually two DIFFERENT variants that happen to coincide on barely
  // more than half the site).
  const minMatches = Math.max(2, Math.ceil(totalPages * 0.85));

  const byNorm = new Map<string, Occurrence[]>();
  for (const occ of occurrences) {
    const list = byNorm.get(occ.norm) ?? [];
    list.push(occ);
    byNorm.set(occ.norm, list);
  }

  const candidateGroups: { norm: string; occs: Occurrence[] }[] = [];
  for (const [norm, occs] of byNorm) {
    // Only count each route once even if the same block appears twice on
    // one page (e.g. a duplicated mobile+desktop nav).
    const routes = new Set(occs.map((o) => o.route));
    if (routes.size >= minMatches) candidateGroups.push({ norm, occs });
  }

  // Largest first: a footer's own byte-identical inner <ul> would also
  // technically qualify on its own, but once the footer itself is
  // selected the inner list is redundant to extract separately.
  candidateGroups.sort((a, b) => b.occs[0]!.size - a.occs[0]!.size);

  const accepted: { norm: string; occs: Occurrence[] }[] = [];
  for (const group of candidateGroups) {
    // Nesting check must compare occurrences from the SAME route -- an
    // already-accepted group's representative (occs[0]) may come from a
    // different page than this candidate's, and raw HTML from two
    // different pages won't substring-match even when the underlying
    // element genuinely is nested inside the other on every page that has
    // both. Confirmed live: without this, small sub-elements (a footer
    // sitemap column's own inner wrapper, ~1KB) kept surviving as separate
    // "candidates" alongside the already-larger footer they live inside,
    // because their first-found occurrence happened to come from a
    // different route than the footer's first-found occurrence.
    const nested = accepted.some((a) => {
      const commonRoute = group.occs.find((o) => a.occs.some((ao) => ao.route === o.route));
      if (!commonRoute) return false;
      const acceptedOnSameRoute = a.occs.find((ao) => ao.route === commonRoute.route)!;
      return acceptedOnSameRoute.raw.includes(commonRoute.raw);
    });
    if (nested) continue;
    accepted.push(group);
  }

  const counter = { n: 0 };
  const usedNames = new Map<string, number>();
  const results: ComponentCandidate[] = [];
  for (const group of accepted) {
    const rep = group.occs[0]!;
    const repPage = pages.find((p) => p.route === rep.route)!;
    let name = candidateName(repPage.$, rep.el, counter);
    // Disambiguate name collisions -- confirmed live: Framer commonly
    // names multiple, structurally different elements "Desktop" (one for
    // a desktop-breakpoint nav, another for a desktop-breakpoint footer
    // column), which would otherwise silently overwrite one component
    // file with another.
    const priorCount = usedNames.get(name) ?? 0;
    usedNames.set(name, priorCount + 1);
    if (priorCount > 0) name = `${name}${priorCount + 1}`;
    // One occurrence per unique route (first match if a page happens to
    // repeat the same block twice, e.g. a duplicated mobile+desktop nav
    // instance) -- each pairs the route with the actual element in THAT
    // page's own $, needed by the caller to excise it and splice in a
    // component reference.
    const seenRoutes = new Set<string>();
    const occurrences: Array<{ route: string; el: any }> = [];
    for (const occ of group.occs) {
      if (seenRoutes.has(occ.route)) continue;
      seenRoutes.add(occ.route);
      occurrences.push({ route: occ.route, el: occ.el });
    }
    results.push({ name, representativeHtml: rep.raw, occurrences });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Active-link templating: static "whichever page this was captured from"
// marker -> dynamic Astro expression driven by a currentPath prop
// ---------------------------------------------------------------------------

/**
 * An extracted component's representative HTML carries whichever link was
 * active on the ONE page it happened to be captured from (Framer's
 * data-framer-page-link-current="true", or Webflow's w--current class +
 * aria-current="page") baked in as a static attribute. Left alone, every
 * page using the shared component would show that SAME page's link
 * highlighted as active, not its own.
 *
 * Rewrites every internal link (href starting with "/") inside the
 * component to carry a dynamic Astro expression instead, driven by a
 * `currentPath` prop each page passes its own route into -- string-level,
 * not via cheerio DOM manipulation + re-serialization, since cheerio HTML-
 * encodes attribute values (quotes become &quot;) which would corrupt the
 * Astro expression syntax on write.
 *
 * Only touches markup that actually uses one of the two known active-link
 * conventions -- a no-op (returns the input unchanged) on a component with
 * neither, so this never invents an active-state affordance that wasn't
 * there in the capture.
 */
export function templateActiveLinks(html: string): string {
  const usesFramerMarker = /data-framer-page-link-current="true"/.test(html);
  const usesWebflowMarker = /\bw--current\b/.test(html) || /aria-current="page"/.test(html);
  if (!usesFramerMarker && !usesWebflowMarker) return html;

  return html.replace(/<a\s[^>]*href="(\/[^"]*)"[^>]*>/g, (tag: string, href: string) => {
    let out = tag;
    if (usesFramerMarker) {
      out = out.replace(/\sdata-framer-page-link-current="true"/, '');
      out = out.replace(/^<a\s/, `<a data-framer-page-link-current={currentPath === ${JSON.stringify(href)} ? "true" : undefined} `);
    }
    if (usesWebflowMarker) {
      out = out.replace(/\saria-current="page"/, '');
      out = out.replace(/^<a\s/, `<a aria-current={currentPath === ${JSON.stringify(href)} ? "page" : undefined} `);
      out = out.replace(/class="([^"]*)"/, (_full: string, classes: string) => {
        const kept = classes.split(/\s+/).filter((c) => c && c !== 'w--current').join(' ');
        return `class={\`${kept} \${currentPath === ${JSON.stringify(href)} ? "w--current" : ""}\`}`;
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// File generation: Layout.astro content from the extraction results above
// ---------------------------------------------------------------------------

/**
 * Builds the full content of src/layouts/Layout.astro from a
 * computeHeadBoilerplate result: the shared boilerplate verbatim, plus
 * the known SEO/meta tags re-inserted as prop-driven expressions (Astro's
 * `{value && <tag .../>}` conditional-render syntax skips the tag
 * entirely when a page didn't have that particular one, e.g. no og:image
 * -- rather than always emitting an empty attribute). Their exact
 * original interleaved position within <head> is lost once
 * extractMetaProps pulls them out for capture (order among these tags
 * never affects anything a browser or crawler cares about, so this
 * doesn't try to preserve it) -- appended together right before
 * </head>, with a `<slot name="head-extra" />` after them for the rare
 * page that had head content the majority-vote boilerplate didn't
 * recognize as shared (computeHeadBoilerplate's perPageExtra).
 */
export function buildLayoutFile(headResult: HeadBoilerplateResult): string {
  const boilerplate = headResult.boilerplate ?? '';
  return `---
export interface Props {
  title: string;
  description?: string | null;
  canonical?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogUrl?: string | null;
  ogImage?: string | null;
  twitterTitle?: string | null;
  twitterDescription?: string | null;
}
const {
  title,
  description = null,
  canonical = null,
  ogTitle = null,
  ogDescription = null,
  ogUrl = null,
  ogImage = null,
  twitterTitle = null,
  twitterDescription = null,
} = Astro.props as Props;
---
<html${headResult.htmlAttrs}>
<head>
${boilerplate}
<title>{title}</title>
{description && <meta name="description" content={description}>}
{canonical && <link rel="canonical" href={canonical}>}
{ogTitle && <meta property="og:title" content={ogTitle}>}
{ogDescription && <meta property="og:description" content={ogDescription}>}
{ogUrl && <meta property="og:url" content={ogUrl}>}
{ogImage && <meta property="og:image" content={ogImage}>}
{twitterTitle && <meta name="twitter:title" content={twitterTitle}>}
{twitterDescription && <meta name="twitter:description" content={twitterDescription}>}
<slot name="head-extra" />
</head>
<body>
<slot />
</body>
</html>
`;
}
