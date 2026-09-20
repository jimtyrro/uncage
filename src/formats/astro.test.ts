import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { astroStrategy, routeToAstroFilename, collapseSelfNestedSplit } from './astro.js';

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

describe('Astro format: collapseSelfNestedSplit (SplitText duplicate-DOM runtime guard)', () => {
  // A minimal fake DOM: just enough surface (nodeType, className,
  // children, parentNode.replaceChild) for collapseSelfNestedSplit to
  // operate on, without needing a real browser or jsdom. This is the
  // exact function embedded verbatim (via .toString()) into the shipped
  // runtime guard script -- these tests exercise the real, shipped logic.
  class FakeElement {
    nodeType = 1;
    className: string;
    children: FakeElement[] = [];
    parentNode: { replaceChild(next: FakeElement, prev: FakeElement): void } | null = null;
    text?: string;
    constructor(className: string, text?: string) {
      this.className = className;
      if (text !== undefined) this.text = text;
    }
  }

  function attach(parent: FakeElement, child: FakeElement): FakeElement {
    child.parentNode = {
      replaceChild: (next, prev) => {
        const idx = parent.children.indexOf(prev);
        if (idx !== -1) parent.children[idx] = next;
        next.parentNode = prev.parentNode;
      },
    };
    parent.children.push(child);
    return child;
  }

  // Builds a chain of single-child wrapper elements, outermost first,
  // matching the real shape a re-split produces: an outer element (stuck
  // pre-reveal) whose single-child descent chain leads to an inner
  // element sharing the OUTER's exact class (correctly revealed).
  function selfNestedChain(outerClass: string, innerWrapperClasses: string[], leafText: string): FakeElement {
    const outer = new FakeElement(outerClass);
    let cur = outer;
    for (const cls of innerWrapperClasses) {
      cur = attach(cur, new FakeElement(cls));
    }
    attach(cur, new FakeElement(outerClass, leafText)); // the matching inner twin
    return outer;
  }

  it('collapses a self-nested letter (real linoxa bug: re-split wrapped its own prior output)', () => {
    // Reproduces the real, confirmed-live structure: outer letter1 (stuck
    // pre-reveal) has, as its only descendant chain, a fresh word1 >
    // letter1-mask > letter1 (revealed) -- the re-split treated the
    // already-split "S" content as plain text and wrapped it again.
    const outer = selfNestedChain(
      'gsap_split_letter gsap_split_letter1',
      ['gsap_split_word gsap_split_word1', 'gsap_split_letter-mask gsap_split_letter1-mask'],
      'S'
    );
    const root = new FakeElement('root');
    attach(root, outer);

    collapseSelfNestedSplit(root);

    expect(root.children.length).toBe(1);
    expect(root.children[0]!.className).toBe('gsap_split_letter gsap_split_letter1');
    // The kept element is the INNER (revealed) twin, not the outer wrapper chain.
    expect(root.children[0]!.text).toBe('S');
  });

  it('collapses each letter of a full word independently, without discarding sibling letters', () => {
    // The real bug in an earlier version of this fix: anchoring the
    // search on a multi-child word's arbitrary first child found a match
    // belonging to only that one letter, and hoisted it to replace the
    // WHOLE word -- silently deleting the word's other letters. A word
    // has several sibling letter-masks; each is independently self-nested
    // (or not) and must be resolved on its own.
    const word = new FakeElement('gsap_split_word gsap_split_word1');
    const letters = ['S', 't', 'a', 'y'];
    for (let i = 0; i < letters.length; i++) {
      const maskClass = `gsap_split_letter-mask gsap_split_letter${i + 1}-mask`;
      const mask = selfNestedChain(maskClass, ['gsap_split_letter gsap_split_letter' + (i + 1)], letters[i]!);
      attach(word, mask);
    }

    collapseSelfNestedSplit(word);

    expect(word.children.length).toBe(4);
    expect(word.children.map((c) => c.text)).toEqual(['S', 't', 'a', 'y']);
  });

  it('does NOT touch legitimate single-child wrapper chains unrelated to "split" (e.g. an icon-in-button wrapper)', () => {
    const outer = new FakeElement('btn-icon-wrap');
    const inner = attach(outer, new FakeElement('btn-icon-wrap'));
    attach(inner, new FakeElement('svg-icon', 'icon'));
    const root = new FakeElement('root');
    attach(root, outer);

    collapseSelfNestedSplit(root);

    // Unchanged -- no "split" in the class name, even though the shape
    // (single-child chain ending in an identical class) looks similar.
    expect(root.children[0]).toBe(outer);
  });

  it('does NOT touch a branching (multi-child) split element -- only single-child wrapper chains are candidates', () => {
    // A word with several distinct sibling letters (no duplication) must
    // never be treated as self-nested just because it contains "split"
    // and a numbered class.
    const word = new FakeElement('gsap_split_word gsap_split_word1');
    attach(word, new FakeElement('gsap_split_letter gsap_split_letter1', 'S'));
    attach(word, new FakeElement('gsap_split_letter gsap_split_letter2', 't'));
    const root = new FakeElement('root');
    attach(root, word);

    collapseSelfNestedSplit(root);

    expect(root.children[0]).toBe(word);
    expect(word.children.length).toBe(2);
  });

  it('does NOT touch a normal, non-duplicated split heading (no nested twin anywhere in the chain)', () => {
    const letter = new FakeElement('gsap_split_letter gsap_split_letter1');
    attach(letter, new FakeElement('plain-text-node', 'S'));
    const root = new FakeElement('root');
    attach(root, letter);

    collapseSelfNestedSplit(root);

    expect(root.children[0]).toBe(letter);
  });
});

describe('Astro format: SplitText duplicate-DOM guard script wiring', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('injects the collapseSelfNestedSplit guard into every compiled page', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-splitguard-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, { '/test': '<!DOCTYPE html><html><head></head><body></body></html>' });
    const astro = await fs.readFile(path.join(outputDir, 'src', 'pages', 'test.astro'), 'utf-8');

    // The embedded function source must actually be present (proves the
    // .toString() embedding, not just some unrelated guard script).
    expect(astro).toContain('collapseSelfNestedSplit');
    expect(astro).toContain('MutationObserver');
  });
});
