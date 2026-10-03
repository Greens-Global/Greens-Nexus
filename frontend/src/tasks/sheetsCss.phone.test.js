import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

// The phone rules behind the sheet / bottom-bar pass. jsdom does not apply
// media queries, so these pin the rules themselves.

const block = (re) => {
  const m = css.match(re);
  return m ? m[0] : '';
};

describe('phone CSS for sheets and the floating bar', () => {
  it('the generic bottom-sheet dialog rules skip .nx-sheet and .guided-tour', () => {
    const rules = css.split('\n').filter((l) => l.trim().startsWith('[role="dialog"]'));
    expect(rules.length).toBeGreaterThanOrEqual(3);
    rules.forEach((l) => {
      expect(l).toContain(':not(.nx-sheet)');
      expect(l).toContain(':not(.guided-tour)');
    });
  });

  it('reserves room for the bottom nav only when the nav is rendered', () => {
    expect(css).toMatch(/\.mobile-nav ~ \.main-content \{ padding-bottom: calc\(64px \+ env\(safe-area-inset-bottom\)\); \}/);
    expect(css).not.toMatch(/^\s*\.main-content \{ padding-bottom: calc\(64px/m);
  });

  it('.nx-gutter leaves the bottom padding to the page body', () => {
    const rules = css.split('\n').filter((l) => /^\s*\.nx-gutter\b/.test(l));
    expect(rules.length).toBeGreaterThan(0);
    rules.forEach((l) => {
      expect(l).not.toMatch(/padding:\s*8px 0/);
      expect(l).not.toMatch(/padding-bottom/);
    });
  });

  it('the rich-text editor is 16px on phones (no iOS focus zoom)', () => {
    const phone = block(/@media \(max-width: 640px\) \{\s*\.nx-rich \.ProseMirror \{ font-size: 16px; \}\s*\}/);
    expect(phone).not.toBe('');
  });
});
