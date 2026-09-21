// Private evidence buckets (Sep 22, 2026).
//
// Checkout, receipt, return, ticket and QA photos live in Supabase buckets that
// are no longer public. The DATABASE still stores the canonical public-style
// URL (`.../storage/v1/object/public/<bucket>/<path>`) - that is what the
// backend validates and what every export and email template already knows -
// but the browser can only open them through the authenticated viewer,
// `GET /files/view?u=<canonical url>`, which redirects to a short-lived signed
// URL.
//
// api.js applies these two translations at its single choke point, so no
// screen had to change how it renders a photo:
//   * responses: every canonical URL of a protected bucket becomes a viewer URL
//     before JSON.parse (rewriteResponseText);
//   * requests:  every viewer URL in a JSON body goes back to canonical before
//     it is sent (restoreRequestBody), so a screen that echoes a photo it was
//     given (edit forms, re-saves) still passes the backend's URL check.
// Upload helpers wrap what they return with toViewUrl so a just-uploaded
// preview shows before the record is saved and refetched.
//
// Keep PROTECTED_BUCKETS in step with backend/routers/files.py.
import { BFF_MODE } from '../bffAuth';

export const PROTECTED_BUCKETS = ['checkout-photos', 'item-photos', 'return-photos', 'ticket-evidence', 'qa-evidence'];

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const API = BFF_MODE ? '/api' : (import.meta.env.VITE_API_BASE ?? 'http://localhost:8000');
const PUBLIC_PREFIX = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1/object/public/` : '';
export const VIEW_PREFIX = `${API}/files/view?u=`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A canonical URL inside JSON text: runs to the closing quote or a backslash
// (a JSON escape) - neither can appear in the URL itself. Spaces stay IN:
// upload paths carry the original file name, and getPublicUrl does not
// encode them, so "abc def.jpg" is a real stored value.
const PUBLIC_RE = PUBLIC_PREFIX
  ? new RegExp(`${esc(PUBLIC_PREFIX)}(?:${PROTECTED_BUCKETS.map(esc).join('|')})/[^"'\\\\<>\\r\\n\\t]+`, 'g')
  : null;
const VIEW_RE = new RegExp(`${esc(VIEW_PREFIX)}([^"'\\s\\\\<>&]+)`, 'g');

export function isProtectedUrl(u) {
  return !!PUBLIC_PREFIX && typeof u === 'string' && u.startsWith(PUBLIC_PREFIX)
    && PROTECTED_BUCKETS.some((b) => u.startsWith(`${PUBLIC_PREFIX}${b}/`));
}

/** Canonical stored URL -> URL the browser can actually open. Anything else passes through. */
export function toViewUrl(u) {
  return isProtectedUrl(u) ? VIEW_PREFIX + encodeURIComponent(u) : u;
}

/** Viewer URL -> canonical stored URL. Anything else passes through. */
export function fromViewUrl(u) {
  if (typeof u !== 'string' || !u.startsWith(VIEW_PREFIX)) return u;
  try { return decodeURIComponent(u.slice(VIEW_PREFIX.length)); } catch { return u; }
}

/** Viewer URL with the browser asked to download instead of display. */
export function toDownloadUrl(u) {
  const v = toViewUrl(u);
  return v.startsWith(VIEW_PREFIX) ? `${v}&download=1` : v;
}

/** Rewrite every protected canonical URL in a JSON response body (text, pre-parse). */
export function rewriteResponseText(text) {
  if (!PUBLIC_RE || typeof text !== 'string' || !text.includes('/object/public/')) return text;
  return text.replace(PUBLIC_RE, (m) => VIEW_PREFIX + encodeURIComponent(m));
}

/** Put canonical URLs back into an outgoing JSON body (string). */
export function restoreRequestBody(body) {
  if (typeof body !== 'string' || !body.includes(VIEW_PREFIX)) return body;
  return body.replace(VIEW_RE, (whole, enc) => {
    try { return decodeURIComponent(enc); } catch { return whole; }
  });
}
