import { describe, it, expect, vi } from 'vitest';
import {
  prepareImageForUpload, isHeic, isPreparable, needsReencode, targetSize, jpegName,
  PREP_MAX_EDGE, PREP_SMALL_BYTES,
} from './imagePrep';

// Image prep before a ticket upload (Oct 2026). The browser pieces (decode,
// encode) are swapped for mocks: what is pinned here is the DECISION - what
// gets shrunk, what gets converted, what is left alone, and that a failure
// always falls back to the original file.

const fileOf = (name, type, size) => {
  const f = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const MB = 1024 * 1024;
const decoded = (width, height) => vi.fn(async () => ({ source: {}, width, height, close: vi.fn() }));
const encoder = (bytes = 300 * 1024) => vi.fn(async () => {
  const b = new Blob([new Uint8Array(8)], { type: 'image/jpeg' });
  Object.defineProperty(b, 'size', { value: bytes });
  return b;
});

describe('what counts as a preparable image', () => {
  it('takes jpeg / png / webp / heic / heif, by type', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
      expect(isPreparable(fileOf('x', t, 10))).toBe(true);
    }
  });
  it('skips gif (animation), svg (vector), video and documents', () => {
    for (const t of ['image/gif', 'image/svg+xml', 'video/mp4', 'application/pdf', '']) {
      expect(isPreparable(fileOf('x.bin', t, 10))).toBe(false);
    }
  });
  it('knows a HEIC by name when the browser leaves the type empty', () => {
    expect(isHeic(fileOf('IMG_0001.HEIC', '', 10))).toBe(true);
    expect(isHeic(fileOf('IMG_0001.heif', 'application/octet-stream', 10))).toBe(true);
    expect(isHeic(fileOf('IMG_0001.jpg', 'image/jpeg', 10))).toBe(false);
    expect(isPreparable(fileOf('IMG_0001.HEIC', '', 10))).toBe(true);
  });
});

describe('the sizing rules', () => {
  it('caps the long edge at 1600 and keeps the aspect, never upscales', () => {
    expect(targetSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(targetSize(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(PREP_MAX_EDGE).toBe(1600);
  });
  it('re-encodes when big in pixels, big in bytes, or HEIC - not otherwise', () => {
    expect(needsReencode(fileOf('a.jpg', 'image/jpeg', 200 * 1024), 4000, 3000)).toBe(true);
    expect(needsReencode(fileOf('a.png', 'image/png', PREP_SMALL_BYTES + 1), 1200, 800)).toBe(true);
    expect(needsReencode(fileOf('a.heic', 'image/heic', 100 * 1024), 800, 600)).toBe(true);
    expect(needsReencode(fileOf('a.png', 'image/png', 400 * 1024), 1440, 900)).toBe(false);
  });
  it('renames to .jpg', () => {
    expect(jpegName('IMG_0042.HEIC')).toBe('IMG_0042.jpg');
    expect(jpegName('screen shot.png')).toBe('screen shot.jpg');
    expect(jpegName('photo')).toBe('photo.jpg');
  });
});

describe('prepareImageForUpload', () => {
  it('shrinks a phone photo to a 1600px JPEG', async () => {
    const encode = encoder(420 * 1024);
    const out = await prepareImageForUpload(fileOf('IMG_1.jpg', 'image/jpeg', 6 * MB), { decode: decoded(4032, 3024), encode });
    expect(out.converted).toBe(true);
    expect(out.file.type).toBe('image/jpeg');
    expect(out.file.name).toBe('IMG_1.jpg');
    expect(encode).toHaveBeenCalledWith(expect.anything(), 1600, 1200, 0.82);
  });

  it('leaves a small, web-safe screenshot alone (no re-encode)', async () => {
    const encode = encoder();
    const f = fileOf('shot.png', 'image/png', 300 * 1024);
    const out = await prepareImageForUpload(f, { decode: decoded(1280, 800), encode });
    expect(out.file).toBe(f);
    expect(out.converted).toBe(false);
    expect(encode).not.toHaveBeenCalled();
  });

  it('never touches a gif or an svg', async () => {
    const decode = decoded(4000, 4000);
    for (const f of [fileOf('a.gif', 'image/gif', 5 * MB), fileOf('a.svg', 'image/svg+xml', 5 * MB)]) {
      const out = await prepareImageForUpload(f, { decode, encode: encoder() });
      expect(out.file).toBe(f);
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it('converts a HEIC the browser can decode (Safari) to JPEG, even when small', async () => {
    const out = await prepareImageForUpload(fileOf('IMG_9.HEIC', 'image/heic', 900 * 1024), { decode: decoded(1000, 750), encode: encoder(950 * 1024) });
    expect(out.converted).toBe(true);
    expect(out.file.name).toBe('IMG_9.jpg');
    expect(out.heicUndecoded).toBe(false);
  });

  it('uploads an undecodable HEIC as-is and flags it (filed as a download, not an image)', async () => {
    const f = fileOf('IMG_9.HEIC', 'image/heic', 2 * MB);
    const out = await prepareImageForUpload(f, { decode: vi.fn(async () => null), encode: encoder() });
    expect(out.file).toBe(f);
    expect(out.heicUndecoded).toBe(true);
  });

  it('falls back to the original when decode throws or encode fails', async () => {
    const f = fileOf('IMG_2.jpg', 'image/jpeg', 5 * MB);
    expect((await prepareImageForUpload(f, { decode: vi.fn(async () => { throw new Error('boom'); }), encode: encoder() })).file).toBe(f);
    expect((await prepareImageForUpload(f, { decode: decoded(4000, 3000), encode: vi.fn(async () => null) })).file).toBe(f);
    expect((await prepareImageForUpload(f, { decode: decoded(4000, 3000), encode: vi.fn(async () => { throw new Error('canvas'); }) })).file).toBe(f);
  });

  it('keeps the original when a re-encode of an unshrunk file comes out bigger', async () => {
    const f = fileOf('big.png', 'image/png', 1.5 * MB);
    const out = await prepareImageForUpload(f, { decode: decoded(1500, 1000), encode: encoder(2 * MB) });
    expect(out.file).toBe(f);
  });

  it('never stalls: a decoder that never answers falls back to the original', async () => {
    const f = fileOf('IMG_3.jpg', 'image/jpeg', 5 * MB);
    const out = await prepareImageForUpload(f, { decode: () => new Promise(() => {}), encode: encoder(), timeoutMs: 20 });
    expect(out.file).toBe(f);
  });
});
