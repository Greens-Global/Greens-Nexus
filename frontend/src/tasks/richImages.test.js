import { describe, it, expect } from 'vitest';
import { sanitizeRichHtml } from './lib';
import { VIEW_PREFIX, isOwnImageUrl } from '../lib/storageView';

// Rich bodies load images only from our own storage (Oct 2026 ticket review):
// a remote <img> loads for every reader the moment the body renders, so it is
// shown as a link to the image instead.

const canonical = 'https://x.supabase.co/storage/v1/object/public/ticket-evidence/a.png';
const viewerPath = (() => { try { const p = new URL(VIEW_PREFIX); return `${p.pathname}${p.search}`; } catch { return VIEW_PREFIX; } })();

describe('sanitizeRichHtml - images', () => {
  it('keeps our own viewer URLs and inline pastes', () => {
    const html = `<p>a</p><img src="${VIEW_PREFIX}${encodeURIComponent(canonical)}"><img src="data:image/png;base64,AAAA">`;
    expect((sanitizeRichHtml(html).match(/<img /g) || []).length).toBe(2);
  });

  it('keeps the viewer URL on this page\'s own origin (an image copied from another Nexus page)', () => {
    const src = `${window.location.origin}${viewerPath}${encodeURIComponent(canonical)}`;
    expect(isOwnImageUrl(src)).toBe(true);
    expect(sanitizeRichHtml(`<img src="${src}">`)).toContain('<img ');
  });

  it('turns a remote image into a link that loads nothing on its own', () => {
    const out = sanitizeRichHtml('<p>see</p><img src="https://tracker.example.com/pixel.gif" alt="chart">');
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://tracker.example.com/pixel.gif"');
    expect(out).toContain('[Image: chart]');
  });

  it('refuses a backslash path, which browsers read as another site', () => {
    expect(isOwnImageUrl('/\\evil.com/p.png')).toBe(false);
    expect(isOwnImageUrl(`${VIEW_PREFIX}\\evil`)).toBe(false);
    expect(sanitizeRichHtml('<img src="/\\evil.com/p.png">')).not.toContain('<img src');
  });

  it('refuses any other same-origin path - an image request carries the session', () => {
    expect(isOwnImageUrl('/api/auth/logout')).toBe(false);
    expect(isOwnImageUrl(`${window.location.origin}/api/auth/logout`)).toBe(false);
    expect(sanitizeRichHtml('<img src="/api/auth/logout">')).not.toContain('<img src');
  });
});
