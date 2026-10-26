// The last 30 things the person did (contract amendment 2, `actions`): clicks,
// field edits (value MASKED to its length and kind - never the text), screen
// changes and Escape / Enter. Started by the shell the moment the server says
// the person has Build Mode, so it covers the page since (about) load, not
// only since the mode went on. Tiny on purpose: it ships in the main bundle.
import { SENSITIVE_RE } from './privacy';

const MAX = 30;
const buf = [];
let stopFns = [];
let ctx = { view: '', sub: '' };
let paused = false;

const now = () => new Date().toISOString();
const push = (entry) => { buf.push({ ...entry, at: now(), view: ctx.view, sub: ctx.sub }); if (buf.length > MAX) buf.splice(0, buf.length - MAX); };

const shortSelector = (el) => {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = [...el.classList].filter((c) => !/^(is-|has-|active$|open$)/.test(c)).slice(0, 2).join('.');
  return cls ? `${tag}.${cls}` : tag;
};
const labelOf = (el) => {
  if (!el) return '';
  const t = (el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 60);
};
const fieldLabel = (el) => {
  const byFor = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '';
  const wrap = el.closest?.('label')?.textContent;
  const l = el.getAttribute('aria-label') || byFor || wrap || el.getAttribute('placeholder') || el.name || el.id || el.tagName.toLowerCase();
  return String(l).replace(/\s+/g, ' ').trim().slice(0, 60);
};
const isOwn = (el) => !!el?.closest?.('[data-nx-devnotes]');

export function setActionContext(view, sub) {
  const next = { view: view || '', sub: sub || '' };
  if (next.view !== ctx.view || next.sub !== ctx.sub) {
    const first = !ctx.view && !ctx.sub;
    ctx = next;
    if (!first && !paused) push({ type: 'nav' });
  }
}
export function pauseActions(p) { paused = !!p; }

export function startActions() {
  if (stopFns.length) return;
  const onClick = (e) => {
    if (paused || isOwn(e.target)) return;
    const el = e.target?.closest?.('button, a, [role="button"], [role="tab"], [role="menuitem"], input, select, textarea, summary, label') || e.target;
    push({ type: 'click', label: labelOf(el), selector: shortSelector(el) });
  };
  const onInput = (e) => {
    const el = e.target;
    if (paused || isOwn(el) || !el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    const label = fieldLabel(el);
    const kind = el.type && el.type !== 'text' ? el.type : (el.tagName === 'TEXTAREA' ? 'textarea' : 'text');
    const sensitive = kind === 'password' || SENSITIVE_RE.test(`${el.name || ''} ${el.id || ''} ${label}`);
    // The last entry for the same field is updated in place: one row per field, not one per keystroke.
    const last = buf[buf.length - 1];
    const value = `***(${String(el.value ?? '').length} chars, ${sensitive ? 'sensitive' : kind})`;
    if (last && last.type === 'input' && last.selector === shortSelector(el) && last.label === label) { last.value = value; last.at = now(); return; }
    push({ type: 'input', label, selector: shortSelector(el), value });
  };
  const onKey = (e) => {
    if (paused || isOwn(e.target)) return;
    if (e.key === 'Escape' || e.key === 'Enter') push({ type: 'key', key: e.key, label: labelOf(document.activeElement), selector: shortSelector(document.activeElement) });
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);
  document.addEventListener('keydown', onKey, true);
  stopFns = [
    () => document.removeEventListener('click', onClick, true),
    () => document.removeEventListener('input', onInput, true),
    () => document.removeEventListener('change', onInput, true),
    () => document.removeEventListener('keydown', onKey, true),
  ];
}
export function stopActions() { stopFns.forEach((f) => f()); stopFns = []; }
export function snapshotActions() { return buf.map((a) => ({ ...a })); }
