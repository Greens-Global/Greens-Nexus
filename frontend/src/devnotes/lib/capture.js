// What a Pin knows about the element it sits on (contract section 3,
// `target`): a selector that finds it again, its text, the headings above it,
// its outer HTML, the React component chain when the build kept names, and
// the record ids it shows. Everything here is best effort and never throws.

import { SENSITIVE_RE } from './privacy';

export const OWN_ATTR = 'data-nx-devnotes';

const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'));
// Ids a framework generated (radix, headlessui, React's useId ":r1:", uuids...)
// change on every render - never anchor to them.
const AUTO_ID = /^(?::|radix|headlessui|mui-|react-|rc_|ember|__)|[0-9a-f]{8}-[0-9a-f]{4}|^[a-z]+-?\d{3,}$|^\d/i;
// State classes come and go; hashed CSS-module classes change per build.
const NOISY_CLASS = /^(?:is-|has-|active$|open$|hover|focus|selected$|dragging|closing|nx-fill$|css-|sc-|_|[A-Za-z]+_[A-Za-z0-9]{5,}$|.*--.*)/;

export function isOwn(el) { return !!(el && el.closest && el.closest(`[${OWN_ATTR}]`)); }

/** The deepest page element under a viewport point, skipping Build Mode's own layers. */
export function elementAt(x, y) {
  if (typeof document.elementsFromPoint !== 'function') return null;
  const list = document.elementsFromPoint(x, y);
  return list.find((el) => !isOwn(el) && el !== document.documentElement && el !== document.body) || null;
}

const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };

function stableClasses(el) {
  return [...(el.classList || [])].filter((c) => c && !NOISY_CLASS.test(c)).slice(0, 2);
}

function nth(el) {
  const parent = el.parentElement;
  if (!parent) return '';
  const sibs = [...parent.children].filter((s) => s.tagName === el.tagName);
  return sibs.length > 1 ? `:nth-of-type(${sibs.indexOf(el) + 1})` : '';
}

// Every level with its position: always unique, the fallback when the
// readable form is not.
function pathSelector(el) {
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    if (cur.id && !AUTO_ID.test(cur.id) && unique(`#${esc(cur.id)}`)) { parts.unshift(`#${esc(cur.id)}`); break; }
    parts.unshift(cur.tagName.toLowerCase() + nth(cur));
    if (cur === document.body) break;
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

/** A readable selector that finds exactly this element; the positional path when nothing readable is unique. */
export function selectorFor(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id && !AUTO_ID.test(el.id) && unique(`#${esc(el.id)}`)) return `#${esc(el.id)}`;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
    if (cur.id && !AUTO_ID.test(cur.id) && unique(`#${esc(cur.id)}`)) { parts.unshift(`#${esc(cur.id)}`); break; }
    const tour = cur.getAttribute('data-tour');
    if (tour) { parts.unshift(`[data-tour="${tour.replace(/"/g, '\\"')}"]`); break; }
    let part = cur.tagName.toLowerCase();
    const cls = stableClasses(cur);
    if (cls.length) part += `.${cls.map(esc).join('.')}`;
    part += nth(cur);
    parts.unshift(part);
    if (cur.tagName === 'MAIN') break;
    cur = cur.parentElement;
  }
  const readable = parts.join(' > ');
  if (readable && unique(readable)) return readable;
  return pathSelector(el);
}

/** Visible text, whitespace collapsed, at most 300 characters. Inputs give their value or placeholder. */
export function textOf(el, max = 300) {
  if (!el) return '';
  let t = '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    t = el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
  } else if (el.tagName === 'IMG') {
    t = el.getAttribute('alt') || '';
  } else {
    t = (typeof el.innerText === 'string' ? el.innerText : el.textContent) || '';
    if (!t.trim()) t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, max);
}

const HEADING_SEL = 'h1, h2, h3, h4, [role="heading"]';

