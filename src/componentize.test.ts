import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { extractMetaProps, computeHeadBoilerplate, findSharedBodyComponents, templateActiveLinks } from './componentize.js';

describe('extractMetaProps', () => {
  it('pulls title, description, canonical, og:*, twitter:* and removes them from $', () => {
    const html =
      '<html><head>' +
      '<meta charset="utf-8">' +
      '<title>Arkitect - Architecture Framer Template</title>' +
      '<meta name="description" content="Arkitect is a modern Framer template.">' +
      '<link rel="canonical" href="/">' +
      '<meta property="og:title" content="Arkitect - Architecture Framer Template">' +
      '<meta property="og:description" content="Arkitect is a modern Framer template.">' +
      '<meta property="og:url" content="https://arkitect-template.framer.website/">' +
      '<meta property="og:image" content="https://framerusercontent.com/images/x.webp">' +
      '<meta name="twitter:title" content="Arkitect">' +
      '<meta name="twitter:description" content="Arkitect desc">' +
      '<meta name="generator" content="Framer">' +
      '</head><body></body></html>';
    const $ = cheerio.load(html);
    const props = extractMetaProps($);
    expect(props).toEqual({
      title: 'Arkitect - Architecture Framer Template',
      description: 'Arkitect is a modern Framer template.',
      canonical: '/',
      ogTitle: 'Arkitect - Architecture Framer Template',
      ogDescription: 'Arkitect is a modern Framer template.',
      ogUrl: 'https://arkitect-template.framer.website/',
      ogImage: 'https://framerusercontent.com/images/x.webp',
      twitterTitle: 'Arkitect',
      twitterDescription: 'Arkitect desc',
    });
    // known tags removed from the DOM
    expect($('head title').length).toBe(0);
    expect($('head meta[name="description"]').length).toBe(0);
    expect($('head link[rel="canonical"]').length).toBe(0);
    // untouched boilerplate stays
    expect($('head meta[name="generator"]').length).toBe(1);
  });

  it('matches meta tags regardless of attribute order (Webflow writes content before name/property)', () => {
    // Reproduces the real tripora pattern verbatim: content="..." comes
    // BEFORE name="description", the opposite order from Framer's own
    // output -- confirmed live this session.
    const html =
      '<html><head>' +
      '<title>Tripora - Webflow HTML website template</title>' +
      '<meta content="Premium travel website template." name="description">' +
      '<meta content="Tripora" property="og:title">' +
      '</head><body></body></html>';
    const $ = cheerio.load(html);
    const props = extractMetaProps($);
    expect(props.description).toBe('Premium travel website template.');
    expect(props.ogTitle).toBe('Tripora');
  });

  it('returns null for missing optional tags without throwing', () => {
    const html = '<html><head><title>Just a title</title></head><body></body></html>';
    const $ = cheerio.load(html);
    const props = extractMetaProps($);
    expect(props.title).toBe('Just a title');
    expect(props.description).toBeNull();
    expect(props.canonical).toBeNull();
    expect(props.ogImage).toBeNull();
  });
});

