import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { detectWidgets } from './interactivity.js';

function counts(results: ReturnType<typeof detectWidgets>): Record<string, number> {
  return Object.fromEntries(results.map((r) => [r.kind, r.count]));
}

describe('detectWidgets: carousel', () => {
  it('detects a Webflow .w-slider', () => {
    const $ = cheerio.load('<div class="w-slider"><div class="w-slide">A</div><div class="w-slide">B</div></div>');
    expect(counts(detectWidgets($))['carousel']).toBe(1);
  });

  it('detects Framer via the data-framer-components library manifest', () => {
    const $ = cheerio.load('<html data-framer-components="framer-lib-cursors-host framer-slideshow-component"><body></body></html>');
    expect(counts(detectWidgets($))['carousel']).toBe(1);
  });

  it('does not fire on an ordinary page', () => {
    const $ = cheerio.load('<div class="grid"><div class="card">A</div></div>');
    expect(counts(detectWidgets($))['carousel']).toBeUndefined();
  });
});

describe('detectWidgets: nav-dropdown', () => {
  it('detects Webflow .w-nav-button and .w-dropdown', () => {
    const $ = cheerio.load('<nav class="w-nav"><div class="w-nav-button"></div></nav><div class="w-dropdown"></div>');
    expect(counts(detectWidgets($))['nav-dropdown']).toBe(2);
  });

  it('detects an ARIA-labelled menu toggle (cross-platform fallback)', () => {
    const $ = cheerio.load('<button aria-label="Toggle menu">☰</button>');
    expect(counts(detectWidgets($))['nav-dropdown']).toBe(1);
  });
});

describe('detectWidgets: tabs', () => {
  it('detects Webflow .w-tab-link', () => {
    const $ = cheerio.load('<div class="w-tab-link">One</div><div class="w-tab-link">Two</div>');
    expect(counts(detectWidgets($))['tabs']).toBe(2);
  });

  it('detects proper ARIA role="tab" markup', () => {
    const $ = cheerio.load('<div role="tab">One</div>');
    expect(counts(detectWidgets($))['tabs']).toBe(1);
  });
});

describe('detectWidgets: custom-cursor', () => {
  it('detects data-framer-cursor', () => {
    const $ = cheerio.load('<div data-framer-cursor="pointer">Hover me</div>');
    expect(counts(detectWidgets($))['custom-cursor']).toBe(1);
  });
});

describe('detectWidgets: entrance-reveal', () => {
  it('counts elements matching the same condition as astro.ts\'s opacity bake-in', () => {
    const $ = cheerio.load(
      '<div style="opacity: 0;">A</div>' +
      '<div style="will-change: transform; opacity: 0.5;">B</div>' +
      '<div style="opacity: 0.1;">C (no will-change, not counted)</div>' +
      '<div style="opacity: 1;">D (already settled, not counted)</div>'
    );
    expect(counts(detectWidgets($))['entrance-reveal']).toBe(2);
  });
});

describe('detectWidgets: marquee', () => {
  it('detects a seamless-loop list (content duplicated in two halves)', () => {
    const $ = cheerio.load(
      '<ul>' +
      '<li>Company A review text here</li><li>Company B review text here</li>' +
      '<li>Company A review text here</li><li>Company B review text here</li>' +
      '</ul>'
    );
    expect(counts(detectWidgets($))['marquee']).toBe(1);
  });

  it('does NOT match an icon-only row with empty text/no distinguishing content', () => {
    // Reproduces the real false positive found on tripora:
    // .footer-social-inline, four icon links with no text content --
    // both "halves" trivially matched as all-blank strings.
    const $ = cheerio.load(
      '<div class="footer-social-inline">' +
      '<a class="icon"></a><a class="icon"></a><a class="icon"></a><a class="icon"></a>' +
      '</div>'
    );
    expect(counts(detectWidgets($))['marquee']).toBeUndefined();
  });

  it('matches on image src/alt, not just text', () => {
    const $ = cheerio.load(
      '<div>' +
      '<img src="/logo-a.png" alt="Company A logo"><img src="/logo-b.png" alt="Company B logo">' +
      '<img src="/logo-a.png" alt="Company A logo"><img src="/logo-b.png" alt="Company B logo">' +
      '</div>'
    );
    expect(counts(detectWidgets($))['marquee']).toBe(1);
  });
});

describe('detectWidgets: scroll-pin', () => {
  it('detects a sticky container with an animated (will-change + transform) descendant', () => {
    const $ = cheerio.load(
      '<div class="panel"><div style="will-change: transform; transform: translate3d(0, -110%, 0);">Slide</div></div>'
    );
    const css = '.panel { position: sticky; top: 0; }';
    expect(counts(detectWidgets($, css))['scroll-pin']).toBe(1);
  });

  it('does NOT match a plain sticky navbar with no animated descendants', () => {
    // Reproduces the real false positive found on dermato: a sticky
    // header/navbar is pure CSS, needs no JS runtime module.
    const $ = cheerio.load('<nav class="site-nav"><a href="/">Home</a></nav>');
    const css = '.site-nav { position: sticky; top: 0; }';
    expect(counts(detectWidgets($, css))['scroll-pin']).toBeUndefined();
  });

  it('finds the rule regardless of class-naming convention (semantic vs. utility class)', () => {
    // Confirmed live: the same real site used a semantic class name in one
    // capture (`.service-one-service-wrapper`) and a generic utility class
    // in another (`.position-sticky`) for the identical pattern.
    const $ = cheerio.load(
      '<div class="position-sticky"><div style="will-change: transform; transform: translateY(40px);">X</div></div>'
    );
    const css = '.position-sticky{pointer-events:auto;width:100%;position:sticky;top:0}';
    expect(counts(detectWidgets($, css))['scroll-pin']).toBe(1);
  });

  it('ignores unparseable selectors and at-rules without throwing', () => {
    const $ = cheerio.load('<div>Hi</div>');
    const css = '@media (min-width: 800px) { .x { position: sticky; } } ::before { position: sticky; }';
    expect(() => detectWidgets($, css)).not.toThrow();
  });
});