/** The headings above the element, top-down: the page title, the active module tab, then each container's heading. */
export function headingsFor(el) {
  const out = [];
  const push = (s) => { const v = String(s || '').replace(/\s+/g, ' ').trim(); if (v && !out.includes(v)) out.push(v); };
  push(document.querySelector('.breadcrumb-current')?.textContent);
  push(document.querySelector('.hdr-tab.active span, .hdr-tab[aria-current="page"] span')?.textContent);
  if (!el) return out;
  const chain = [];
  let cur = el.parentElement;
  while (cur && cur !== document.body && cur !== document.documentElement) { chain.unshift(cur); cur = cur.parentElement; }
  // Per ancestor, the nearest preceding heading that titles THAT ancestor: a
  // heading in the same branch as the target belongs to a deeper level, and
  // a heading inside a sibling branch with its own content (another card)
  // is never ours - only a header row (the heading plus a little) counts.
  for (let i = 0; i < chain.length; i++) {
    const container = chain[i];
    if (container.matches?.(HEADING_SEL)) { push(textOf(container, 80)); continue; }
    const childOnPath = chain[i + 1] || el;
    let best = null;
    for (const h of container.querySelectorAll(HEADING_SEL)) {
      if (h === el || h.contains(el) || el.contains(h) || !(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      let hChild = h;
      while (hChild.parentElement && hChild.parentElement !== container) hChild = hChild.parentElement;
      if (hChild === childOnPath) continue;
      if (hChild !== h && textOf(hChild, 400).length > textOf(h, 80).length + 40) continue;
      best = h;
    }
    if (best) push(textOf(best, 80));
  }
  if (el.matches?.(HEADING_SEL)) push(textOf(el, 80));
  return out.slice(-6);
}

/** The target's own HTML, scripts stripped, at most 4000 characters. */
export function htmlOf(el, max = 4000) {
  if (!el) return '';
  let html = '';
  try { html = el.outerHTML || ''; } catch { return ''; }
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  return html.length > max ? `${html.slice(0, max)}…` : html;
}

// React keeps a fiber on every DOM node under a per-root key; walking
// `.return` gives the component chain. Minified builds leave one-letter
// names - those are dropped, so the list is empty rather than noise.
const SKIP_NAMES = new Set(['Suspense', 'Fragment', 'Provider', 'Consumer', 'ForwardRef', 'Memo', 'Lazy', 'Profiler', 'StrictMode',
  'WidgetBoundary', 'ViewErrorBoundary', 'ErrorBoundary', 'Boundary', 'QueryClientProvider', 'MsalProvider']);
export function componentsFor(el, max = 6) {
  if (!el) return [];
  let key = null;
  try { key = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); } catch { return []; }
  if (!key) return [];
  const out = [];
  let fiber = el[key];
  let guard = 0;
  while (fiber && guard++ < 400 && out.length < max) {
    const t = fiber.type;
    let name = '';
    if (typeof t === 'function') name = t.displayName || t.name || '';
    else if (t && typeof t === 'object') name = t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || '';
    // Wrappers (providers, boundaries, gates, contexts) say nothing about
    // where the element is drawn - dropped, like the generic names above.
    if (name && name.length > 2 && !SKIP_NAMES.has(name) && !/^(Styled|Anonymous)/.test(name) && !WRAPPER_RE.test(name) && out[0] !== name) out.unshift(name);
    fiber = fiber.return;
  }
  return out.slice(-max);   // top-down, nearest last; the nearest `max` only
}
const WRAPPER_RE = /(Provider|Boundary|Gate|Context|Suspense)$/;

/** data-*-id attributes up the tree and, when the app exposes it, the React Query keys in the cache. */
export function recordFor(el) {
  const ids = [];
  const keys = [];
  let cur = el;
  let depth = 0;
  while (cur && cur.nodeType === 1 && cur !== document.body && depth++ < 10) {
    for (const a of cur.attributes || []) {
      if (!a.name.startsWith('data-')) continue;
      if (/id$|key$|^data-row$|^data-record/.test(a.name) && a.value && a.value.length <= 80) {
        if (!keys.includes(a.name)) keys.push(a.name);
        if (!ids.includes(a.value)) ids.push(a.value);
      }
    }
    cur = cur.parentElement;
  }
  let queryKeys = [];
  try {
    const qc = window.__nexusQueryClient;
    const all = qc?.getQueryCache?.().getAll?.();
    if (Array.isArray(all)) queryKeys = all.filter((q) => q.state?.status === 'success').slice(0, 12).map((q) => q.queryKey);
  } catch { queryKeys = []; }
  return { ids: ids.slice(0, 12), keys: keys.slice(0, 12), queryKeys };
}

// Where the JSX that rendered this element lives. Dev builds stamp every host
// element with data-nx-src="src/file.jsx:line:col" (scripts/nxsrc-plugin.mjs
// through vite.config.js); production builds carry none, so this is null there.
// The stamp is "<fileId>:<line>:<col>" on a built app (the file table is
// /nx-src-files.json, loaded once when the mode turns on) or a full
// "path:line:col" (tests, a bare Babel run).
let SOURCE_FILES = null;
export async function preloadSourceFiles() {
  if (SOURCE_FILES) return SOURCE_FILES;
  try {
    const r = await fetch('/nx-src-files.json', { cache: 'no-store' });
    const list = r.ok ? await r.json() : [];
    SOURCE_FILES = Array.isArray(list) ? list : [];
  } catch { SOURCE_FILES = []; }
  return SOURCE_FILES;
}
export function sourceOf(el) {
  const host = el?.closest?.('[data-nx-src]');
  const raw = host?.getAttribute('data-nx-src') || '';
  const m = raw.match(/^(.+):(\d+):(\d+)$/);
  if (!m) return null;
  let file = m[1];
  if (/^\d+$/.test(file)) file = SOURCE_FILES?.[Number(file)] || `file #${file}`;
  return { file, line: Number(m[2]), col: Number(m[3]), self: host === el };
}

// The React state behind the element: the nearest function component's name,
// its props and its hook state, with functions / elements / nodes / big
// values replaced by type markers and sensitive keys masked, capped at 8 KB.
const STATE_CAP = 8 * 1024;
function sanitize(v, depth = 0, seen = new WeakSet()) {
  if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…(${v.length} chars)` : v;
  if (typeof v === 'function') return '[fn]';
  if (typeof v === 'symbol') return '[symbol]';
  if (typeof v === 'bigint') return String(v);
  if (typeof v !== 'object') return `[${typeof v}]`;
  if (v.$$typeof) return '[element]';
  if (typeof Node !== 'undefined' && v instanceof Node) return '[node]';
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Map) return `[Map ${v.size}]`;
  if (v instanceof Set) return `[Set ${v.size}]`;
  if (seen.has(v)) return '[circular]';
  if (depth > 4) return Array.isArray(v) ? `[array ${v.length}]` : '[object]';
  seen.add(v);
  if (Array.isArray(v)) {
    const out = v.slice(0, 20).map((x) => sanitize(x, depth + 1, seen));
    if (v.length > 20) out.push(`[+${v.length - 20} more]`);
    return out;
  }
  const out = {};
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (k === 'children' || k.startsWith('__')) continue;
    if (++n > 40) { out['…'] = `[+${Object.keys(v).length - 40} keys]`; break; }
    out[k] = SENSITIVE_RE.test(k) ? '***' : sanitize(val, depth + 1, seen);
  }
  return out;
}
function hookStates(fiber) {
  const out = [];
  let h = fiber?.memoizedState;
  let guard = 0;
  while (h && typeof h === 'object' && guard++ < 40) {
    // A useState / useReducer hook has a queue; effects and refs are skipped.
    if (h.queue) out.push(sanitize(h.memoizedState));
    else if (h.memoizedState && typeof h.memoizedState === 'object' && 'current' in h.memoizedState && Object.keys(h.memoizedState).length === 1) out.push('[ref]');
    h = h.next;
  }
  return out;
}
export function stateOf(el) {
  if (!el) return null;
  let key = null;
  try { key = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); } catch { return null; }
  if (!key) return null;
  let fiber = el[key];
  let guard = 0;
  while (fiber && guard++ < 400) {
    const t = fiber.type;
    const isFn = typeof t === 'function' || (t && typeof t === 'object' && (t.render || t.type));
    if (isFn) {
      const name = (typeof t === 'function' ? (t.displayName || t.name) : (t.displayName || t.render?.displayName || t.render?.name || t.type?.name)) || '';
      if (name && name.length > 2 && !SKIP_NAMES.has(name)) {
        const out = { component: name, props: sanitize(fiber.memoizedProps || {}), hooks: typeof t === 'function' ? hookStates(fiber) : [] };
        let json = JSON.stringify(out);
        if (json.length > STATE_CAP) { out.hooks = out.hooks.slice(0, 6); json = JSON.stringify(out); }
        if (json.length > STATE_CAP) { out.props = '[props too large]'; json = JSON.stringify(out); }
        if (json.length > STATE_CAP) return { component: name, props: '[too large]', hooks: [] };
        return out;
      }
    }
    fiber = fiber.return;
  }
  return null;
}

const r = (n) => Math.round(n);
export function rectOf(el) {
  const b = el.getBoundingClientRect();
  return { x: r(b.left), y: r(b.top), w: r(b.width), h: r(b.height), pageX: r(b.left + window.scrollX), pageY: r(b.top + window.scrollY) };
}

const ATTRS = ['data-tour', 'aria-label', 'role', 'name', 'type', 'placeholder', 'href', 'title', 'data-testid'];
export function attrsOf(el) {
  const out = {};
  for (const a of ATTRS) { const v = el.getAttribute?.(a); if (v) out[a] = v.slice(0, 200); }
  return out;
}

export function breadcrumbOf(headings) {
  return headings.slice(0, 2).join(' > ');
}

/** The full `target` block for an element (mode 'element') or a dragged region (mode 'region', rect given). */
export function describeTarget(el, mode = 'element', rect = null) {
  if (!el) return { selector: '', tag: '', id: '', classes: [], attrs: {}, text: '', rect: rect || { x: 0, y: 0, w: 0, h: 0, pageX: 0, pageY: 0 }, mode, headings: headingsFor(null), breadcrumb: '', html: '', components: [], record: { ids: [], keys: [], queryKeys: [] }, source: null };
  const headings = headingsFor(el);
  return {
    source: sourceOf(el),
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: [...(el.classList || [])].slice(0, 8),
    attrs: attrsOf(el),
    text: textOf(el),
    rect: rect || rectOf(el),
    mode,
    headings,
    breadcrumb: breadcrumbOf(headings),
    html: htmlOf(el),
    components: componentsFor(el),
    record: recordFor(el),
  };
}

export function commonAncestor(els) {
  const list = els.filter(Boolean);
  if (!list.length) return null;
  let a = list[0];
  for (const b of list.slice(1)) { while (a && !a.contains(b)) a = a.parentElement; }
  return a || document.body;
}

/** A dragged rectangle (viewport px): the deepest element that contains everything inside it. */
export function regionTarget(rect) {
  const pts = [
    [rect.x + 2, rect.y + 2], [rect.x + rect.w - 2, rect.y + 2],
    [rect.x + 2, rect.y + rect.h - 2], [rect.x + rect.w - 2, rect.y + rect.h - 2],
    [rect.x + rect.w / 2, rect.y + rect.h / 2],
  ];
  const els = pts.map(([x, y]) => elementAt(x, y));
  const anc = commonAncestor(els) || document.body;
  const full = { ...rect, pageX: r(rect.x + window.scrollX), pageY: r(rect.y + window.scrollY) };
  return describeTarget(anc, 'region', full);
}

/** Find a pin's element again: the selector first, then the saved rect. */
export function anchorRect(target) {
  if (!target) return null;
  if (target.selector) {
    try {
      const el = document.querySelector(target.selector);
      if (el && !isOwn(el)) {
        if (target.mode === 'region' && target.rect) {
          // A region is a box the person drew, not the container: keep the
          // drawn box at its page position while the container is still here.
          const sr = target.rect;
          return { x: sr.pageX - window.scrollX, y: sr.pageY - window.scrollY, w: sr.w, h: sr.h, anchored: true, el, region: true };
        }
        return { ...rectOf(el), anchored: true, el };
      }
    } catch { /* a selector the browser cannot parse */ }
  }
  const sr = target.rect;
  if (!sr) return null;
  const hasPage = Number.isFinite(sr.pageX) && Number.isFinite(sr.pageY);
  return {
    x: hasPage ? sr.pageX - window.scrollX : sr.x, y: hasPage ? sr.pageY - window.scrollY : sr.y,
    w: sr.w, h: sr.h, anchored: false, el: null,
  };
}
