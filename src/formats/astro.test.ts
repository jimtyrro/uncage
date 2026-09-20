import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { astroStrategy, routeToAstroFilename } from './astro.js';

describe('Astro format: curly-brace escaping in text content', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function compileOnePage(html: string): Promise<{ astro: string; outputDir: string }> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, { '/test': html });
    const astro = await fs.readFile(path.join(outputDir, 'src', 'pages', 'test.astro'), 'utf-8');
    return { astro, outputDir };
  }

  async function readAllExtractedCss(outputDir: string): Promise<string> {
    const stylesDir = path.join(outputDir, 'src', 'styles');
    const chunks: string[] = [];
    async function walk(dir: string) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else chunks.push(await fs.readFile(full, 'utf-8'));
      }
    }
    await walk(stylesDir);
    return chunks.join('\n');
  }


  it('escapes literal curly braces in ordinary text content', async () => {
    // Reproduces the real failure: a Webflow template's own documentation
    // page displayed example init code ("new Lenis({...})") as plain text,
    // and Astro's compiler -- which treats a bare `{` in HTML body content
    // as the start of a JS expression, same rule as JSX -- failed the whole
    const html = '<!DOCTYPE html><html><head></head><body><p>new Lenis({smooth: true})</p></body></html>';
    const { astro } = await compileOnePage(html);

    expect(astro).toContain('new Lenis(&#123;smooth: true&#125;)');
    // The raw, unescaped form must not survive anywhere in the body content
    // this test controls (this exact substring only appears in our escaped
    // encoding otherwise).
    expect(astro).not.toContain('new Lenis({smooth: true})');
  });

  it('does NOT escape braces inside <script> content', async () => {
    // Astro (like the browser) treats <script> contents as raw, unparsed
    // JS. Escaping braces there would corrupt real, executable code -- e.g.
    // turning `if (x) { y() }` into `if (x) &#123; y() &#125;`, which is no
    // longer valid JavaScript.
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<script>function f(x){ if (x) { return {a: 1} } }</script>' +
      '</body></html>';
    const { astro } = await compileOnePage(html);

    expect(astro).toContain('function f(x){ if (x) { return {a: 1} } }');
  });

  it('does NOT escape braces inside extracted <style> content', async () => {
    // Style content is pulled out into src/styles/ (see the CSS-extraction
    // describe block below) rather than staying inline, but it must still
    // carry through byte-for-byte unescaped -- braces are ordinary CSS
    // syntax there, not something Astro's compiler ever sees or parses.
    const html =
      '<!DOCTYPE html><html><head>' +
      '<style>.foo { color: red; }</style>' +
      '</head><body></body></html>';
    const { outputDir } = await compileOnePage(html);
    const css = await readAllExtractedCss(outputDir);

    expect(css).toContain('.foo { color: red; }');
  });

  it('escapes braces in text content that sits between real script and extracted style tags', async () => {
    // Guards against an overly broad "skip everything near a script/style"
    // implementation that accidentally also skips ordinary text just
    // because it's a sibling of one.
    const html =
      '<!DOCTYPE html><html><head><style>.a{color:blue}</style></head>' +
      '<body><script>const z = {ok: true};</script><p>Use the {placeholder} syntax.</p></body></html>';
    const { astro, outputDir } = await compileOnePage(html);
    const css = await readAllExtractedCss(outputDir);

    expect(astro).toContain('const z = {ok: true};');
    expect(css).toContain('.a{color:blue}');
    expect(astro).toContain('Use the &#123;placeholder&#125; syntax.');
  });
});

