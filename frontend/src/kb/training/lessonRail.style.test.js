import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '..', 'kb.css'), 'utf8');

// The course rail's selected lesson in dark mode (11/02/2026): it was a fixed
// light green (#e3f1e8) under the light ink of dark mode - white text on a
// pale block. The wash is now mixed over the card, so it darkens with it.
describe('kb selected lesson', () => {
  it('mixes the green wash over the card instead of a fixed light color', () => {
    expect(css).toMatch(/--kb-green-soft:\s*color-mix\(in srgb, var\(--kb-green\) 12%, var\(--kb-card\)\)/);
    const rule = css.match(/\.kb \.kb-lesson\.on \{[^}]*\}/)[0];
    expect(rule).toContain('var(--kb-green-soft)');
    expect(rule).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
