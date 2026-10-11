import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Keyboard focus is always visible (Oct 11, 2026). Two guards:
//   1. style.css keeps the app-wide :focus-visible ring and the attribute rule
//      that restores it under an inline `outline: none` reset.
//   2. No source file outside the two owner-held files reintroduces that
//      inline reset - an inline style has no :focus-visible, so a control
//      carrying it shows no keyboard focus at all unless rule 1 catches it.

const SRC = __dirname;
const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');

// Visesh's files (CLAUDE.md "File ownership") still carry the reset; the CSS
// attribute rule covers them. Drop an entry here once its owner removes it.
const OWNER_HELD = new Set([
  'views/InventoryManagement.jsx',
  'components/Assignments.jsx',
]);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe('keyboard focus ring', () => {
  it('style.css defines the ring with the --focus-ring token in both themes', () => {
    expect(css).toMatch(/^:focus-visible \{ outline: 2px solid var\(--focus-ring\); outline-offset: 2px; \}/m);
    expect((css.match(/--focus-ring:/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('an inline outline:none reset cannot hide keyboard focus', () => {
    expect(css).toMatch(/\[style\*="outline: none"\]:focus-visible, \[style\*="outline:none"\]:focus-visible \{ outline: 2px solid var\(--focus-ring\) !important;/);
  });

  it('no source file outside the owner-held list uses an inline outline:none', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      if (OWNER_HELD.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/outline:\s*['"]none['"]/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
