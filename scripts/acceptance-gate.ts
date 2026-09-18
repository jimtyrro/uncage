#!/usr/bin/env -S npx tsx
/**
 * Acceptance gate: compares a baseline page (the original live site, or an
 * earlier uncage build) against a candidate page (a fresh uncage build)
 * using two independent checks:
 *
 *   1. Computed-style diff -- walks every element in both pages by DOM
 *      position and compares their resolved CSSOM values, so a
 *      structural/CSS regression (wrong font, missing color, collapsed
 *      layout, a class that stopped applying) fails loudly even if a
 *      screenshot "looks" fine at a glance.
 *
 *   2. Full-page screenshots of both, saved side by side for manual visual
 *      review (no pixel-diff library is a dependency here, so this stays a
 *      human-in-the-loop check, not an automated pass/fail).
 *
 * Deliberately excludes `transform` and `opacity` from the computed-style
 * comparison. Real-data finding this session (dermato/tripora, Step 2a):
 * some elements are *continuously* animating (marquees, drift effects,
 * scroll-driven parallax) even at rest, so two loads of the *same* build
 * can disagree on these two properties from frame to frame -- confirmed
 * via a same-build-loaded-twice control. Comparing them directly produces
 * false positives that drown out real regressions. Every other computed
 * property (color, font, display, position, size, spacing, ...) is a
 * legitimate signal and is compared as-is.
 *
 * Best used candidate-vs-candidate: feed the *same* captured/crawled
 * content through compile() before and after a code change (e.g. two
 * output dirs, or one output dir served before a fix and rebuilt after).
 * That's an apples-to-apples DOM, so every STYLE diff is a real signal.
 *
 * Also works live-site-vs-candidate, and did catch a real bug that way
 * (custom-cursor.js's cascading cursor:pointer regression, found by
 * running this against arkitect) -- but expect STRUCTURE noise in that
 * mode: confirmed live that Framer's own client JS injects a second,
 * parallel hydration root (`<div id="main" data-framer-hydrate-v2="...">`)
 * as a body-level sibling after the page settles, which the static
 * capture never has, and that single extra/missing sibling shifts the
 * position-based path of everything after it -- not a real regression,
 * an artifact of comparing a JS-hydrated live DOM against a static
 * snapshot. Treat STRUCTURE diffs in live-vs-candidate mode as
 * informational (check the screenshots), and STYLE diffs on paths that
 * exist in both as the reliable signal (those ARE the same element).
 *
 * Usage:
 *   npx tsx scripts/acceptance-gate.ts <baseline-url> <candidate-url> [routes...]
 *
 * Example:
 *   npx tsx scripts/acceptance-gate.ts \
 *     https://arkitect-template.framer.website \
 *     http://localhost:4321 \
 *     / /about /services
 *
 * Routes default to just "/" when omitted. Each route is resolved against
 * both base URLs. Screenshots and a JSON diff report are written to
 * ./acceptance-gate-report/<route>/.
 */

import { chromium, type Page } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';

const EXCLUDED_PROPERTIES = new Set(['transform', 'opacity']);

// Settle time before measuring: lets entrance-reveal / bake-in states
// finish their transition and any layout-affecting webfont swap settle,
// so we're comparing steady-state, not an animation mid-flight.
const SETTLE_MS = 1500;

// Broad but bounded set of properties worth comparing per element. Full
// getComputedStyle() has ~300 properties including many longhands that
// never vary independently of the shorthand already covered here (e.g.
// margin-top through margin-left vs margin) -- keeping the list explicit
// keeps diffs readable and keeps runtime reasonable across every element
// on a page instead of ~300x that.
const COMPARED_PROPERTIES = [
  'display',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'backgroundColor',
  'backgroundImage',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'flexDirection',
  'justifyContent',
  'alignItems',
  'gridTemplateColumns',
  'border',
  'borderRadius',
  'boxShadow',
  'zIndex',
  'visibility',
  'overflow',
  'cursor',
];

interface ElementSnapshot {
  path: string;
  tag: string;
  styles: Record<string, string>;
}

async function snapshotPage(page: Page, url: string): Promise<ElementSnapshot[]> {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(SETTLE_MS);

  // Passed as a plain source string, not a function reference: tsx's
  // esbuild dev transform wraps named functions/const-assigned arrows
  // with an `__name(fn, "name")` call for stack-trace fidelity, and that
  // helper only exists in the outer Node process -- Playwright serializes
  // a function reference via `.toString()` and runs it bare in the page,
  // where `__name` is undefined. A string literal is sent to the page
  // and evaluated there directly, so it never goes through esbuild.
  const source = `
    (function (compared) {
      function pathOf(el) {
        var parts = [];
        var node = el;
        while (node && node !== document.body) {
          var tag = node.tagName.toLowerCase();
          var siblings = node.parentElement
            ? Array.from(node.parentElement.children).filter(function (s) { return s.tagName === node.tagName; })
            : [node];
          var idx = siblings.indexOf(node) + 1;
          parts.unshift(tag + ':nth-of-type(' + idx + ')');
          node = node.parentElement;
        }
        return 'body>' + parts.join('>');
      }

      var results = [];
      var all = document.body.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.tagName === 'SCRIPT') continue;
        var cs = getComputedStyle(el);
        var styles = {};
        for (var j = 0; j < compared.length; j++) {
          var prop = compared[j];
          styles[prop] = cs.getPropertyValue(prop.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }));
        }
        results.push({ path: pathOf(el), tag: el.tagName.toLowerCase(), styles: styles });
      }
      return results;
    })(${JSON.stringify(COMPARED_PROPERTIES)})
  `;

  return page.evaluate(source);
}