describe('Astro format: cross-page CSS extraction', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function compilePages(pages: Record<string, string>): Promise<{ outputDir: string; pageSource: (route: string) => Promise<string> }> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-css-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, pages);
    return {
      outputDir,
      pageSource: (route: string) => fs.readFile(path.join(outputDir, 'src', 'pages', route), 'utf-8'),
    };
  }

  async function listStyleFiles(outputDir: string): Promise<string[]> {
    const stylesDir = path.join(outputDir, 'src', 'styles');
    const out: string[] = [];
    async function walk(dir: string, rel: string) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
        else out.push(relPath);
      }
    }
    await walk(stylesDir, '');
    return out;
  }

  it('collapses CSS identical across every page into one file under styles/global/', async () => {
    const shared = '.brand { color: coral; }';
    const page = (body: string) =>
      `<!DOCTYPE html><html><head><style>${shared}</style></head><body>${body}</body></html>`;
    const { outputDir } = await compilePages({
      '/': page('<p>Home</p>'),
      '/about': page('<p>About</p>'),
      '/contact': page('<p>Contact</p>'),
    });
    const files = await listStyleFiles(outputDir);
    const globalFiles = files.filter((f) => f.startsWith('global/'));
    expect(globalFiles.length).toBe(1);
    const content = await fs.readFile(path.join(outputDir, 'src', 'styles', globalFiles[0]!), 'utf-8');
    expect(content).toBe(shared);
  });

  it('places CSS shared by some (not all) pages under styles/shared/', async () => {
    const sharedByTwo = '.blog-post { font-style: italic; }';
    const page = (body: string, includeShared: boolean) =>
      `<!DOCTYPE html><html><head>${includeShared ? `<style>${sharedByTwo}</style>` : ''}</head><body>${body}</body></html>`;
    const { outputDir } = await compilePages({
      '/blog/one': page('<p>One</p>', true),
      '/blog/two': page('<p>Two</p>', true),
      '/about': page('<p>About</p>', false),
    });
    const files = await listStyleFiles(outputDir);
    expect(files.filter((f) => f.startsWith('shared/')).length).toBe(1);
    expect(files.filter((f) => f.startsWith('global/')).length).toBe(0);
  });

  it('files CSS unique to a single page under styles/pages/<route>/', async () => {
    const unique = '.hero-only { transform: rotate(3deg); }';
    const { outputDir } = await compilePages({
      '/': `<!DOCTYPE html><html><head><style>${unique}</style></head><body><p>Home</p></body></html>`,
      '/about': `<!DOCTYPE html><html><head></head><body><p>About</p></body></html>`,
    });
    const files = await listStyleFiles(outputDir);
    expect(files.some((f) => f.startsWith('pages/index/'))).toBe(true);
    expect(files.filter((f) => f.startsWith('global/') || f.startsWith('shared/')).length).toBe(0);
  });

  it('imports extracted CSS in the original per-page tag order (cascade-safe)', async () => {
    // Two style blocks per page: block A (shared with another page) then
    // block B (unique to this page) -- the frontmatter import order must
    // preserve A-then-B, since that's the cascade order the browser saw
    // in the captured HTML.
    const blockA = '.a-block { color: red; }';
    const blockB1 = '.b-block { color: blue; }';
    const blockB2 = '.b-block { color: green; }';
    const { outputDir, pageSource } = await compilePages({
      '/one': `<!DOCTYPE html><html><head><style>${blockA}</style><style>${blockB1}</style></head><body><p>One</p></body></html>`,
      '/two': `<!DOCTYPE html><html><head><style>${blockA}</style><style>${blockB2}</style></head><body><p>Two</p></body></html>`,
    });
    const files = await listStyleFiles(outputDir);
    // blockA is shared by both pages -> one file; blockB1/blockB2 differ -> two distinct page-specific files
    expect(files.filter((f) => f.startsWith('shared/') || f.startsWith('global/')).length).toBe(1);
    expect(files.filter((f) => f.startsWith('pages/'))).toHaveLength(2);

    const one = await pageSource('one.astro');
    const frontmatter = one.slice(0, one.indexOf('---', 3));
    const importLines = frontmatter.split('\n').filter((l) => l.startsWith('import'));
    expect(importLines).toHaveLength(2);
    // The shared block (A) must be imported before the page-specific block (B).
    expect(importLines[0]).toMatch(/shared|global/);
    expect(importLines[1]).toMatch(/pages\/one/);
  });

  it('adds no frontmatter import block for a page with zero <style> tags (Webflow-style external CSS)', async () => {
    // Webflow captures externalize almost all CSS via <link> already —
    // confirmed by measurement (tripora: ~2% of page bytes are inline
    // <style>, vs 60-78% on Framer captures). A page with no <style> tags
    // at all must pass through with no frontmatter added.
    const html =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/css/site.css"></head><body><p>Hi</p></body></html>';
    const { outputDir, pageSource } = await compilePages({ '/': html });
    const astro = await pageSource('index.astro');
    expect(astro.startsWith('---')).toBe(false);
    expect(astro).toContain('<link rel="stylesheet" href="/assets/css/site.css">');
    const files = await listStyleFiles(outputDir);
    expect(files).toHaveLength(0);
  });

  it('leaves empty <style> tags inline rather than extracting nothing', async () => {
    const html =
      '<!DOCTYPE html><html><head><style data-framer-css></style></head><body><p>Hi</p></body></html>';
    const { outputDir, pageSource } = await compilePages({ '/': html });
    const astro = await pageSource('index.astro');
    expect(astro).toContain('<style');
    expect(astro).toContain('is:global');
    const files = await listStyleFiles(outputDir);
    expect(files).toHaveLength(0);
  });
});

