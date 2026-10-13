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
// attribute rule covers them. The two asset/ files are his too by authorship
// (Oct 12: left for him rather than edited here). Drop an entry once its
// owner removes the reset.
const OWNER_HELD = new Set([
  'views/InventoryManagement.jsx',
  'components/Assignments.jsx',
  'asset/components/asset/AddAssetModal.jsx',
  'asset/components/shared/FieldInput.jsx',
]);

// Every spelling of an inline reset: outline 'none' / 0 / '0' / '0px', and
// outlineStyle 'none'. An `outline: 0` is written as "outline: 0px" and the
// attribute rule in style.css would not catch it, so it is banned outright.
const INLINE_RESET = /\boutline:\s*(['"]none['"]|0(?![.\d])|['"]0(px)?['"])|\boutlineStyle:\s*['"]none['"]/;

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
      if (INLINE_RESET.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the offender pattern catches every inline spelling and leaves real outlines alone', () => {
    for (const bad of ["outline: 'none'", 'outline:"none"', 'outline: 0,', 'outline: 0 }', "outline: '0'", "outline: '0px'", "outlineStyle: 'none'"]) {
      expect(INLINE_RESET.test(`style={{ ${bad} }}`), bad).toBe(true);
    }
    for (const ok of ["outline: '2px solid red'", 'outline: 0.5,', 'outlineOffset: 0', "outline: `1px solid ${c}`"]) {
      expect(INLINE_RESET.test(`style={{ ${ok} }}`), ok).toBe(false);
    }
  });
});
