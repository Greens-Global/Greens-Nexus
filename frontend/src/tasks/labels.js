// Task Module - labels done right (Neil, Oct 22 2026, Planner parity).
//
// A task's labels are `task.tags`, free text. This is the ONE place that says
// what a label is, what color it wears and how it is drawn, so every screen
// (drawer, lists, My Tasks, filters, group headers, Manage, the Board) agrees.
//
// STABLE API - other branches import it. Change by adding, never by renaming.
//
//   labelKey(name)                 -> the label's identity: trimmed, inner
//                                     whitespace collapsed, lowercased.
//                                     "Urgent", "urgent " and "URGENT" are one.
//   cleanLabel(name)               -> the name as stored (trimmed, collapsed).
//   labelTone(name, map?)          -> { tone, fg, bg, border, dot }
//                                     fg / bg / border are CSS var() references
//                                     (style.css --nx-tag-<tone>-*) that follow
//                                     the light / dark theme by themselves; dot
//                                     is a mid-shade hex for accents (a group's
//                                     color bar, `${dot}1a` tints). `map` is the
//                                     company label map from useLabelColors();
//                                     without it, or for a label it does not
//                                     name, the color is the default: a
//                                     deterministic hash of labelKey(name).
//   labelName(name, map?)          -> the name to SHOW: the map's display name
//                                     for that key, else cleanLabel(name).
//   canonicalLabel(typed, map?, known?)
//                                  -> the spelling to STORE when someone types
//                                     `typed`: the map's display name, else the
//                                     spelling of a label already in use
//                                     (`known`: names or { name } rows), else
//                                     cleanLabel(typed). Adding "urgent" where
//                                     "Urgent" exists stores "Urgent".
//   <LabelPill name onRemove? size? title? />
//                                  -> the soft pill (tinted background, colored
//                                     text and border - never a solid fill).
//                                     size 'sm' | 'md' (default). onRemove adds
//                                     an x button labelled "Remove label <name>".
//   <LabelStrip tags max? size? /> -> a row's labels: the first `max` pills and
//                                     "+N", with every name in the tooltip.
//   useLabelColors()               -> { map, inUse, companyId, companies,
//                                     canManage, loading, error, refresh }.
//                                     Fetched ONCE per page (GET /task-labels)
//                                     and shared by every caller; refreshed by
//                                     invalidateLabelColors(). inUse is
//                                     [{ key, name, count }] over tasks the
//                                     caller can open (server-filtered).
//   invalidateLabelColors()        -> refetch (after a recolor / rename /
//                                     merge / delete).
//   labelsInUse(tasks)             -> [{ key, name, count }] tallied from a
//                                     task list, most common spelling first.
//   mergeLabelLists(...lists)      -> one [{ key, name, count }] list, by key.
//   labelSuggestions(known, query, current?, limit?) -> the labels box's
//                                     suggestions (not on the task yet; prefix
//                                     matches first, then most used).
//   mergeLabels(current, add?, remove?) -> a task's labels after adding /
//                                     removing, by key (the server's merge_tags).
//   LABEL_TONES / TONE_KEYS / DEFAULT_TONE_KEYS - the palette.
//
// The default color is FNV-1a over labelKey's UTF-8 bytes, modulo the ten
// DEFAULT_TONE_KEYS - the same arithmetic as backend/task_labels.default_tone,
// so a rename on the server can keep the color a label already showed.
import { createElement, useEffect, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';

// ── Palette ─────────────────────────────────────────────────────────────────
// light / dark are the exact values style.css declares as --nx-tag-<tone>-*
// (labels.test.js keeps the two in step and checks the contrast: text on its
// own background is at least 6:1 in both themes). Light: Tailwind 800 on 100
// with a 200 border. Dark: the 300 shade on the 950 shade sunk into the dark
// card, with a 700 border sunk the same way.
export const LABEL_TONES = {
  blue:   { label: 'Blue',   dot: '#3b82f6', light: { fg: '#1e40af', bg: '#dbeafe', border: '#bfdbfe' }, dark: { fg: '#93c5fd', bg: '#172143', border: '#1a3889' } },
  sky:    { label: 'Sky',    dot: '#0ea5e9', light: { fg: '#075985', bg: '#e0f2fe', border: '#bae6fd' }, dark: { fg: '#7dd3fc', bg: '#0e273c', border: '#0c466b' } },
  teal:   { label: 'Teal',   dot: '#14b8a6', light: { fg: '#115e59', bg: '#ccfbf1', border: '#99f6e4' }, dark: { fg: '#5eead4', bg: '#0c272c', border: '#134e4f' } },
  green:  { label: 'Green',  dot: '#22c55e', light: { fg: '#166534', bg: '#dcfce7', border: '#bbf7d0' }, dark: { fg: '#86efac', bg: '#0c271e', border: '#165334' } },
  amber:  { label: 'Amber',  dot: '#f59e0b', light: { fg: '#92400e', bg: '#fef3c7', border: '#fde68a' }, dark: { fg: '#fcd34d', bg: '#331b12', border: '#6d3a17' } },
  orange: { label: 'Orange', dot: '#f97316', light: { fg: '#9a3412', bg: '#ffedd5', border: '#fed7aa' }, dark: { fg: '#fdba74', bg: '#311715', border: '#753019' } },
  red:    { label: 'Red',    dot: '#ef4444', light: { fg: '#991b1b', bg: '#fee2e2', border: '#fecaca' }, dark: { fg: '#fca5a5', bg: '#331116', border: '#701c22' } },
  pink:   { label: 'Pink',   dot: '#ec4899', light: { fg: '#9d174d', bg: '#fce7f3', border: '#fbcfe8' }, dark: { fg: '#f9a8d4', bg: '#390f26', border: '#731a46' } },
  purple: { label: 'Purple', dot: '#a855f7', light: { fg: '#6b21a8', bg: '#f3e8ff', border: '#e9d5ff' }, dark: { fg: '#d8b4fe', bg: '#2d0f4c', border: '#501f84' } },
  indigo: { label: 'Indigo', dot: '#6366f1', light: { fg: '#3730a3', bg: '#e0e7ff', border: '#c7d2fe' }, dark: { fg: '#a5b4fc', bg: '#1b1b3d', border: '#2f2b82' } },
  slate:  { label: 'Gray',   dot: '#64748b', light: { fg: '#334155', bg: '#f1f5f9', border: '#cbd5e1' }, dark: { fg: '#cbd5e1', bg: '#212938', border: '#3a4558' } },
};
export const TONE_KEYS = Object.keys(LABEL_TONES);
// Hashed defaults: everything but Gray, which is offered only as a choice.
export const DEFAULT_TONE_KEYS = TONE_KEYS.slice(0, 10);

// ── Names and keys ──────────────────────────────────────────────────────────
export const cleanLabel = (name) => String(name ?? '').split(/\s+/).filter(Boolean).join(' ');
export const labelKey = (name) => cleanLabel(name).toLowerCase();

const encoder = new TextEncoder();

/** The tone a label wears when nobody has picked one. */
export function defaultToneKey(name) {
  let h = 0x811c9dc5;
  for (const b of encoder.encode(labelKey(name))) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return DEFAULT_TONE_KEYS[h % DEFAULT_TONE_KEYS.length];
}

const entryFor = (name, map) => (map ? map[labelKey(name)] : null) || null;

export function labelToneKey(name, map) {
  const chosen = entryFor(name, map)?.color;
  return chosen && LABEL_TONES[chosen] ? chosen : defaultToneKey(name);
}

export function labelTone(name, map) {
  const tone = labelToneKey(name, map);
  return {
    tone,
    fg: `var(--nx-tag-${tone}-fg)`,
    bg: `var(--nx-tag-${tone}-bg)`,
    border: `var(--nx-tag-${tone}-border)`,
    dot: LABEL_TONES[tone].dot,
  };
}

export const labelName = (name, map) => entryFor(name, map)?.name || cleanLabel(name);

export function canonicalLabel(typed, map, known = []) {
  const key = labelKey(typed);
  if (!key) return '';
  const mapped = map?.[key]?.name;
  if (mapped) return mapped;
  for (const k of known || []) {
    const n = typeof k === 'string' ? k : k?.name;
    if (labelKey(n) === key) return cleanLabel(n);
  }
  return cleanLabel(typed);
}

export function mergeLabels(current, add = [], remove = []) {
  const drop = new Set((remove || []).map(labelKey).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const t of [...(current || []), ...(add || [])]) {
    const k = labelKey(t);
    if (!k || drop.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(cleanLabel(t));
  }
  return out;
}

export function labelsInUse(tasks) {
  const count = new Map();
  const spell = new Map();
  for (const t of tasks || []) {
    const keys = new Map();
    for (const tag of t?.tags || []) { const k = labelKey(tag); if (k && !keys.has(k)) keys.set(k, cleanLabel(tag)); }
    for (const [k, n] of keys) {
      count.set(k, (count.get(k) || 0) + 1);
      if (!spell.has(k)) spell.set(k, new Map());
      spell.get(k).set(n, (spell.get(k).get(n) || 0) + 1);
    }
  }
  return [...count.entries()].map(([key, n]) => {
    let best = '', most = -1;
    for (const [name, c] of spell.get(key)) if (c > most) { best = name; most = c; }
    return { key, name: best, count: n };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** Union by key; the first list to name a label wins its name and count. */
export function mergeLabelLists(...lists) {
  const out = new Map();
  for (const list of lists) {
    for (const r of list || []) {
      const key = r?.key || labelKey(r?.name);
      if (key && !out.has(key)) out.set(key, { key, name: r.name || key, count: r.count || 0 });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** The labels box's suggestions for `query`: known labels not on the task
 *  yet, names starting with the query first, then the most used. */
export function labelSuggestions(known, query, current = [], limit = 8) {
  const have = new Set((current || []).map(labelKey));
  const q = labelKey(query);
  return (known || [])
    .filter((r) => !have.has(r.key) && (!q || r.key.includes(q)))
    .sort((a, b) => (q ? Number(!a.key.startsWith(q)) - Number(!b.key.startsWith(q)) : 0)
      || (b.count || 0) - (a.count || 0)
      || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .slice(0, limit);
}

// ── The company's map, fetched once and shared ──────────────────────────────
const EMPTY = Object.freeze({ map: {}, inUse: [], companyId: '', companies: [], canManage: false });
let snap = { ...EMPTY, loading: false, error: null, loaded: false };
let inflight = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());
const set = (patch) => { snap = { ...snap, ...patch }; emit(); };

let seq = 0;   // only the newest read lands - an older one finishing late is dropped

function load() {
  if (inflight) return inflight;
  // Never a reason for a screen to fail: no API (a test's mock), a 500 or
  // offline all leave the default colors, which need nothing from the server.
  if (typeof api?.getTaskLabels !== 'function') { set({ loaded: true }); return Promise.resolve(snap); }
  const mine = ++seq;
  set({ loading: true });
  const p = Promise.resolve()
    .then(() => api.getTaskLabels())
    .then((d) => {
      if (mine === seq) {
        set({ map: d?.labels || {}, inUse: d?.inUse || [], companyId: d?.companyId || '', companies: d?.companies || [],
          canManage: !!d?.canManage, loading: false, error: null, loaded: true });
      }
      return snap;
    })
    .catch((e) => {
      if (mine === seq) set({ loading: false, error: e?.message || 'Could not load label colors.', loaded: true });
      return snap;
    })
    .finally(() => { if (inflight === p) inflight = null; });
  inflight = p;
  return p;
}

export function invalidateLabelColors() {
  inflight = null;
  return load();
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const getSnapshot = () => snap;

export function useLabelColors() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => { if (!snap.loaded && !inflight) load(); }, []);
  return {
    map: s.map, inUse: s.inUse, companyId: s.companyId, companies: s.companies, canManage: s.canManage,
    loading: s.loading, error: s.error, refresh: invalidateLabelColors,
  };
}

/** Test seam: start from a known map without a server. */
export function __setLabelColors(data) {
  snap = { ...EMPTY, ...(data || {}), loading: false, error: null, loaded: !!data };
  inflight = null;
  seq += 1;
  emit();
}

// ── Drawing ─────────────────────────────────────────────────────────────────
const SIZES = {
  sm: { fontSize: 11, padding: '0 7px', lineHeight: '17px', gap: 3, icon: 10 },
  md: { fontSize: 12, padding: '1px 8px', lineHeight: '18px', gap: 4, icon: 11 },
};

export function LabelPill({ name, onRemove, size = 'md', title, style }) {
  const { map } = useLabelColors();
  const shown = labelName(name, map);
  const t = labelTone(name, map);
  const z = SIZES[size] || SIZES.md;
  return createElement('span', {
    className: 'nx-tag',
    'data-tone': t.tone,
    title: title ?? shown,
    style: {
      display: 'inline-flex', alignItems: 'center', gap: z.gap, maxWidth: '100%', minWidth: 0,
      padding: z.padding, borderRadius: 999, border: `1px solid ${t.border}`, background: t.bg, color: t.fg,
      fontSize: z.fontSize, fontWeight: 600, lineHeight: z.lineHeight, whiteSpace: 'nowrap', flexShrink: 0,
      boxSizing: 'border-box', ...style,
    },
  },
  createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } }, shown),
  onRemove ? createElement('button', {
    type: 'button',
    onClick: (e) => { e.stopPropagation(); onRemove(name); },
    'aria-label': `Remove label ${shown}`,
    title: 'Remove Label',
    style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', opacity: 0.75, padding: 0, display: 'inline-flex', flexShrink: 0 },
  }, createElement(X, { size: z.icon })) : null);
}

export function LabelStrip({ tags, max = 2, size = 'sm', style }) {
  const { map } = useLabelColors();
  const list = mergeLabels(tags);
  if (!list.length) return null;
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  const all = list.map((n) => labelName(n, map)).join(', ');
  return createElement('span', {
    'data-labels': '', title: `Labels: ${all}`,
    style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, flexShrink: 0, ...style },
  },
  ...shown.map((n) => createElement(LabelPill, { key: labelKey(n), name: n, size, title: `Labels: ${all}` })),
  rest > 0 ? createElement('span', { key: '+', style: { fontSize: 11, fontWeight: 600, color: 'var(--nx-faint)' } }, `+${rest}`) : null);
}