describe('Astro format: bake settled opacity for JS-controlled elements', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function compileOnePage(html: string): Promise<string> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-opacity-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, { '/test': html });
    return fs.readFile(path.join(outputDir, 'src', 'pages', 'test.astro'), 'utf-8');
  }

  it('forces opacity to 1 when exactly 0 (Framer Motion signature, not GSAP)', async () => {
    // Reproduces the real arkitect dark-screen bug verbatim: a full-screen
    // page-transition overlay, frozen at opacity:0 -- Framer Motion's own
    // inline-style shape, not GSAP's (no `translate: none` marker at all).
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div style="background-color: rgb(32, 37, 39); position: fixed; top: 0px; left: 0px; z-index: 13; opacity: 0; transform: translate(-50%, 0%);">Hi</div>' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).toContain('opacity: 1;');
    expect(astro).not.toContain('opacity: 0;');
  });

  it('forces opacity to 1 when partial AND will-change is present (entrance-reveal pattern)', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div style="will-change:transform;opacity:0.7284;transform:translateY(80px) scale(0.9)">Hi</div>' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).toContain('opacity: 1');
    expect(astro).not.toContain('opacity:0.7284');
  });

  it('leaves opacity alone when already 1', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div style="will-change: transform; opacity: 1;">Hi</div>' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).toContain('opacity: 1;');
  });

  it('does NOT touch partial opacity without will-change (legitimate design tint)', async () => {
    // Reproduces arkitect's real `.overlay`/`.desktop-overlay` elements:
    // a stable, hand-authored 0.1-0.2 background tint with no will-change
    // and no reveal-style transform -- forcing this to opacity:1 would
    // turn a subtle tint into a solid block.
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div class="overlay" style="background-color: rgb(24, 33, 45); opacity: 0.1;">Overlay</div>' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).toContain('opacity: 0.1;');
  });

  it('does NOT force opacity for a backdrop-filter load-transition curtain (bakery-co regression)', async () => {
    // Real bug: a full-viewport backdrop-filter:blur(...) curtain was
    // captured correctly already-settled at opacity:0 (its correct
    // RESTING state -- unlike an entrance-reveal element, this fades OUT
    // to reveal the page, so opacity:0 is where it's supposed to end up).
    // Bare opacity:0 with no will-change is otherwise indistinguishable at
    // the DOM level from a genuinely-stuck entrance-reveal, so
    // backdrop-filter is the signal that separates them: it's a
    // glassmorphism/veil effect, never meaningful on real page content.
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div data-framer-name="Overlay" style="backdrop-filter:blur(10px);background-color:rgba(255,255,255,0.2);-webkit-backdrop-filter:blur(10px);opacity: 0;">Hi</div>' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).toContain('opacity: 0;');
    expect(astro).not.toContain('opacity: 1;');
  });

  it('does not disturb the transform on a baked element (left to runtime modules)', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div style="will-change:transform;opacity:0;transform:translateY(80px) scale(0.9)">Hi</div>' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).toContain('transform:translateY(80px) scale(0.9)');
    expect(astro).toContain('opacity: 1');
  });
});