describe('computeHeadBoilerplate', () => {
  it('extracts shared boilerplate when every page has identical remaining head content', () => {
    const shared = '<meta charset="utf-8"><meta name="generator" content="Framer">';
    const pages = [
      { route: '/', headInnerHtml: shared, htmlAttrs: ' lang="en"' },
      { route: '/about', headInnerHtml: shared, htmlAttrs: ' lang="en"' },
      { route: '/services', headInnerHtml: shared, htmlAttrs: ' lang="en"' },
    ];
    const result = computeHeadBoilerplate(pages);
    expect(result.boilerplate).toBe(shared);
    expect(result.perPageExtra.size).toBe(0);
  });

  it('treats <html class> token reordering as identical (tripora regression)', () => {
    // Reproduces the real tripora pattern verbatim: same SET of Webflow
    // font-detection classes, different append order per page (async
    // font-load timing during the crawl), confirmed live this session.
    const shared = '<meta charset="utf-8">';
    const pages = [
      { route: '/', headInnerHtml: shared, htmlAttrs: ' data-wf-page="a" class="w-mod-js w-mod-ix lenis wf-a-active wf-b-active"' },
      { route: '/about', headInnerHtml: shared, htmlAttrs: ' data-wf-page="b" class="w-mod-js wf-b-active wf-a-active w-mod-ix lenis"' },
    ];
    const result = computeHeadBoilerplate(pages);
    expect(result.boilerplate).toBe(shared);
    expect(result.perPageExtra.size).toBe(0);
    // data-wf-page (page-specific Webflow internal id, dead now that
    // webflow.js is stripped) is dropped from the shared html attrs
    expect(result.htmlAttrs).not.toContain('data-wf-page');
  });

  it('keeps a page-specific extra tag out of the shared boilerplate instead of dropping it (dermato regression)', () => {
    // Reproduces the real dermato pattern: an empty leftover
    // data-emotion style tag only on the page that has the CSS-in-JS
    // before/after widget, confirmed live this session.
    const shared = '<meta charset="utf-8"><meta name="generator" content="Framer">';
    const withExtra = shared + '<style data-emotion="css" data-s=""></style>';
    const pages = [
      { route: '/', headInnerHtml: withExtra, htmlAttrs: ' lang="en"' },
      { route: '/about', headInnerHtml: shared, htmlAttrs: ' lang="en"' },
      { route: '/services', headInnerHtml: shared, htmlAttrs: ' lang="en"' },
    ];
    const result = computeHeadBoilerplate(pages);
    expect(result.boilerplate).toBe(shared);
    expect(result.perPageExtra.size).toBe(1);
    expect(result.perPageExtra.get('/')).toBe(withExtra);
    expect(result.perPageExtra.has('/about')).toBe(false);
  });

  it('falls back to no boilerplate for a single-page site', () => {
    const pages = [{ route: '/', headInnerHtml: '<meta charset="utf-8">', htmlAttrs: ' lang="en"' }];
    const result = computeHeadBoilerplate(pages);
    expect(result.boilerplate).toBeNull();
    expect(result.perPageExtra.get('/')).toBe('<meta charset="utf-8">');
  });
});

