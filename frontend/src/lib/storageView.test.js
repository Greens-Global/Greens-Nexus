import { describe, it, expect, vi } from 'vitest';

vi.mock('../bffAuth', () => ({ BFF_MODE: true }));
vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');

const mod = await import('./storageView');
const { toViewUrl, fromViewUrl, toDownloadUrl, rewriteResponseText, restoreRequestBody, isProtectedUrl, VIEW_PREFIX } = mod;

const PUB = 'https://example.supabase.co/storage/v1/object/public/';
const photo = `${PUB}item-photos/2026/09/abc def.jpg`;
const avatar = `${PUB}avatars/me.png`;

describe('storageView', () => {
  it('only protects the evidence buckets', () => {
    expect(isProtectedUrl(photo)).toBe(true);
    expect(isProtectedUrl(avatar)).toBe(false);
    expect(isProtectedUrl('https://evil.example/storage/v1/object/public/item-photos/x.jpg')).toBe(false);
    expect(toViewUrl(avatar)).toBe(avatar);
    expect(toViewUrl(null)).toBe(null);
  });

  it('round-trips a single url', () => {
    const v = toViewUrl(photo);
    expect(v.startsWith(VIEW_PREFIX)).toBe(true);
    expect(v).toBe(`/api/files/view?u=${encodeURIComponent(photo)}`);
    expect(fromViewUrl(v)).toBe(photo);
    expect(toDownloadUrl(photo)).toBe(`${v}&download=1`);
    expect(toDownloadUrl(avatar)).toBe(avatar);
  });

  it('rewrites every protected url in a JSON body and restores it on the way out', () => {
    const body = { a: photo, b: avatar, nested: [{ photo_url: `${PUB}return-photos/r/1.png` }], text: 'no urls here' };
    const text = JSON.stringify(body);
    const parsed = JSON.parse(rewriteResponseText(text));
    expect(parsed.a).toBe(toViewUrl(photo));
    expect(parsed.b).toBe(avatar);
    expect(parsed.nested[0].photo_url).toBe(toViewUrl(`${PUB}return-photos/r/1.png`));
    expect(parsed.text).toBe('no urls here');
    // What the screen sends back is exactly what the server stored.
    expect(JSON.parse(restoreRequestBody(JSON.stringify(parsed)))).toEqual(body);
  });

  it('leaves bodies without any evidence url untouched', () => {
    const t = JSON.stringify({ x: 1, y: [avatar] });
    expect(rewriteResponseText(t)).toBe(t);
    expect(restoreRequestBody(t)).toBe(t);
    expect(restoreRequestBody(undefined)).toBe(undefined);
  });
});