describe('Astro format: orphaned-image safety net (lost CSS-in-JS/hydration styling)', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function compileOnePage(html: string): Promise<string> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-orphan-img-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, { '/test': html });
    return fs.readFile(path.join(outputDir, 'src', 'pages', 'test.astro'), 'utf-8');
  }

  it('constrains an <img> whose class matches zero known CSS (dermato regression)', async () => {
    // Reproduces the real dermato bug verbatim: a Framer "before/after"
    // code component styled via Emotion CSS-in-JS injected at hydration
    // time -- a mechanism the static crawler can't see into, so its
    // hash-named class ships with zero matching CSS anywhere. Left alone,
    // the image renders at its raw file dimensions (1440x1920) and, being
    // position:static, that height counts in normal document flow,
    // ballooning the containing section by thousands of pixels.
    const html =
      '<!DOCTYPE html><html><head><style>.some-other-class { color: red; }</style></head><body>' +
      '<img src="/assets/images/photo.avif" class="css-rs75p9" alt="">' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).toContain('max-width: 100%; height: auto;');
  });

  it('leaves an <img> alone when its class has a matching CSS rule', async () => {
    const html =
      '<!DOCTYPE html><html><head><style>.hero-photo { width: 400px; }</style></head><body>' +
      '<img src="/assets/images/photo.avif" class="hero-photo" alt="">' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).not.toContain('max-width: 100%; height: auto;');
  });

  it('leaves a classless <img> alone (not the failure pattern this targets)', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<img src="/assets/images/photo.avif" alt="">' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).not.toContain('max-width: 100%; height: auto;');
  });

  it('leaves an orphaned <img> alone when it already has explicit sizing', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<img src="/assets/images/photo.avif" class="css-rs75p9" width="400" height="300" alt="">' +
      '<img src="/assets/images/photo2.avif" class="css-other" style="width: 200px;" alt="">' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).not.toContain('max-width: 100%; height: auto;');
  });

  it('matches a class referenced by any compound selector, not just a bare .class rule', async () => {
    const html =
      '<!DOCTYPE html><html><head><style>.card:hover .thumb { opacity: 0.8; }</style></head><body>' +
      '<img src="/assets/images/photo.avif" class="thumb" alt="">' +
      '</body></html>';
    const astro = await compileOnePage(html);
    expect(astro).not.toContain('max-width: 100%; height: auto;');
  });
});

describe('Astro format: resolves Framer relative hrefs to absolute paths', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function compilePageAtRoute(route: string, html: string): Promise<string> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-href-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, { [route]: html });
    const filename = routeToAstroFilename(route);
    return fs.readFile(path.join(outputDir, 'src', 'pages', filename), 'utf-8');
  }

  it('resolves ../about from a one-level-nested page to /about, not /blog/about (real arkitect bug)', async () => {
    // Reproduces the real, confirmed-live navigation bug verbatim: Framer
    // captures relative hrefs assuming a flatter routing model than
    // Astro's actual <route>/index.html static output, so a naive
    // directory-style relative resolution (what a real deployed static
    // file server does) sends this link to the wrong destination.
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<a href="../about">About</a>' +
      '</body></html>';
    const astro = await compilePageAtRoute('/blog/some-post', html);
    expect(astro).toContain('href="/about"');
    expect(astro).not.toContain('href="../about"');
  });

  it('resolves ../../ from a two-level-nested page to the site root', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<a href="../../">Home</a>' +
      '</body></html>';
    const astro = await compilePageAtRoute('/blog/category/architecture', html);
    expect(astro).toContain('href="/"');
  });

  it('resolves a same-level ./ reference relative to its own section, not the site root', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<a href="./category/design">Design</a>' +
      '</body></html>';
    const astro = await compilePageAtRoute('/blog/some-post', html);
    expect(astro).toContain('href="/blog/category/design"');
  });

  it('leaves absolute paths, external URLs, and special schemes untouched', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<a href="/about">About</a>' +
      '<a href="https://example.com/">External</a>' +
      '<a href="mailto:hello@example.com">Email</a>' +
      '<a href="tel:+1234567890">Call</a>' +
      '<a href="#section">Anchor</a>' +
      '</body></html>';
    const astro = await compilePageAtRoute('/blog/some-post', html);
    expect(astro).toContain('href="/about"');
    expect(astro).toContain('href="https://example.com/"');
    expect(astro).toContain('href="mailto:hello@example.com"');
    expect(astro).toContain('href="tel:+1234567890"');
    expect(astro).toContain('href="#section"');
  });
});

