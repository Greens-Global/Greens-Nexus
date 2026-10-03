import { describe, it, expect } from 'vitest';
import { sanitizeRichHtml, richBodyHtml, isSafeRichUrl } from './lib';
import { VIEW_PREFIX } from '../lib/storageView';

// The rich-body sanitizer keeps the app's own file-viewer URLs - the form
// api.js rewrites every private-bucket picture to - and nothing broader.
const CANON = 'https://proj.supabase.co/storage/v1/object/public/task-files/abc/photo 1.jpg';
const ENC = encodeURIComponent(CANON);
const HOSTED = `/api/files/view?u=${ENC}`;
const srcOf = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.querySelector('img')?.getAttribute('src') ?? null;
};
const hrefOf = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.querySelector('a')?.getAttribute('href') ?? null;
};

describe('sanitizer: allowed URLs', () => {
  it('keeps a picture behind the hosted, relative viewer', () => {
    expect(srcOf(sanitizeRichHtml(`<p>x</p><img src="${HOSTED}">`))).toBe(HOSTED);
  });

  it('keeps the viewer URL this build produces (local: absolute API base)', () => {
    const u = `${VIEW_PREFIX}${ENC}`;
    expect(srcOf(sanitizeRichHtml(`<img src="${u}">`))).toBe(u);
  });

  it('keeps a download link through the viewer', () => {
    const u = `${HOSTED}&download=1`;
    expect(hrefOf(sanitizeRichHtml(`<a href="${u.replace(/&/g, '&amp;')}">f.pdf</a>`))).toBe(u);
  });

  it('richBodyHtml (ticket description, snapshot, task comments) keeps it too', () => {
    expect(srcOf(richBodyHtml(`<p>see</p><img src="${HOSTED}">`))).toBe(HOSTED);
  });

  it('still keeps https:, mailto: and data:image/', () => {
    expect(srcOf(sanitizeRichHtml('<img src="https://example.com/a.png">'))).toBe('https://example.com/a.png');
    expect(srcOf(sanitizeRichHtml('<img src="data:image/png;base64,AAAA">'))).toBe('data:image/png;base64,AAAA');
    expect(hrefOf(sanitizeRichHtml('<a href="mailto:a@b.com">a</a>'))).toBe('mailto:a@b.com');
  });
});

describe('sanitizer: hostile URLs', () => {
  const bad = [
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    '/api/files/view',                              // no ?u=
    '/api/files/view?u=',                           // nothing to view
    '/api/files/viewx?u=a',
    '/api/other?u=a',
    '/files/view/../../evil?u=a',
    '//evil.example/api/files/view?u=a',
    '/\\evil.example/api/files/view?u=a',
    '/api/files/view?u=a"onerror="alert(1)',
    "/api/files/view?u=a' onerror='alert(1)",
    '/api/files/view?u=a b',
    '/api/files/view?u=a\\b',
    '/api/files/view?u=<x>',
    '../api/files/view?u=a',
    'api/files/view?u=a',
    '/admin',
  ];
  it.each(bad)('rejects %s', (u) => {
    expect(isSafeRichUrl(u)).toBe(false);
  });

  it('strips a hostile src and href from rendered HTML', () => {
    const html = sanitizeRichHtml('<img src="javascript:alert(1)" onerror="alert(1)"><a href="/api/files/view?u=a b">x</a>');
    expect(html).not.toMatch(/javascript|onerror|href=/i);
  });

  it('does not let a viewer URL smuggle an event handler', () => {
    const html = sanitizeRichHtml(`<img src="${HOSTED}" onerror="alert(1)" onload="alert(2)">`);
    expect(html).not.toMatch(/onerror|onload/i);
    expect(srcOf(html)).toBe(HOSTED);
  });
});