describe('findSharedBodyComponents', () => {
  function pageWith(route: string, navHtml: string, uniqueBody: string) {
    return { route, $: cheerio.load(`<html><head></head><body>${navHtml}${uniqueBody}</body></html>`) };
  }

  const pad = 'x'.repeat(420);

  it('detects a nav repeating across every page and names it Nav', () => {
    const nav = `<nav class="main-nav" data-pad="${pad}"><a href="/">Home</a><a href="/about">About</a></nav>`;
    const pages = [
      pageWith('/', nav, '<p>home content</p>'),
      pageWith('/about', nav, '<p>about content</p>'),
      pageWith('/contact', nav, '<p>contact content</p>'),
    ];
    const result = findSharedBodyComponents(pages);
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe('Nav');
    expect(result[0]!.occurrences.map((o) => o.route).sort()).toEqual(['/', '/about', '/contact']);
  });

  it('tolerates the block being absent on a minority of pages (85% threshold)', () => {
    const nav = `<nav class="main-nav" data-pad="${pad}"><a href="/">Home</a></nav>`;
    const pages = [
      pageWith('/', nav, '<p>a</p>'),
      pageWith('/p2', nav, '<p>b</p>'),
      pageWith('/p3', nav, '<p>c</p>'),
      pageWith('/p4', nav, '<p>d</p>'),
      pageWith('/p5', nav, '<p>e</p>'),
      pageWith('/p6', nav, '<p>f</p>'),
      { route: '/404', $: cheerio.load('<html><head></head><body><p>not found</p></body></html>') },
    ];
    const result = findSharedBodyComponents(pages);
    expect(result.length).toBe(1);
    expect(result[0]!.occurrences.length).toBe(6);
  });

  it('does not extract when fewer than 85% of pages share the block', () => {
    const nav = `<nav class="main-nav" data-pad="${pad}"><a href="/">Home</a></nav>`;
    const pages = [
      pageWith('/', nav, '<p>a</p>'),
      pageWith('/p2', nav, '<p>b</p>'),
      { route: '/p3', $: cheerio.load('<html><head></head><body><p>different layout entirely</p></body></html>') },
    ];
    const result = findSharedBodyComponents(pages);
    expect(result.length).toBe(0);
  });

  it('disambiguates name collisions (Framer commonly names multiple elements "Desktop")', () => {
    const a = `<div data-framer-name="Desktop" data-pad="${pad}-a"><a href="/">Home</a></div>`;
    const b = `<div data-framer-name="Desktop" data-pad="${pad}-b"><a href="/x">X</a></div>`;
    const pages = [
      pageWith('/', a + b, '<p>1</p>'),
      pageWith('/p2', a + b, '<p>2</p>'),
      pageWith('/p3', a + b, '<p>3</p>'),
    ];
    const result = findSharedBodyComponents(pages);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(['Desktop', 'Desktop2']);
  });

  it('does not separately extract a nested fragment already covered by a larger accepted candidate', () => {
    const inner = `<div class="inner-fragment" data-pad="${pad}"><a href="/">Home</a></div>`;
    const outer = `<footer class="site-footer" data-pad2="${pad}">${inner}<p>more footer content ${pad}</p></footer>`;
    const pages = [
      pageWith('/', outer, '<p>1</p>'),
      pageWith('/p2', outer, '<p>2</p>'),
      pageWith('/p3', outer, '<p>3</p>'),
    ];
    const result = findSharedBodyComponents(pages);
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe('Footer');
  });

  it('normalizes Webflow aria-current and w--current class before comparing (tripora regression)', () => {
    const navFor = (active: string) =>
      `<nav class="main-nav" data-pad="${pad}">` +
      `<a href="/" class="nav-link-item${active === '/' ? ' w--current' : ''}"${active === '/' ? ' aria-current="page"' : ''}>Home</a>` +
      `<a href="/about" class="nav-link-item${active === '/about' ? ' w--current' : ''}"${active === '/about' ? ' aria-current="page"' : ''}>About</a>` +
      `</nav>`;
    const pages = [
      pageWith('/', navFor('/'), '<p>1</p>'),
      pageWith('/about', navFor('/about'), '<p>2</p>'),
      pageWith('/contact', navFor(''), '<p>3</p>'),
    ];
    const result = findSharedBodyComponents(pages);
    expect(result.length).toBe(1);
    expect(result[0]!.occurrences.length).toBe(3);
  });
});

describe('templateActiveLinks', () => {
  it('rewrites Framer active-link markers into a currentPath-driven expression', () => {
    const html = '<nav><a href="/" data-framer-page-link-current="true">Home</a><a href="/about">About</a></nav>';
    const out = templateActiveLinks(html);
    expect(out).toContain('data-framer-page-link-current={currentPath === "/" ? "true" : undefined}');
    expect(out).toContain('data-framer-page-link-current={currentPath === "/about" ? "true" : undefined}');
    expect(out).not.toContain('data-framer-page-link-current="true"');
  });

  it('rewrites Webflow active-link markers (class + aria-current) into currentPath-driven expressions', () => {
    const html = '<nav><a href="/" aria-current="page" class="nav-link-item w--current">Home</a><a href="/about" class="nav-link-item">About</a></nav>';
    const out = templateActiveLinks(html);
    expect(out).toContain('aria-current={currentPath === "/" ? "page" : undefined}');
    expect(out).toContain('class={`nav-link-item ${currentPath === "/" ? "w--current" : ""}`}');
    expect(out).toContain('class={`nav-link-item ${currentPath === "/about" ? "w--current" : ""}`}');
    expect(out).not.toContain('aria-current="page"');
  });

  it('is a no-op when neither marker convention is present', () => {
    const html = '<footer><a href="/contact">Contact</a></footer>';
    expect(templateActiveLinks(html)).toBe(html);
  });
});
