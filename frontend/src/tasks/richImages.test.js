import { describe, it, expect } from 'vitest';
import { sanitizeRichHtml } from './lib';
import { VIEW_PREFIX } from '../lib/storageView';

// Rich bodies load images only from our own storage (Oct 2026 ticket review):
// a remote <img> loads for every reader the moment the body renders, so it is
// shown as a link to the image instead.

describe('sanitizeRichHtml - images', () => {
  it("keeps our own viewer URLs (absolute or same-origin) and inline pastes", () => {
    const viewer = `${VIEW_PREFIX}${encodeURIComponent('https://x.supabase.co/storage/v1/object/public/ticket-evidence/a.png')}`;
    const html = `<p>a</p><img src="${viewer}"><img src="/api/files/view?u=x"><img src="data:image/png;base64,AAAA">`;
    const out = sanitizeRichHtml(html);
    expect((out.match(/<img /g) || []).length).toBe(3);
  });

  it('turns a remote image into a link that loads nothing on its own', () => {
    const out = sanitizeRichHtml('<p>see</p><img src="https://tracker.example.com/pixel.gif" alt="chart">');
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://tracker.example.com/pixel.gif"');
    expect(out).toContain('[Image: chart]');
  });
});
