// Image prep before an upload (Oct 2026, tickets on phones).
//
// A phone camera photo is 3-12 MB and 4000+ px on the long edge; nobody needs
// that to see a broken keypad, and on cell data it is the difference between
// an upload that finishes and one that times out. iPhones also hand over HEIC,
// which only Safari can display - stored as-is it shows as a broken <img> to
// everyone on Chrome/Edge/Android.
//
// So before a ticket upload, a raster image is decoded, scaled so its long
// edge is at most PREP_MAX_EDGE, and re-encoded as JPEG. A small image that is
// already web-safe is left alone (re-encoding a crisp PNG screenshot only adds
// artifacts). HEIC/HEIF always converts when the browser can decode it
// (Safari can); when it cannot, the original goes up untouched and the caller
// is told (`heicUndecoded`) so it can file it as a download, not a picture.
//
// Never blocks an upload: any failure falls back to the original file.

export const PREP_MAX_EDGE = 1600;
export const PREP_SMALL_BYTES = 1.2 * 1024 * 1024;
export const PREP_QUALITY = 0.82;
const DECODE_TIMEOUT_MS = 15000;
const PREP_TIMEOUT_MS = 20000;

const HEIC_TYPE = /^image\/(heic|heif)(-sequence)?$/i;
const HEIC_NAME = /\.(heic|heif)$/i;
const RASTER_TYPE = /^image\/(jpeg|jpg|pjpeg|png|webp|heic|heif|heic-sequence|heif-sequence)$/i;

/** HEIC/HEIF by type, or by name when the browser leaves the type empty. */
export function isHeic(file) {
  if (!file) return false;
  return HEIC_TYPE.test(file.type || '')
    || (HEIC_NAME.test(file.name || '') && /^(application\/octet-stream)?$/i.test(file.type || ''));
}

/** Is this a raster image worth looking at? gif (animation) and svg (vector) are not. */
export function isPreparable(file) {
  if (!file) return false;
  return RASTER_TYPE.test(file.type || '') || isHeic(file);
}

/** Long edge capped at `max`, aspect kept, never upscaled. */
export function targetSize(width, height, max = PREP_MAX_EDGE) {
  const w = Math.max(1, Math.round(width || 0));
  const h = Math.max(1, Math.round(height || 0));
  const long = Math.max(w, h);
  if (long <= max) return { width: w, height: h };
  const k = max / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Does this decoded image need re-encoding? */
export function needsReencode(file, width, height) {
  if (isHeic(file)) return true;
  if (Math.max(width || 0, height || 0) > PREP_MAX_EDGE) return true;
  return (file?.size || 0) >= PREP_SMALL_BYTES;
}

/** "IMG_0042.HEIC" -> "IMG_0042.jpg"; "photo" -> "photo.jpg". */
export function jpegName(name) {
  const base = String(name || 'photo').replace(/\.[^./\\]+$/, '') || 'photo';
  return `${base}.jpg`;
}

// ── Browser pieces (swappable in tests) ─────────────────────────────────────
async function decodeWithBitmap(file) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
  } catch {
    return null;
  }
}

function decodeWithImg(file) {
  if (typeof Image === 'undefined' || typeof URL?.createObjectURL !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    let settled = false;
    // A decoder that never answers must not hold the upload hostage.
    const timer = setTimeout(() => done(null), DECODE_TIMEOUT_MS);
    function done(v) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(v);
    }
    // <img> applies EXIF orientation on its own (image-orientation: from-image
    // is the CSS default), and drawImage follows it.
    img.onload = () => done(img.naturalWidth ? { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} } : null);
    img.onerror = () => done(null);
    img.src = url;
  });
}

export async function decodeImage(file) {
  return (await decodeWithBitmap(file)) || (await decodeWithImg(file));
}

export function encodeJpeg(source, width, height, quality = PREP_QUALITY) {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }
      // JPEG has no alpha - a transparent PNG would otherwise come out black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(source, 0, 0, width, height);
      canvas.toBlob((b) => resolve(b || null), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Prepare one file for upload.
 * Returns { file, converted, heicUndecoded }:
 *   file          - what to upload (the original whenever nothing was done)
 *   converted     - it was re-encoded to JPEG
 *   heicUndecoded - a HEIC/HEIF this browser could not decode; uploaded as-is
 *                   and should be filed as a document, not an image.
 * `deps` ({ decode, encode }) exists for tests.
 */
export async function prepareImageForUpload(file, deps = {}) {
  const original = { file, converted: false, heicUndecoded: false };
  if (!isPreparable(file)) return original;
  // The whole prep is bounded: a decoder or encoder that never answers falls
  // back to the original file rather than stalling the upload.
  let timer;
  const bail = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ...original, heicUndecoded: isHeic(file) }), deps.timeoutMs ?? PREP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([prepare(file, deps, original), bail]);
  } finally {
    clearTimeout(timer);
  }
}

async function prepare(file, deps, original) {
  const decode = deps.decode || decodeImage;
  const encode = deps.encode || encodeJpeg;
  const heic = isHeic(file);
  const img = await Promise.resolve().then(() => decode(file)).catch(() => null);
  if (!img || !img.width || !img.height) return { ...original, heicUndecoded: heic };
  try {
    if (!needsReencode(file, img.width, img.height)) return original;
    const { width, height } = targetSize(img.width, img.height);
    const blob = await encode(img.source, width, height, PREP_QUALITY);
    if (!blob || !blob.size) return { ...original, heicUndecoded: heic };
    // A re-encode that came out BIGGER than a file that did not need shrinking
    // is no gain - keep the original (HEIC still converts: it has to).
    const shrunk = Math.max(img.width, img.height) > PREP_MAX_EDGE;
    if (!heic && !shrunk && blob.size >= (file.size || 0)) return original;
    const out = new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: Date.now() });
    return { file: out, converted: true, heicUndecoded: false };
  } catch {
    return { ...original, heicUndecoded: heic };
  } finally {
    try { img.close?.(); } catch { /* ignore */ }
  }
}
