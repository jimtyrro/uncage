import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import type { ExporterStrategy } from '../types.js';
import { detectWidgets, type WidgetKind } from '../interactivity.js';

// Resolved relative to this file's own location (not process.cwd(), which
// depends on where the CLI happened to be invoked from) so the vanilla-JS
// widget replacements in src/runtime/ can be found and copied into any
// output project regardless of invocation directory.
const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime');

export function routeToAstroFilename(route: string): string {
  if (!route || route === '/' || route === '/index') return 'index.astro';
  let clean = route.replace(/^\//, '').replace(/\/$/, '').trim();
  clean = clean.replace(/\.html$/i, '');
  clean = clean.replace(/[^a-zA-Z0-9_/-]+/g, '-');
  return `${clean}.astro`;
}

/**
 * Framer's own "More Templates / Use for Free" marketplace cross-sell card is
 * a live component in the page's React tree, not just static markup — it gets
 * re-created by client-side hydration even when deleted from the server HTML.
 * Its wrapper element has no stable id/class (the class is a per-template
 * content hash), so we detect it structurally: find the marketplace-listing
 * anchors (framer.com/@<author>/?tab=marketplace, or
 * framer.com/community/marketplace/templates/*, or the framer.link/<slug>
 * short-domain form some newer templates use for the same "Get it for FREE"
 * widget — confirmed live: a template whose card linked to
 * framer.link/Dermato went undetected under the framer.com-only patterns,
 * so the widget rendered on every page uncaught by either the static removal
 * or the runtime guard) and take the nearest common ancestor's first class
 * as the identity selector to neutralize.
 *
 * The href match must stay narrow: some templates also carry an unrelated
 * "design credit" link to framer.com/marketplace/creator/<author> elsewhere
 * on the page (e.g. a project detail page's attribution footer). A looser
 * match that also caught that link computed a "common ancestor" all the way
 * up at the page's own root wrapper — and the resulting guard script then
 * deleted the entire page on every hydration. `isLayoutRoot` is a second,
 * independent safety net against exactly that failure mode, and applies
 * regardless of which anchor pattern matched.
 */
function isLayoutRoot($: cheerio.CheerioAPI, el: any): boolean {
  const node = $(el);
  if (node.is('body') || node.is('html')) return true;
  if (node.attr('data-layout-template') != null) return true;
  if (node.attr('id') === 'main') return true;
  return false;
}

function detectPromoWidgetClass($: cheerio.CheerioAPI): string | null {
  const anchors = $('a[href*="framer.com"], a[href*="framer.link"]').filter((_, el) => {
    const href = $(el).attr('href') || '';
    return /framer\.com\/@[^/"']+\/\?tab=marketplace/i.test(href) ||
      /framer\.com\/community\/marketplace\/templates\//i.test(href) ||
      /^https?:\/\/framer\.link\//i.test(href);
  });
  if (anchors.length === 0) return null;

  function ancestorChain(el: any): any[] {
    const chain: any[] = [];
    let cur = $(el);
    while (cur.length) {
      chain.push(cur.get(0));
      cur = cur.parent();
    }
    return chain;
  }

  let common = ancestorChain(anchors.get(0));
  anchors.each((i, el) => {
    if (i === 0) return;
    const otherSet = new Set(ancestorChain(el));
    common = common.filter((node) => otherSet.has(node));
  });

  const target = common[0];
  if (!target) return null;
  if (isLayoutRoot($, target)) return null;
  const classAttr = $(target as any).attr('class') || '';
  return classAttr.split(/\s+/).filter(Boolean)[0] || null;
}

export const astroStrategy: ExporterStrategy = {
  name: 'Astro',
  format: 'astro',
  description: 'Astro static site — multi-page .astro output, zero client-side framework required',

  async compile(outputDir: string, pages: Record<string, string>): Promise<void> {
    console.log('  [Compiler] Compiling Astro pages...');

    const pagesDir = path.join(outputDir, 'src', 'pages');

    // --- Pass 1: per-page DOM cleanup + style-block extraction ------------
    // Framer inlines every page's CSS as several <style> tags (60-78% of a
    // captured page's bytes, confirmed by measurement) that are near-
    // identical across pages -- one page's font-face block, SSR-minified
    // component CSS, etc. are byte-for-byte the same as every other page's.
    // Pulling them out here (before serializing to a per-page HTML string)
    // and content-hashing across ALL pages lets identical blocks collapse
    // to a single shared file instead of shipping full text on every page.
    const perPage: Array<{ route: string; filename: string; $: cheerio.CheerioAPI; promoClass: string | null; styleTexts: string[]; widgets: WidgetKind[] }> = [];

    // Detection needs the page's real CSS to check for things like
    // scroll-pin's `position: sticky` rule, which Webflow templates often
    // author in an EXTERNAL stylesheet rather than an inline <style> tag
    // (confirmed live on archiesta -- read once here since it's the same
    // site-wide file set for every page, not worth re-reading per page).
    let externalCss = '';
    try {
      const cssDir = path.join(outputDir, 'public', 'assets', 'css');
      const cssFiles = await fs.readdir(cssDir);
      for (const f of cssFiles) {
        if (f.endsWith('.css')) externalCss += (await fs.readFile(path.join(cssDir, f), 'utf-8')) + '\n';
      }
    } catch {
      // No external CSS directory (e.g. a pure-Framer capture with
      // everything inlined) -- fine, detection just runs on inline
      // <style> text alone in that case.
    }

    for (const [route, htmlContent] of Object.entries(pages)) {
      const filename = routeToAstroFilename(route);
      const $ = cheerio.load(htmlContent);

      // Framer's own attribution/telemetry chrome baked into every export.
      // Safe to remove outright — none of these get re-created by hydration.
      // #__framer-editorbar-container is the floating "Edit Content" pencil
      // trigger button — a separate element from the #__framer-editorbar
      // iframe/panel it opens, confirmed missing from this list live (the
      // panel was correctly gone, but the trigger button that opens it kept
      // showing up bottom-right on every page).
      $('#__framer-editorbar').remove();
      $('#__framer-editorbar-container').remove();
      $('#__framer-badge-container').remove();
      $('script[data-fid]').remove();

      // Same stale-SRI-hash bug as html.ts: integrity is computed against
      // the original remote file's bytes, not our local capture - once
      // href/src is rewritten, the browser silently drops the resource
      // (missing from document.styleSheets/never executes, no console
      // error). Confirmed live on a Webflow capture: this alone was why
      // the whole page rendered unstyled with jQuery/Webflow's own
      // interaction JS never running.
      $('link[integrity], script[integrity]').each((_, el) => {
        const url = $(el).attr('href') || $(el).attr('src') || '';
        if (url.includes('assets/')) {
          $(el).removeAttr('integrity');
          $(el).removeAttr('crossorigin');
        }
      });

      const promoClass = detectPromoWidgetClass($);

      // Pull <style> blocks out for cross-page extraction. Left in place
      // (and handled by the existing is:global string-replace below) if
      // empty — a handful of Framer's own <style data-framer-css> tags ship
      // with zero content, not worth a file + import for nothing. Webflow
      // captures, which already externalize almost all their CSS via
      // <link>, naturally fall through this loop finding zero or
      // near-nothing to extract — no special-case needed, the content-hash
      // pipeline below is a no-op when there's nothing to hash.
      const styleTexts: string[] = [];
      $('style').each((_, el) => {
        const text = $(el).text();
        if (!text.trim()) return;
        styleTexts.push(text);
        $(el).remove();
      });

      // Which uncage-runtime widget modules this specific page needs --
      // run before the opacity bake-in below so detection sees the
      // original will-change/opacity signature (the bake-in only changes
      // the opacity VALUE, not whether will-change is present, so order
      // doesn't actually change the result, but keeping detection ahead
      // of any further DOM mutation keeps this unambiguous). cssText
      // combines the site-wide external stylesheets with this page's own
      // (now-extracted) inline blocks, matching what interactivity.ts's
      // own verification against real captures required for accurate
      // scroll-pin detection.
      const widgets = detectWidgets($, externalCss + styleTexts.join('\n')).map((w) => w.kind);

      perPage.push({ route, filename, $, promoClass, styleTexts, widgets });
    }

    // --- Pass 2: content-addressed dedup across all pages -----------------
    // One file per distinct byte-for-byte CSS text, named by content hash
    // (identical text anywhere becomes the identical file, regardless of
    // which page or which ordinal <style> position it came from). Folder
    // placement (global/shared/pages) is purely organizational — the
    // per-page frontmatter import list below always follows that page's
    // own original tag order, so cascade order is preserved per page even
    // though a chunk shared by two pages might sit at different ordinal
    // positions in each of them.
    const styleFiles = new Map<string, { relPath: string; content: string }>(); // hash -> file
    const hashOf = (text: string) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
    const usageCount = new Map<string, number>(); // hash -> how many pages use it

    for (const p of perPage) {
      const seen = new Set<string>();
      for (const text of p.styleTexts) {
        const hash = hashOf(text);
        if (seen.has(hash)) continue; // same page repeating the same block only counts once
        seen.add(hash);
        usageCount.set(hash, (usageCount.get(hash) || 0) + 1);
        if (!styleFiles.has(hash)) styleFiles.set(hash, { relPath: '', content: text });
      }
    }

    const totalPages = perPage.length;
    const routeSlug = (route: string) => routeToAstroFilename(route).replace(/\.astro$/, '');
    for (const [hash, file] of styleFiles) {
      const count = usageCount.get(hash) || 0;
      if (count === totalPages && totalPages > 1) {
        file.relPath = `styles/global/${hash}.css`;
      } else if (count >= 2) {
        file.relPath = `styles/shared/${hash}.css`;
      } else {
        // Exactly one page uses it — file the page(s) that use it under.
        const owner = perPage.find((p) => p.styleTexts.some((t) => hashOf(t) === hash));
        const slug = owner ? routeSlug(owner.route) : 'misc';
        file.relPath = `styles/pages/${slug}/${hash}.css`;
      }
    }

    for (const file of styleFiles.values()) {
      const fullPath = path.join(outputDir, 'src', file.relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, file.content, 'utf-8');
    }
    if (styleFiles.size > 0) {
      const globalCount = [...styleFiles.values()].filter((f) => f.relPath.startsWith('styles/global/')).length;
      const sharedCount = [...styleFiles.values()].filter((f) => f.relPath.startsWith('styles/shared/')).length;
      const pageCount = styleFiles.size - globalCount - sharedCount;
      console.log(`        Extracted ${styleFiles.size} CSS file(s): ${globalCount} global, ${sharedCount} shared, ${pageCount} page-specific`);
    }

    // Copy only the uncage-runtime widget modules actually needed
    // (union across every page, so a site with no carousels anywhere
    // never ships carousel.js) into a shared location every page can
    // reference by a stable path, then hash the whole batch once for a
    // long-lived cache-busting query string -- these rarely change
    // between builds, so worth caching hard across page navigations.
    const neededWidgets = new Set<WidgetKind>();
    for (const p of perPage) for (const w of p.widgets) neededWidgets.add(w);
    if (neededWidgets.size > 0) {
      const runtimeOutDir = path.join(outputDir, 'public', 'assets', 'js', 'uncage-runtime');
      await fs.mkdir(runtimeOutDir, { recursive: true });
      for (const kind of neededWidgets) {
        await fs.copyFile(path.join(RUNTIME_DIR, `${kind}.js`), path.join(runtimeOutDir, `${kind}.js`));
      }
      console.log(`        Copied ${neededWidgets.size} uncage-runtime widget module(s): ${[...neededWidgets].join(', ')}`);
    }

    // --- Pass 3: finish each page -------------------------------------
    for (const p of perPage) {
      const { route, filename, $, promoClass, styleTexts, widgets } = p;

      // Step 2 of the broader "drop hydration" plan: bake the settled,
      // fully-revealed state into the static markup itself, rather than
      // relying on Framer/Webflow's own JS to un-hide it after load. Scope
      // is deliberately narrow here -- opacity only, not transform. Opacity
      // on a JS-controlled element is unambiguous: it always means
      // "revealed vs. still hidden," never a legitimate permanent design
      // choice (a real semi-transparent overlay is styled via a CSS rule).
      // Transform is genuinely ambiguous on the same elements -- it can
      // mean "hasn't slid into place yet" (safe to zero out) or "mid-way
      // through a deliberate, ongoing scroll-linked effect" (zeroing it
      // would be wrong) -- so that gets resolved per-widget by the
      // runtime modules being added alongside this, not guessed at here.
      //
      // Detection is NOT scoped to GSAP's `translate: none` signature --
      // checked against real captures (arkitect, dermato, bakery-co) and
      // found zero matches for it there. GSAP is a Webflow-template
      // pattern; Framer's own component runtime (Framer Motion) writes a
      // structurally different inline style with no shared marker, and it
      // was exactly the element responsible for arkitect's dark-screen
      // bug (a full-screen page-transition overlay frozen at opacity:0)
      // that the GSAP-only version of this check missed entirely.
      //
      // Instead: target inline `opacity` that is either (a) exactly 0, or
      // (b) partial AND accompanied by `will-change` in the same style
      // attribute (a CSS hint browsers only get when JS is about to
      // animate that property -- never present on authored CSS). Verified
      // against 589 real inline-opacity<1 elements across the three local
      // Framer captures before committing to this shape: elements matching
      // (a) or (b) were, on manual sampling, uniformly Framer's own
      // entrance-reveal pattern (`will-change:transform;opacity:0;
      // transform:translateY(...) scale(...)`, including a genuine footer
      // "Quick Links" section correctly caught despite an unrelated
      // "Menu"-named ancestor) or the near-1 tail of an animation mid-
      // settle at crawl time (opacity values like 0.989551, imperceptible
      // either way). Elements at low-but-clearly-intentional opacity with
      // NEITHER signal -- e.g. arkitect's `.overlay`/`.desktop-overlay`
      // background tints, hand-authored at a stable 0.1/0.2, no
      // will-change, same value repeated identically every occurrence --
      // were correctly excluded; forcing those to opacity:1 would turn a
      // subtle tint into a solid block.
      $('[style]').each((_, el) => {
        const style = $(el).attr('style') || '';
        const m = style.match(/opacity:\s*([\d.]+)/);
        if (!m) return;
        const value = parseFloat(m[1]!);
        if (value >= 1) return;
        const looksAnimated = value === 0 || style.includes('will-change');
        if (!looksAnimated) return;
        const updated = style.replace(/opacity:\s*([\d.]+)(;?)/, (full, _val: string, term: string) => `opacity: 1${term}`);
        if (updated !== style) $(el).attr('style', updated);
      });

      let html = '<!DOCTYPE html>\n' + $.html();

      // Astro's template language treats a bare `{` in HTML body content as
      // the start of a JS expression (same rule as JSX) -- so any captured
      // page whose actual content happens to contain literal curly braces
      // (a code sample shown as text, a "use the {variable} placeholder"
      // sentence, anything like that) makes the Astro compiler try to parse
      // whatever follows as JavaScript and fail with a bare "Unexpected
      // token", pointing at some mid-page line that looks nothing like the
      // real problem. Confirmed live: a Webflow template's own "how to
      // integrate Lenis smooth scroll" documentation page, showing example
      // init code (`new Lenis({...})`) as syntax-highlighted text, broke
      // the whole build over one `{` in that displayed sample -- not
      // anything specific to Lenis or that template, this hits any
      // captured page with visible curly-brace content.
      //
      // Fixed by escaping to numeric HTML entities, which render
      // identically in the browser and don't trip Astro's expression
      // parser -- but done here as a string-level pass over the already-
      // serialized HTML, split around <script>/<style> blocks (which,
      // unlike arbitrary divs, never nest, so a non-greedy tag-to-matching-
      // close-tag split is reliable). An earlier attempt escaped text nodes
      // in the cheerio DOM directly, but cheerio's own serializer re-
      // escapes the literal `&` that introduces each entity when it writes
      // `$.html()`, turning `&#123;` into `&amp;#123;` -- which a browser
      // renders as the literal text "&#123;", not "{". Those two tags carry
      // real, unescaped JS/CSS (Astro treats their contents as raw via
      // is:inline/is:global below), so escaping braces there would corrupt
      // the very scripts/styles this format depends on.
      html = html
        .split(/(<script[^>]*>[\s\S]*?<\/script>|<style[^>]*>[\s\S]*?<\/style>)/i)
        .map((segment) => {
          if (/^<(script|style)/i.test(segment)) return segment;
          return segment.replace(/{/g, '&#123;').replace(/}/g, '&#125;');
        })
        .join('');

      // Astro auto-scopes <style> and auto-bundles <script> tags by default
      // (rewriting selectors with a data-astro-cid-* attribute, splitting
      // scripts into separately-fetched ES modules). Both silently break
      // this vendored markup: scoping strips most of Framer's generated CSS
      // (the scoping attribute doesn't land on every element the selectors
      // target), and script bundling turns synchronous inline bootstrap
      // scripts into deferred modules. is:global / is:inline disable both,
      // shipping every tag exactly as captured. Only applies to whatever
      // <style> tags Pass 1 left in place (empty ones) — every non-empty
      // block was already pulled out and replaced with a frontmatter
      // import below.
      html = html.replace(/<style(?=[ >])/g, '<style is:global');
      html = html.replace(/<script(?=[ >])/g, '<script is:inline');

      // Neutralize hydration-resistant widgets (Framer's marketplace
      // cross-sell card, edit-bar iframe, and attribution badge; Webflow's
      // own "Made in Webflow" badge) with a small guard script rather than
      // trying to delete them from the markup: all of these get
      // unconditionally re-created by client-side JS on every page load
      // regardless of what ships in the server HTML. Confirmed live on two
      // separate platforms: a static #remove() deletes #__framer-editorbar
      // from the served Framer markup, but its own runtime re-inserts it as
      // a hidden iframe within a few hundred ms; .w-webflow-badge isn't even
      // present in Webflow's captured static HTML at all - webflow.js
      // injects it fresh at runtime, so there's nothing to statically
      // remove in the first place. Harmless no-op on sites from neither
      // platform - the observer just never finds a match.
      const guardTargets = [
        promoClass ? `.${promoClass}` : null,
        '[data-framercommerce-widget]',
        '#__framer-editorbar',
        '#__framer-editorbar-container',
        '#__framer-badge-container',
        '.w-webflow-badge',
      ].filter(Boolean) as string[];
      if (guardTargets.length > 0) {
        const selector = JSON.stringify(guardTargets.join(','));
        const guardScript = `<script is:inline>(function(){function h(el){el.remove()}function scan(){document.querySelectorAll(${selector}).forEach(h)}scan();new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true})})();</script>`;
        html = html.replace('<head>', '<head>' + guardScript);
      }

      // GSAP-driven reveal animations (common in Webflow templates using
      // ScrollTrigger/IntersectionObserver-style "fade+slide up" entrance
      // effects) can get permanently stuck at their pre-reveal transform on
      // content that starts inside a hidden container -- e.g. a second tab
      // pane (display:none until clicked) whose items are never in the
      // viewport at animation-setup time. Confirmed live on a Webflow
      // template's "Sold" properties tab: the original site settles every
      // item's inline style to plain `translate3d(0px, 0px, 0px)` once its
      // reveal completes, but on the captured export, some items keep a
      // leftover `translate(0%, -50%)` term permanently stacked in front of
      // an otherwise-settled translate3d -- offsetting the element by half
      // its own height and clipping its top out of view. Deterministic
      // (same items every reload) and never self-corrects, even after a
      // long wait or a manual ScrollTrigger.refresh() -- something about
      // the export's load timing leaves those specific elements' reveal
      // permanently short of its final step, and nothing here can fix
      // Webflow's own bundled JS logic that got stuck.
      //
      // Patched with a narrowly-scoped runtime guard instead: watch for
      // style-attribute mutations (GSAP rewrites `style` on every animation
      // frame) and, the moment an element's inline style shows GSAP's own
      // `translate: none; rotate: none; scale: none;` marker (the CSS
      // Individual Transform Properties reset GSAP's CSSPlugin always
      // writes when it controls an element -- never present on a plain
      // CSS-authored transform, so this can't misfire on something like a
      // legitimate `.w-lightbox-tall`-style centering trick) together with
      // opacity:1 and a translate3d term already within 2px of zero (i.e.
      // the reveal has clearly finished, bar this one leftover term), strip
      // the stray percentage-based translate() and keep only the settled
      // translate3d. Firing exactly when that condition first becomes true
      // means a correctly-animating element is never touched mid-flight --
      // by definition its transform only reaches that combination once,
      // right when it would have settled on its own anyway.
      const stuckTransformGuard = `<script is:inline>(function(){function fix(el){var s=el.getAttribute('style')||'';if(s.indexOf('translate: none')===-1)return;if(s.indexOf('opacity: 1')===-1)return;var m=s.match(/transform:\\s*translate\\([\\d.]+%,\\s*-?[\\d.]+%\\)\\s*(translate3d\\([^)]*\\))/);if(!m)return;var c=m[1].match(/translate3d\\(([-\\d.]+)px,\\s*([-\\d.]+)px,\\s*([-\\d.]+)px\\)/);if(!c)return;if(Math.abs(parseFloat(c[1]))>2||Math.abs(parseFloat(c[2]))>2)return;el.style.transform=m[1]}function scan(){document.querySelectorAll('[style*="translate: none"]').forEach(fix)}scan();new MutationObserver(function(records){records.forEach(function(r){if(r.target.nodeType===1)fix(r.target)})}).observe(document.documentElement,{attributes:true,attributeFilter:['style'],subtree:true})})();</script>`;
      html = html.replace('<head>', '<head>' + stuckTransformGuard);

      // Remove Framer/Webflow's own hydration JS now that uncage-runtime
      // covers the interactive widgets it drove and the opacity bake-in
      // pass above covers the static-correctness half of what it did --
      // this is the actual "drop hydration" step the rest of Step 2
      // built toward. Framer's own crawls, jQuery, and every genuinely
      // third-party library the page independently depends on (GSAP,
      // Lenis, SplitText, ScrollTrigger, web font loaders, analytics) are
      // deliberately left alone -- no evidence anything here replaces
      // them, and removing what isn't confirmed safe is exactly the
      // mistake this whole plan has been careful to avoid.
      //
      // Framer: a single bundled entry point carries an explicit,
      // reliable marker -- confirmed live on two separate captures
      // (dermato, arkitect), both times the ONLY <script src> tag in the
      // entire page is `<script type="module" data-framer-bundle="main"
      // src="...">`. Everything else (react, framer's own runtime,
      // motion, every component chunk) loads via that one entry point's
      // own internal dynamic imports, never as separate <script> tags in
      // the captured HTML -- removing this one tag is sufficient.
      html = html.replace(/<script[^>]*\bdata-framer-bundle="main"[^>]*><\/script>/gi, '');

      // Webflow: no equivalent marker exists (confirmed live: every
      // <script> tag on a real Webflow capture carries nothing but
      // type="text/javascript", no attribute distinguishing framework
      // code from a template's own third-party dependencies), so this
      // matches by the one thing that IS reliable -- Webflow's own
      // asset-naming convention for its two core bundle families,
      // `webflow.schunk.<hash>.js` and `webflow.<hash>.<hash>.js`
      // (confirmed live: tripora ships exactly these two families, one
      // main entry plus several schunk files). Matched as a `webflow.`
      // PREFIX specifically (not a bare "webflow" substring) so this
      // can't accidentally catch `webfont-*.js` (Google's web font
      // loader, an entirely different, still-needed script -- "webfont"
      // and "webflow" differ starting at the 5th character, but a looser
      // substring match wouldn't have caught that).
      html = html.replace(/<script[^>]*\ssrc="[^"]*\/webflow\.[^"]*\.js"[^>]*><\/script>/gi, '');

      // uncage-runtime: the vanilla-JS replacements for whichever widget
      // archetypes this specific page actually uses (interactivity.ts's
      // detection above), loaded from the shared, deduplicated copy Pass
      // 2 wrote once for the whole site. Deferred rather than blocking --
      // none of these need to run before paint (entrance-reveal's own
      // above-the-fold check already handles first-paint content
      // correctly), and page-root-relative paths work regardless of this
      // page's own nesting depth. Placed at the end of <body> so the
      // widget markup they target already exists in the DOM by the time
      // each script runs.
      if (widgets.length > 0) {
        const scripts = widgets
          .map((kind) => `<script is:inline src="/assets/js/uncage-runtime/${kind}.js" defer></script>`)
          .join('');
        html = html.replace('</body>', scripts + '</body>');
      }

      // Frontmatter imports for the CSS blocks Pass 1 pulled out of this
      // page, in their ORIGINAL tag order (not grouped by scope) -- a page
      // that had global, then shared, then page-specific CSS in that
      // sequence gets imports in that same sequence, so Vite's cascade
      // ordering matches what the browser originally saw. Frontmatter must
      // be the very first thing in the file, before the <!DOCTYPE html>
      // this format always emits.
      if (styleTexts.length > 0) {
        const depth = filename.split('/').length; // pages/<...>/<file>.astro -> steps back to src/
        const upToSrc = '../'.repeat(depth);
        const importLines = styleTexts.map((text) => `import '${upToSrc}${styleFiles.get(hashOf(text))!.relPath}';`);
        html = `---\n${importLines.join('\n')}\n---\n${html}`;
      }

      const filePath = path.join(pagesDir, filename);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, html, 'utf-8');
      console.log(`        Generated src/pages/${filename}`);
    }
  },

  async assemble(
    outputDir: string,
    targetUrl: string,
    _originalHead: string,
    routes: string[],
    _runtimeScripts?: string[]
  ): Promise<void> {
    console.log('  [Assembler] Scaffolding Astro project...');

    let safePackageName = path.basename(outputDir).toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'uncage-astro-clone';
    safePackageName = safePackageName.replace(/^[^a-z0-9]+/, '') || 'uncage-astro-clone';

    // 1. package.json
    const pkg = {
      name: safePackageName,
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'astro dev',
        build: 'astro build',
        preview: 'astro preview',
      },
      dependencies: {
        astro: '^7.0.0',
      },
    };
    await fs.writeFile(path.join(outputDir, 'package.json'), JSON.stringify(pkg, null, 2));

    // 2. astro.config.mjs
    const astroConfig = `// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({});
`;
    await fs.writeFile(path.join(outputDir, 'astro.config.mjs'), astroConfig);

    // 3. tsconfig.json
    const tsconfig = `{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
`;
    await fs.writeFile(path.join(outputDir, 'tsconfig.json'), tsconfig);

    // 4. .gitignore
    const gitignore = `node_modules/
dist/
.astro/
.DS_Store
`;
    await fs.writeFile(path.join(outputDir, '.gitignore'), gitignore);

    // 5. README.md
    const routeList = routes
      .map((r) => `- \`${r === '/' || r === '/index' ? '/' : r}\` → \`src/pages/${routeToAstroFilename(r)}\``)
      .join('\n');
    const readme = `# Astro Website Clone

Cloned from ${targetUrl} with [uncage](https://github.com/Nightteye/uncage).

## Run it

\`\`\`bash
npm install
npm run dev
\`\`\`

## Routes

${routeList}

## Notes

Each page ships Framer's own captured markup (styles, runtime scripts, and
all) essentially verbatim. The \`is:global\` / \`is:inline\` directives on
every \`<style>\` / \`<script>\` tag are required for that to render
correctly — removing them re-enables Astro's default scoping/bundling, which
will visibly break the layout and/or any client-side interactivity.
`;
    await fs.writeFile(path.join(outputDir, 'README.md'), readme);

    // 6. Alias missing client-router chunks. Framer's client-side page
    // transition router does dynamic import(`./<hash>.mjs`) per route, but
    // the crawler saves the corresponding chunk under its real hashed
    // filename (`<hash>-<contenthash>.js`), not the bare `.mjs` name the
    // router expects at runtime — a 404 on every such reference (silently
    // falls back to a full page reload, but worth fixing when resolvable).
    const jsDir = path.join(outputDir, 'public', 'assets', 'js');
    try {
      const files = await fs.readdir(jsDir);
      const referenced = new Set<string>();
      for (const file of files) {
        if (!file.endsWith('.js')) continue;
        const content = await fs.readFile(path.join(jsDir, file), 'utf-8');
        for (const m of content.matchAll(/import\(`\.\/([^`]+\.mjs)`\)/g)) referenced.add(m[1]!);
        for (const m of content.matchAll(/import\("\.\/([^"]+\.mjs)"\)/g)) referenced.add(m[1]!);
      }
      let aliased = 0;
      for (const mjsName of referenced) {
        const base = mjsName.slice(0, -4);
        const match = files.find((f) => f.startsWith(base + '-') && f.endsWith('.js'));
        if (!match) continue;
        const dest = path.join(jsDir, mjsName);
        try {
          await fs.access(dest);
        } catch {
          await fs.copyFile(path.join(jsDir, match), dest);
          aliased++;
        }
      }
      if (aliased > 0) {
        console.log(`  [Assembler] Aliased ${aliased} client-router chunk(s) for ./<hash>.mjs imports`);
      }
    } catch {
      // No JS assets directory (e.g. --skip-deps or a purely static template) — nothing to alias.
    }

    // 7. Remove the extractor's raw per-page HTML dumps (`captured-raw*.html`
    // at the project root). They exist purely as a crawl-time debug artifact
    // — the React formats read them back once to synthesize shared
    // breakpoint CSS, but this format never touches them, and Astro's
    // router only looks inside src/pages/ anyway, so they'd otherwise just
    // sit there as dead weight (routinely several MB, comparable to the
    // entire src/ directory) with zero purpose in the shipped project.
    try {
      const rootFiles = await fs.readdir(outputDir);
      const rawFiles = rootFiles.filter((f) => f.startsWith('captured-raw') && f.endsWith('.html'));
      for (const f of rawFiles) {
        await fs.unlink(path.join(outputDir, f));
      }
      if (rawFiles.length > 0) {
        console.log(`  [Assembler] Removed ${rawFiles.length} captured-raw*.html debug artifact(s)`);
      }
    } catch {
      // Best-effort cleanup; a stray debug file left behind isn't worth failing the export over.
    }

    console.log('  [Assembler] Astro project scaffolded: package.json, astro.config.mjs, tsconfig.json, README.md');
  },
};
