import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { astroStrategy } from './astro.js';

describe('Astro format: curly-brace escaping in text content', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function compileOnePage(html: string): Promise<string> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncage-astro-test-'));
    tmpDirs.push(outputDir);
    await astroStrategy.compile(outputDir, { '/test': html });
    return fs.readFile(path.join(outputDir, 'src', 'pages', 'test.astro'), 'utf-8');
  }

  it('escapes literal curly braces in ordinary text content', async () => {
    // Reproduces the real failure: a Webflow template's own documentation
    // page displayed example init code ("new Lenis({...})") as plain text,
    // and Astro's compiler -- which treats a bare `{` in HTML body content
    // as the start of a JS expression, same rule as JSX -- failed the whole
    // build with "Unexpected token" over it.
    const html = '<!DOCTYPE html><html><head></head><body><p>new Lenis({smooth: true})</p></body></html>';
    const astro = await compileOnePage(html);

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
    const astro = await compileOnePage(html);

    expect(astro).toContain('function f(x){ if (x) { return {a: 1} } }');
  });

  it('does NOT escape braces inside <style> content', async () => {
    const html =
      '<!DOCTYPE html><html><head>' +
      '<style>.foo { color: red; }</style>' +
      '</head><body></body></html>';
    const astro = await compileOnePage(html);

    expect(astro).toContain('.foo { color: red; }');
  });

  it('escapes braces in text content that sits between real script and style tags', async () => {
    // Guards against an overly broad "skip everything near a script/style"
    // implementation that accidentally also skips ordinary text just
    // because it's a sibling of one.
    const html =
      '<!DOCTYPE html><html><head><style>.a{color:blue}</style></head>' +
      '<body><script>const z = {ok: true};</script><p>Use the {placeholder} syntax.</p></body></html>';
    const astro = await compileOnePage(html);

    expect(astro).toContain('const z = {ok: true};');
    expect(astro).toContain('.a{color:blue}');
    expect(astro).toContain('Use the &#123;placeholder&#125; syntax.');
  });
});
