import { describe, it, expect } from 'vitest';
import { rewriteHtml, rawFileNameForRoute, globToRegExp, shouldFetchUrl, extractCssReferencedUrls, extractHtmlReferencedUrls } from './extractor.js';

describe('rewriteHtml asset URL rewriting', () => {
  it('rewrites a query-string URL containing & when HTML-encoded as &amp;', () => {
    const assetMap = {
      'https://cdn.example.com/img.png?x=1&y=2': '/assets/images/img-abc123.png',
    };
    const html = '<img src="https://cdn.example.com/img.png?x=1&amp;y=2" />';
    const result = rewriteHtml(html, 'https://site.com/', assetMap, 'https://site.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('/assets/images/img-abc123.png');
      expect(result.value).not.toContain('cdn.example.com');
    }
  });

  it('still rewrites a plain (non-encoded) URL', () => {
    const assetMap = {
      'https://cdn.example.com/style.css': '/assets/css/style-abc.css',
    };
    const html = '<link rel="stylesheet" href="https://cdn.example.com/style.css" />';
    const result = rewriteHtml(html, 'https://site.com/', assetMap, 'https://site.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('/assets/css/style-abc.css');
    }
  });

  it('rewrites a CSS-escaped url() whose filename contains parens (real linoxa capture)', () => {
    // Reproduces the real bug: a filename like "overview image (3).webp"
    // is CSS-escaped in the captured markup as \(3\). assetMap keys are
    // the browser's own already-decoded request URLs (real parens, no
    // backslashes), so the lookup must unescape before matching.
    const assetMap = {
      'https://cdn.example.com/overview image (3).webp': '/assets/images/overview-abc123.webp',
    };
    const html = '<div style="background-image:url(https://cdn.example.com/overview image \\(3\\).webp)"></div>';
    const result = rewriteHtml(html, 'https://site.com/', assetMap, 'https://site.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('/assets/images/overview-abc123.webp');
      expect(result.value).not.toContain('cdn.example.com');
    }
  });

  it('does not truncate at an escaped closing paren (regression: used to stop at the first \\))', () => {
    const assetMap = {
      'https://cdn.example.com/a(1)b(2).webp': '/assets/images/ab-def456.webp',
    };
    const html = 'url(https://cdn.example.com/a\\(1\\)b\\(2\\).webp)';
    const result = rewriteHtml(html, 'https://site.com/', assetMap, 'https://site.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('url("/assets/images/ab-def456.webp")');
    }
  });
});

describe('extractCssReferencedUrls', () => {
  it('finds an absolute https url() reference', () => {
    const css = '.a{background-image:url(https://cdn.example.com/x.webp)}';
    expect(extractCssReferencedUrls(css, 'https://cdn.example.com/style.css')).toEqual([
      'https://cdn.example.com/x.webp',
    ]);
  });

  it('resolves a relative url() against the supplied context URL', () => {
    const css = ".a{background:url('../img/x.webp')}";
    expect(extractCssReferencedUrls(css, 'https://cdn.example.com/css/style.css')).toEqual([
      'https://cdn.example.com/img/x.webp',
    ]);
  });

  it('unescapes a CSS-backslash-escaped filename without truncating (real linoxa capture)', () => {
    const css = '.rt{background-image:url(https://cdn.example.com/overview%20image%20\\(3\\).webp)}';
    expect(extractCssReferencedUrls(css, 'https://cdn.example.com/style.css')).toEqual([
      'https://cdn.example.com/overview%20image%20(3).webp',
    ]);
  });

  it('skips data: URLs', () => {
    const css = '.a{background:url(data:image/png;base64,AAAA)}';
    expect(extractCssReferencedUrls(css, 'https://cdn.example.com/style.css')).toEqual([]);
  });

  it('finds multiple references in the same block', () => {
    const css = '.a{background:url(https://cdn.example.com/a.png)}.b{background:url(https://cdn.example.com/b.png)}';
    expect(extractCssReferencedUrls(css, 'https://cdn.example.com/style.css')).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]);
  });
});