function diffSnapshots(baseline: ElementSnapshot[], candidate: ElementSnapshot[]) {
  const baseMap = new Map(baseline.map((s) => [s.path, s]));
  const candMap = new Map(candidate.map((s) => [s.path, s]));

  const onlyInBaseline: string[] = [];
  const onlyInCandidate: string[] = [];
  const styleDiffs: { path: string; tag: string; property: string; baseline: string; candidate: string }[] = [];

  for (const [p, base] of baseMap) {
    const cand = candMap.get(p);
    if (!cand) {
      onlyInBaseline.push(p);
      continue;
    }
    for (const prop of COMPARED_PROPERTIES) {
      if (EXCLUDED_PROPERTIES.has(prop)) continue;
      if (base.styles[prop] !== cand.styles[prop]) {
        styleDiffs.push({
          path: p,
          tag: base.tag,
          property: prop,
          baseline: base.styles[prop] ?? '',
          candidate: cand.styles[prop] ?? '',
        });
      }
    }
  }
  for (const p of candMap.keys()) {
    if (!baseMap.has(p)) onlyInCandidate.push(p);
  }

  return { onlyInBaseline, onlyInCandidate, styleDiffs };
}

async function main() {
  const [, , baselineUrl, candidateUrl, ...routeArgs] = process.argv;
  if (!baselineUrl || !candidateUrl) {
    console.error('Usage: npx tsx scripts/acceptance-gate.ts <baseline-url> <candidate-url> [routes...]');
    process.exit(1);
  }
  const routes = routeArgs.length > 0 ? routeArgs : ['/'];

  const browser = await chromium.launch();
  const outDir = path.resolve('acceptance-gate-report');
  await fs.mkdir(outDir, { recursive: true });

  let anyFailed = false;

  for (const route of routes) {
    const baseUrl = new URL(route, baselineUrl).toString();
    const candUrl = new URL(route, candidateUrl).toString();
    const routeDir = path.join(outDir, route === '/' ? 'index' : route.replace(/^\//, '').replace(/\//g, '_'));
    await fs.mkdir(routeDir, { recursive: true });

    console.log(`\n=== ${route} ===`);
    console.log(`  baseline:  ${baseUrl}`);
    console.log(`  candidate: ${candUrl}`);

    const basePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const candPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    const [baseSnap, candSnap] = await Promise.all([snapshotPage(basePage, baseUrl), snapshotPage(candPage, candUrl)]);

    await basePage.screenshot({ path: path.join(routeDir, 'baseline.png'), fullPage: true });
    await candPage.screenshot({ path: path.join(routeDir, 'candidate.png'), fullPage: true });
    await basePage.close();
    await candPage.close();

    const diff = diffSnapshots(baseSnap, candSnap);
    await fs.writeFile(path.join(routeDir, 'diff.json'), JSON.stringify(diff, null, 2));

    const structuralIssues = diff.onlyInBaseline.length + diff.onlyInCandidate.length;
    if (structuralIssues > 0) {
      console.log(`  STRUCTURE: ${diff.onlyInBaseline.length} element(s) missing in candidate, ${diff.onlyInCandidate.length} extra`);
      anyFailed = true;
    }
    if (diff.styleDiffs.length > 0) {
      console.log(`  STYLE: ${diff.styleDiffs.length} computed-style difference(s) -- see ${routeDir}/diff.json`);
      for (const d of diff.styleDiffs.slice(0, 10)) {
        console.log(`    ${d.path} [${d.property}] "${d.baseline}" -> "${d.candidate}"`);
      }
      if (diff.styleDiffs.length > 10) console.log(`    ... and ${diff.styleDiffs.length - 10} more`);
      anyFailed = true;
    }
    if (structuralIssues === 0 && diff.styleDiffs.length === 0) {
      console.log('  OK -- no structural or computed-style differences');
    }
    console.log(`  screenshots: ${routeDir}/baseline.png, ${routeDir}/candidate.png (review manually)`);
  }

  await browser.close();

  console.log(`\nFull report: ${outDir}/`);
  if (anyFailed) {
    console.log('Some routes have differences -- review before treating as a regression (transform/opacity are intentionally excluded; some diffs may be expected content/CMS drift between crawls).');
    process.exit(1);
  }
}

main();