describe('Astro format: uncage-runtime widget injection', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function compilePage(html: string): Promise<{ astro: string; outputDir: string }> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-runtime-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, { '/test': html });
    const astro = await fs.readFile(path.join(outputDir, 'src', 'pages', 'test.astro'), 'utf-8');
    return { astro, outputDir };
  }

  it('injects a script tag and copies the runtime file for a detected widget', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div class="w-slider"><div class="w-slide">A</div><div class="w-slide">B</div></div>' +
      '</body></html>';
    const { astro, outputDir } = await compilePage(html);
    expect(astro).toContain('src="/assets/js/uncage-runtime/carousel.js"');
    const copied = await fs.readFile(path.join(outputDir, 'public', 'assets', 'js', 'uncage-runtime', 'carousel.js'), 'utf-8');
    expect(copied.length).toBeGreaterThan(0);
  });

  it('injects nothing for a page with no detected widgets', async () => {
    const html = '<!DOCTYPE html><html><head></head><body><p>Plain content</p></body></html>';
    const { astro, outputDir } = await compilePage(html);
    expect(astro).not.toContain('uncage-runtime');
    await expect(fs.access(path.join(outputDir, 'public', 'assets', 'js', 'uncage-runtime'))).rejects.toThrow();
  });

  it('injects multiple scripts when a page has multiple detected widgets', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div class="w-slider"><div class="w-slide">A</div><div class="w-slide">B</div></div>' +
      '<div role="tab">Tab</div>' +
      '<div data-framer-cursor="grab">Grabbable</div>' +
      '</body></html>';
    const { astro } = await compilePage(html);
    expect(astro).toContain('uncage-runtime/carousel.js');
    expect(astro).toContain('uncage-runtime/tabs.js');
    expect(astro).toContain('uncage-runtime/custom-cursor.js');
  });

  it('places injected scripts before the closing </body> tag', async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div class="w-slider"><div class="w-slide">A</div><div class="w-slide">B</div></div>' +
      '</body></html>';
    const { astro } = await compilePage(html);
    const scriptIdx = astro.indexOf('uncage-runtime/carousel.js');
    const bodyCloseIdx = astro.lastIndexOf('</body>');
    expect(scriptIdx).toBeGreaterThan(0);
    expect(scriptIdx).toBeLessThan(bodyCloseIdx);
  });

  it('inserts before the REAL closing </body> tag, not a fake one embedded in third-party script text', async () => {
    // Reproduces a real bug found live on a Webflow template (linoxa):
    // a third-party promo widget's own bundled script carried a
    // developer-instructions comment that itself contained the literal
    // text "</body>" as example text (documenting where a site owner
    // should paste an embed snippet). A naive first-match string
    // replace spliced the widget scripts into that fake occurrence
    // instead of the page's real closing tag, leaving the actual
    // </body> untouched later in the document -- two </body> for one
    // <body>, which fails Astro's compiler.
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div class="w-slider"><div class="w-slide">A</div><div class="w-slide">B</div></div>' +
      '<script>/* ADD IT: one line before your own script tag </body> on any template */</script>' +
      '</body></html>';
    const { astro } = await compilePage(html);
    // The fake </body> text inside the script comment is untouched inert
    // content -- still one literal occurrence, plus the real closing tag,
    // so two raw substring matches is correct and expected here. What
    // actually matters: the injected script lands after the FAKE
    // occurrence (proving it wasn't spliced into the comment text, which
    // is where the bug put it) and before the REAL one (proving it
    // targets the page's actual closing tag).
    const fakeBodyIdx = astro.indexOf('on any template');
    const scriptIdx = astro.indexOf('uncage-runtime/carousel.js');
    const realBodyCloseIdx = astro.lastIndexOf('</body>');
    expect(fakeBodyIdx).toBeGreaterThan(0);
    expect(scriptIdx).toBeGreaterThan(fakeBodyIdx);
    expect(scriptIdx).toBeLessThan(realBodyCloseIdx);
  });
});

