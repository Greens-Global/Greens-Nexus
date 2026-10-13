import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Press feedback (Oct 11, 2026): the shared button classes answer a press with
// a small scale and sit still under reduced motion. jsdom does not apply CSS,
// so these pin the rules themselves.
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

describe('press feedback on the shared buttons', () => {
  it('primary, secondary and icon buttons scale on :active unless disabled', () => {
    expect(css).toMatch(/\.primary-btn:active:not\(:disabled\), \.btn-primary:active:not\(:disabled\),\n\.secondary-btn:active:not\(:disabled\), \.btn-sm:active:not\(:disabled\) \{ transform: scale\(\.97\); \}/);
    expect(css).toMatch(/\.icon-btn:active:not\(:disabled\) \{ transform: scale\(\.92\); \}/);
    expect(css).toMatch(/\.hdr-tab:active, \.module-tab-inline-btn:active \{ transform: scale\(\.96\); \}/);
  });

  it('releases over the --dur-xs token on every class that presses', () => {
    for (const cls of ['.primary-btn, .btn-primary', '.secondary-btn, .btn-sm', '.icon-btn', '.hdr-tab', '.module-tab-inline-btn']) {
      const re = new RegExp(`^${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{ transition: [^}]*transform var\\(--dur-xs\\) var\\(--ease-standard\\)`, 'm');
      expect(css, cls).toMatch(re);
    }
  });

  it('holds still under reduced motion', () => {
    const block = css.slice(css.indexOf('/* Press feedback'));
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\.primary-btn:active, \.btn-primary:active, \.secondary-btn:active, \.btn-sm:active,\n {2}\.icon-btn:active, \.hdr-tab:active, \.module-tab-inline-btn:active \{ transform: none; \}\n\}/);
  });
});
