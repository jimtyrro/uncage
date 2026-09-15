import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';
import type { ExporterStrategy } from '../types.js';

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

      let html = '<!DOCTYPE html>\n' + $.html();

      // Astro auto-scopes <style> and auto-bundles <script> tags by default
      // (rewriting selectors with a data-astro-cid-* attribute, splitting
      // scripts into separately-fetched ES modules). Both silently break
      // this vendored markup: scoping strips most of Framer's generated CSS
      // (the scoping attribute doesn't land on every element the selectors
      // target), and script bundling turns synchronous inline bootstrap
      // scripts into deferred modules. is:global / is:inline disable both,
      // shipping every tag exactly as captured.
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
