// The live channel's lock (Notes co-typing, Neil, Oct 30 2026). Every
// message on a note's Supabase Realtime channel is encrypted here, in the
// browser, with the note's AES-GCM key - which only the note's editors can
// fetch (GET /notes/{id}/collab). Anyone else who finds the channel sees
// noise: the realtime service never carries readable note words, just as
// the rest of Nexus's realtime carries only content-free pings.
//
// Message = 12-byte random IV + AES-GCM ciphertext (which authenticates it:
// a message not made with the key fails to open and is dropped).

export function toB64(bytes) {
  let s = '';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64 || '');
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) u[i] = s.charCodeAt(i);
  return u;
}

export const canEncrypt = () => typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.getRandomValues === 'function';

/** The note's key (base64 from the server) as a CryptoKey that cannot be exported again. */
export function importKey(b64) {
  return crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** bytes -> base64(iv + ciphertext) */
export async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return toB64(out);
}

/** base64(iv + ciphertext) -> bytes, or null when it was not made with this key. */
export async function open(key, b64) {
  try {
    const all = fromB64(b64);
    if (all.length < 13) return null;
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12)));
  } catch {
    return null;
  }
}

/** A fresh epoch id for a newly seeded live session. */
export function newEpoch() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
