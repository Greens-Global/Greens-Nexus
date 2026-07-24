// Core formatting/parsing helpers used throughout the app.

/** Parse a possibly-formatted number ("$1,234.56", "12%", "") into a plain float. 0 on failure. */
export function toNumber(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

/** Acres equivalent of a Lot Size value, honoring its paired unit field. `unit === 'SF'`
 *  converts via 43,560 sqft/acre; anything else (including unset, for pre-existing data
 *  entered before the unit picker existed) is treated as already-acres. */
export function acresOf(value, unit) {
  const n = toNumber(value);
  return /^sf$/i.test(String(unit || '').trim()) ? n / 43560 : n;
}

/** Thousands-separated number, or an em dash if empty/zero. */
export function formatNumber(v) {
  const n = toNumber(v);
  return n ? n.toLocaleString() : '—';
}

/** Currency, or an em dash if empty/zero. */
export function formatMoney(v) {
  const n = toNumber(v);
  return n ? '$' + n.toLocaleString() : '—';
}

/** "Jan 1, 2026" style date, or an em dash if empty/invalid. Accepts "YYYY-MM-DD" or full ISO. */
export function formatDate(v) {
  if (!v) return '—';
  const d = new Date(String(v).slice(0, 10));
  return isNaN(d) ? String(v) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Days from today until `v` (negative = in the past). null if empty/invalid. */
export function daysUntil(v) {
  if (!v) return null;
  const d = new Date(String(v).slice(0, 10));
  return isNaN(d) ? null : Math.ceil((d - new Date()) / 864e5);
}

/** Format a value according to a PT-style field `type` (money/date/pct/num), else pass through. */
export function formatFieldValue(v, type) {
  if (v == null || String(v).trim() === '') return '';
  if (type === 'money') return formatMoney(v);
  if (type === 'date') return formatDate(v);
  if (type === 'pct') { const s = String(v).trim(); return /%/.test(s) ? s : s + '%'; }
  if (type === 'num') return formatNumber(v);
  return v;
}

/** Random short id, e.g. "x3f9k2p1q". */
export function genId() {
  return 'x' + Math.random().toString(36).slice(2, 9);
}

/**
 * Normalize a field label for matching against a property's free-text snapshot:
 * lowercase, strip any "(...)" parenthetical, collapse whitespace.
 * e.g. "Target Hold (yrs)" -> "target hold"
 */
export function normLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Current user's display name, for activity-log attribution. Set once from the Nexus
 *  session (see lib/session.js useSession) so plain functions like logging.makeLogEntry can
 *  read it without React context. Defaults to 'You' until the session wires it up. */
let _currentUser = 'You';
export function setCurrentUser(name) { _currentUser = name || 'You'; }
export function currentUser() { return _currentUser; }

/**
 * Flatten an asset's free-text snapshot (array of `{ group, fields: [{ label, value }] }`)
 * into a single lowercased-label lookup map, e.g. `{ 'google maps link': '...' }`.
 * Snapshot fields are how record-only data (fields with no top-level `key`, see PT in
 * propertyFields.js) gets read back out — normLabel() keeps lookups tolerant of label
 * punctuation/whitespace drift ("Google Maps Link" vs "google maps link").
 */
export function snapMap(asset) {
  const map = {};
  (asset.snapshot || []).forEach((group) => {
    (group.fields || []).forEach((field) => {
      map[normLabel(field.label)] = field.value;
    });
  });
  return map;
}

/** Read a File/Blob as a full-resolution base64 data URL (used for document/invoice uploads). */
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

/**
 * Read an image File as a downscaled JPEG base64 data URL: resizes so the longer edge is at
 * most `maxDim` px (never upscales) and re-encodes at `quality`. Used for asset photos, where
 * keeping stored size small matters — base64 images are what blow out localStorage's ~5MB quota
 * (see the IndexedDB persistence note). Full-res document uploads use fileToDataUrl() instead.
 */
export function resizeImageToDataUrl(file, maxDim = 1000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('bad image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
