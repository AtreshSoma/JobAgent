/**
 * The /learn mini-site is served under the dashboard's CSP (`script-src 'self'`),
 * which refuses inline event handlers. Every `onclick="location.hash=…"` in it
 * was therefore dead: the path cards, the hero buttons and the brand all looked
 * clickable and did nothing. Navigation is plain hash links now, which need no
 * script at all — this keeps it that way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../../src/dashboard/public/learn/', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');
const scripts = readdirSync(new URL('assets/js/', dir))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(new URL(`assets/js/${f}`, dir), 'utf8'));

// Strip comments so prose ABOUT the old pattern does not trip the check.
const code = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('/learn works under script-src self', () => {
  it('has no inline on* handler attributes in the shell', () => {
    expect(code(html).match(/\son[a-z]+\s*=/gi) ?? []).toEqual([]);
  });

  it('renders no inline on* handlers from its templates', () => {
    for (const source of scripts) {
      expect(code(source)).not.toMatch(/\son(?:click|change|input|submit|keydown)\s*=\s*["'`]/);
    }
  });

  it('navigates with real hash links', () => {
    const app = scripts.join('\n');
    expect(html).toContain('<a class="brand" href="#/home"');
    expect(app).toContain('<a class="path-card" href="#/${m.id}">');
    expect(app).toContain('href="#/intro/welcome"');
    expect(app).toContain('href="#/intro/market"');
  });
});
