// Privacy guards shared by the buffers (masking) and the screenshots (black
// boxes). One regex decides what a sensitive key or field name is; nothing
// matching it ever leaves the browser in a pin.

export const SENSITIVE_RE = /pass|secret|token|ssn|social|card|account|routing|salary|rate|dob|birth/i;

/** Replace the values under sensitive keys, at any depth. */
export function maskObject(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => maskObject(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_RE.test(k) ? '***' : maskObject(v, depth + 1);
    return out;
  }
  return value;
}

/** A request or response body, masked and trimmed to `max` characters; JSON is pretty-printed first. */
export function maskBody(text, max = 2048) {
  if (text == null) return '';
  let s = typeof text === 'string' ? text : (() => { try { return JSON.stringify(text); } catch { return String(text); } })();
  if (!s) return '';
  try {
    const parsed = JSON.parse(s);
    s = JSON.stringify(maskObject(parsed), null, 1);
  } catch { /* not JSON - masked as text below */ }
  // A bare "password=..." or "token": "..." in text form.
  s = s.replace(/("?(?:[a-z_-]*(?:pass|secret|token|ssn|social|card|account|routing|salary|rate|dob|birth)[a-z_-]*)"?\s*[:=]\s*)("[^"]*"|[^,&\s}]+)/gi, '$1"***"');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The value of a form field, never the text: its length and kind. */
export function maskValue(el) {
  const v = el?.value ?? '';
  const kind = el?.type && el.type !== 'text' ? el.type : (el?.tagName === 'TEXTAREA' ? 'textarea' : 'text');
  return `***(${String(v).length} chars, ${kind})`;
}

const SENSITIVE_FIELDS = 'input[type="password"], [autocomplete^="cc-"], [data-sensitive], input, textarea';

/** Is this field one a screenshot must cover? */
export function isSensitiveField(el) {
  if (!el) return false;
  if (el.matches?.('input[type="password"], [autocomplete^="cc-"], [data-sensitive]')) return true;
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  const hay = `${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('autocomplete') || ''}`;
  return SENSITIVE_RE.test(hay);
}

/** Viewport rects of every sensitive field on screen - painted black before markup. */
export function sensitiveRects() {
  const out = [];
  for (const el of document.querySelectorAll(SENSITIVE_FIELDS)) {
    if (!isSensitiveField(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) continue;
    if (b.bottom < 0 || b.right < 0 || b.top > window.innerHeight || b.left > window.innerWidth) continue;
    out.push({ x: b.left, y: b.top, w: b.width, h: b.height });
  }
  return out;
}