describe('Astro format: strip Framer/Webflow hydration JS', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function compilePage(html: string): Promise<string> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-strip-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, { '/test': html });
    return fs.readFile(path.join(outputDir, 'src', 'pages', 'test.astro'), 'utf-8');
  }

  it('removes Framer\'s single bundled entry point (data-framer-bundle="main")', async () => {
    const html =
      '<!DOCTYPE html><html><head>' +
      '<script is:inline type="module" async data-framer-bundle="main" fetchpriority="low" src="/assets/js/script_main.B-sOw9dJ.js"></script>' +
      '</head><body><p>Hi</p></body></html>';
    const astro = await compilePage(html);
    expect(astro).not.toContain('script_main');
    expect(astro).not.toContain('data-framer-bundle');
  });

  it('removes modulepreload hints -- the script tag alone is not enough', async () => {
    // Confirmed live on a real re-crawl of arkitect: removing only the
    // <script data-framer-bundle> tag still triggered ~33 JS requests in
    // a real browser (react, framer, motion, every component chunk),
    // because Framer's Vite-family bundler also emits one
    // <link rel="modulepreload"> per chunk, and browsers honor that
    // fetch hint independently of whether the <script> that would have
    // imported it still exists.
    const html =
      '<!DOCTYPE html><html><head>' +
      '<script is:inline type="module" async data-framer-bundle="main" src="/assets/js/script_main.js"></script>' +
      '<link rel="modulepreload" fetchpriority="low" href="/assets/js/react.BvLYqtUI-a0c5ac99.js">' +
      '<link rel="modulepreload" fetchpriority="low" href="/assets/js/motion.BauDcWPd-6cbf5fb3.js">' +
      '</head><body><p>Hi</p></body></html>';
    const astro = await compilePage(html);
    expect(astro).not.toContain('modulepreload');
    expect(astro).not.toContain('react.BvLYqtUI');
    expect(astro).not.toContain('motion.BauDcWPd');
  });

  it('removes Webflow\'s core webflow.schunk.*.js and webflow.<hash>.*.js bundles', async () => {
    const html =
      '<!DOCTYPE html><html><head>' +
      '<script is:inline src="/assets/js/webflow.schunk.36b8fb49256177c8-59fdaf6c.js" type="text/javascript"></script>' +
      '<script is:inline src="/assets/js/webflow.7ee31ada.510e32fc05d62c78-a2665445.js" type="text/javascript"></script>' +
      '</head><body><p>Hi</p></body></html>';
    const astro = await compilePage(html);
    expect(astro).not.toContain('webflow.schunk');
    expect(astro).not.toContain('webflow.7ee31ada');
  });

  it('does NOT remove webfont loader (name collision risk: webfont vs webflow)', async () => {
    const html =
      '<!DOCTYPE html><html><head>' +
      '<script is:inline src="/assets/js/webfont-3a3adf98.js" type="text/javascript"></script>' +
      '</head><body><p>Hi</p></body></html>';
    const astro = await compilePage(html);
    expect(astro).toContain('webfont-3a3adf98.js');
  });

  it('does NOT remove jQuery, GSAP, Lenis, or other third-party dependencies', async () => {
    const html =
      '<!DOCTYPE html><html><head>' +
      '<script is:inline src="/assets/js/jquery-3.5.1.min.js" type="text/javascript"></script>' +
      '<script is:inline src="/assets/js/gsap.min-8e6c1f2e.js" type="text/javascript"></script>' +
      '<script is:inline src="/assets/js/ScrollTrigger.min-3b699995.js" type="text/javascript"></script>' +
      '<script is:inline src="/assets/js/lenis.min-6c2b1660.js" type="text/javascript"></script>' +
      '</head><body><p>Hi</p></body></html>';
    const astro = await compilePage(html);
    expect(astro).toContain('jquery-3.5.1.min.js');
    expect(astro).toContain('gsap.min-8e6c1f2e.js');
    expect(astro).toContain('ScrollTrigger.min-3b699995.js');
    expect(astro).toContain('lenis.min-6c2b1660.js');
  });

  it('does not disturb the injected uncage-runtime scripts', async () => {
    const html =
      '<!DOCTYPE html><html><head>' +
      '<script is:inline type="module" async data-framer-bundle="main" src="/assets/js/script_main.js"></script>' +
      '</head><body>' +
      '<div class="w-slider"><div class="w-slide">A</div><div class="w-slide">B</div></div>' +
      '</body></html>';
    const astro = await compilePage(html);
    expect(astro).not.toContain('script_main');
    expect(astro).toContain('uncage-runtime/carousel.js');
  });
});
