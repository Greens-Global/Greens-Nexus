import { describe, it, expect } from 'vitest';
import { absolutizeViewUrls } from './richViewUrls';
import { sanitizeRichHtml } from '../tasks/lib';

const BFF = '/api/files/view?u=';
const ORIGIN = 'https://dev.nexus.greensglobal.com';
const enc = encodeURIComponent('https://proj.supabase.co/storage/v1/object/public/ticket-evidence/image-1.jpg');

describe('absolutizeViewUrls', () => {
  it('keeps an uploaded picture and file link through the sanitizer in BFF mode', () => {
    const body = `<p>see</p><img src="${BFF}${enc}"><a href='${BFF}z'>f.pdf</a>`;
    // The bug: relative viewer URLs are stripped.
    expect(sanitizeRichHtml(body)).not.toContain('src=');
    const out = sanitizeRichHtml(absolutizeViewUrls(body, { prefix: BFF, origin: ORIGIN }));
    expect(out).toContain(`src="${ORIGIN}${BFF}${enc}"`);
    expect(out).toContain(`href="${ORIGIN}${BFF}z"`);
  });

  it('leaves text that only mentions the viewer path alone', () => {
    const body = `<p>open ${BFF}x in a browser</p>`;
    expect(absolutizeViewUrls(body, { prefix: BFF, origin: ORIGIN })).toBe(body);
  });

  it('is a no-op for an absolute viewer prefix (local development)', () => {
    const p = 'http://localhost:8000/files/view?u=';
    const body = `<img src="${p}${enc}">`;
    expect(absolutizeViewUrls(body, { prefix: p, origin: ORIGIN })).toBe(body);
  });

  it('passes empty and plain bodies through', () => {
    expect(absolutizeViewUrls('', { prefix: BFF, origin: ORIGIN })).toBe('');
    expect(absolutizeViewUrls(null, { prefix: BFF, origin: ORIGIN })).toBe(null);
    expect(absolutizeViewUrls('plain', { prefix: BFF, origin: ORIGIN })).toBe('plain');
  });
});