describe('extractHtmlReferencedUrls', () => {
  it('finds an absolute src attribute', () => {
    const html = '<img src="https://cdn.example.com/avatar.webp">';
    expect(extractHtmlReferencedUrls(html, 'https://cdn.example.com/page')).toEqual([
      'https://cdn.example.com/avatar.webp',
    ]);
  });

  it('resolves a root-relative src against the page URL', () => {
    const html = '<img src="/assets/x.webp">';
    expect(extractHtmlReferencedUrls(html, 'https://cdn.example.com/blog/post')).toEqual([
      'https://cdn.example.com/assets/x.webp',
    ]);
  });

  it('finds a poster attribute (video carousel/testimonial pattern)', () => {
    const html = '<video poster="https://cdn.example.com/thumb.jpg" src="https://cdn.example.com/v.mp4"></video>';
    expect(extractHtmlReferencedUrls(html, 'https://cdn.example.com/page')).toEqual([
      'https://cdn.example.com/thumb.jpg',
      'https://cdn.example.com/v.mp4',
    ]);
  });

  it('extracts every URL out of a srcset, ignoring the descriptor', () => {
    const html = '<img srcset="https://cdn.example.com/a.webp 1x, https://cdn.example.com/b.webp 2x">';
    expect(extractHtmlReferencedUrls(html, 'https://cdn.example.com/page')).toEqual([
      'https://cdn.example.com/a.webp',
      'https://cdn.example.com/b.webp',
    ]);
  });

  it('skips data: URLs', () => {
    const html = '<img src="data:image/png;base64,AAAA">';
    expect(extractHtmlReferencedUrls(html, 'https://cdn.example.com/page')).toEqual([]);
  });

  it('finds a favicon/apple-touch-icon <link href> (real arkitect capture)', () => {
    const html =
      '<link href="https://framerusercontent.com/images/a.png" rel="icon" media="(prefers-color-scheme: light)">' +
      '<link rel="apple-touch-icon" href="https://framerusercontent.com/images/b.png">';
    expect(extractHtmlReferencedUrls(html, 'https://cdn.example.com/page')).toEqual([
      'https://framerusercontent.com/images/a.png',
      'https://framerusercontent.com/images/b.png',
    ]);
  });

  it('does not match an unrelated <link href> (stylesheet, canonical, preload)', () => {
    const html =
      '<link rel="stylesheet" href="https://cdn.example.com/style.css">' +
      '<link rel="canonical" href="https://cdn.example.com/page">' +
      '<link rel="preload" as="font" href="https://cdn.example.com/font.woff2">';
    expect(extractHtmlReferencedUrls(html, 'https://cdn.example.com/page')).toEqual([]);
  });
});

describe('rawFileNameForRoute', () => {
  it('does not collide for routes that sanitize to the same prefix', () => {
    const a = rawFileNameForRoute('/about/us');
    const b = rawFileNameForRoute('/about-us');
    expect(a).not.toBe(b);
  });

  it('is deterministic for a given route', () => {
    expect(rawFileNameForRoute('/about/us')).toBe(rawFileNameForRoute('/about/us'));
  });

  it('maps home and index to captured-raw.html', () => {
    expect(rawFileNameForRoute('/')).toBe('captured-raw.html');
    expect(rawFileNameForRoute('/index')).toBe('captured-raw.html');
  });
});

describe('globToRegExp', () => {
  it('supports * and ? wildcards', () => {
    expect(globToRegExp('https://*.example.com/*')?.test('https://cdn.example.com/a')).toBe(true);
    expect(globToRegExp('https://cdn.example.com/file?.js')?.test('https://cdn.example.com/file1.js')).toBe(true);
  });

  it('supports [range] character classes', () => {
    const re = globToRegExp('https://cdn.example.com/file[0-9].js');
    expect(re?.test('https://cdn.example.com/file5.js')).toBe(true);
    expect(re?.test('https://cdn.example.com/filex.js')).toBe(false);
  });

  it('returns null for unbalanced brackets', () => {
    expect(globToRegExp('https://cdn.example.com/file[0-9.js')).toBeNull();
  });
});

describe('shouldFetchUrl', () => {
  it('allows everything when no filters are set (regression: empty list must not block)', () => {
    expect(shouldFetchUrl('https://cdn.example.com/lib.js', [], [])).toBe(true);
    expect(shouldFetchUrl('https://respawn.sh/_next/static/chunks/x.js', [], [])).toBe(true);
  });

  it('blocks URLs matching the blocklist', () => {
    expect(shouldFetchUrl('https://ads.example.com/track.js', [], ['https://ads.example.com/*'])).toBe(false);
  });

  it('allows only URLs matching the allowlist when it is set', () => {
    expect(shouldFetchUrl('https://cdn.example.com/a.js', ['https://cdn.example.com/*'], [])).toBe(true);
    expect(shouldFetchUrl('https://other.example.com/b.js', ['https://cdn.example.com/*'], [])).toBe(false);
  });

  it('blocklist takes precedence over allowlist', () => {
    expect(shouldFetchUrl('https://cdn.example.com/a.js', ['https://cdn.example.com/*'], ['https://cdn.example.com/a.js'])).toBe(false);
  });
});
