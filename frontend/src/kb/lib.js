// Knowledge Base (Oct 2026 rebuild): the small shared rules every screen
// uses - page types and their colors, status words, the sub-route scheme,
// date words. Nothing here talks to the server.
import { formatDate, formatDateTime } from '../lib/datetime';

export const KB_GREEN = '#1e7b4e';

// One meta map, like TYPE_META elsewhere: label, chip color.
export const PAGE_TYPES = {
  how_to:    { key: 'how_to',    label: 'How-To',    color: '#2b6cb0', blurb: 'A short answer. Publishes directly.' },
  sop:       { key: 'sop',       label: 'SOP',       color: KB_GREEN,  blurb: 'Numbered steps with photos. Needs a second person. Can start as a task.' },
  policy:    { key: 'policy',    label: 'Policy',    color: '#7c3aed', blurb: 'Rules people sign. A major version asks everyone again.' },
  reference: { key: 'reference', label: 'Reference', color: '#b45309', blurb: 'Lists, tables, contacts. Publishes directly.' },
};
export const typeMeta = (key) => PAGE_TYPES[key] || { key, label: 'Page', color: '#64748b' };

export const PAGE_STATUS = {
  draft:             { label: 'Draft',             color: '#64748b' },
  in_review:         { label: 'In Review',         color: '#b45309' },
  changes_requested: { label: 'Changes Requested', color: '#dc2626' },
  approved:          { label: 'Published',         color: KB_GREEN },
  archived:          { label: 'Archived',          color: '#9ca3af' },
};
export const statusMeta = (s) => PAGE_STATUS[s] || { label: s || '', color: '#64748b' };

export const TRAINING_STATUS = {
  'Completed':   { color: KB_GREEN },
  'In Progress': { color: '#2b6cb0' },
  'Not Started': { color: '#64748b' },
  'Overdue':     { color: '#dc2626' },
  'Expired':     { color: '#dc2626' },
  'Signed':      { color: KB_GREEN },
  'To Sign':     { color: '#b45309' },
};
export const trainingColor = (s) => (TRAINING_STATUS[s] || { color: '#64748b' }).color;

export const CELL_COLORS = { green: KB_GREEN, amber: '#d97706', red: '#dc2626' };

export const fmtDate = (v) => formatDate(v, '');
export const fmtDateTime = (v) => formatDateTime(v, '');

export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const PALETTE = ['#1e7b4e', '#2b6cb0', '#7c3aed', '#b45309', '#0f766e', '#be185d', '#4338ca', '#9a3412'];
export function colorFor(key = '') {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ── sub-routes: /sop/<sub> ──────────────────────────────────────────────
// index | search:<q> | page:<id> | collection:<id> | editor:<id> |
// revision:<rid> | review:<id> | training | course:<id> | builder:<id> |
// health | compliance | collections | plans | migrate | certificates
export function parseSub(sub) {
  const s = String(sub || 'index');
  if (s === 'index' || s === '') return { screen: 'home' };
  if (s === 'lms') return { screen: 'training' };              // the old Learn tab
  if (s === 'manage' || s === 'insights' || s === 'tasks' || s === 'signoffs' || s === 'matrix') return { screen: 'health' };
  const i = s.indexOf(':');
  if (i < 0) return { screen: s };
  return { screen: s.slice(0, i), id: decodeURIComponent(s.slice(i + 1)) };
}

export function subFor(screen, id) {
  if (screen === 'home') return 'index';
  return id ? `${screen}:${encodeURIComponent(id)}` : screen;
}

export const TAB_OF = {
  home: 'library', search: 'library', page: 'library', collection: 'library', editor: 'library', revision: 'library', review: 'library', signatures: 'library', tasks: 'library',
  training: 'training', courses: 'training', 'training-compliance': 'training', course: 'training', builder: 'training', certificates: 'training',
  health: 'manage', compliance: 'manage', collections: 'manage', plans: 'manage', migrate: 'manage',
};

export function goKb(screen, id) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'sop', sub: subFor(screen, id) } }));
}

export function goView(view, sub) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: sub ? { view, sub } : { view } }));
}

export function pageUrl(id) {
  return `${window.location.origin}/sop/${subFor('page', id)}`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function daysWord(n) {
  if (!n) return '';
  return n === 1 ? '1 day' : `${n} days`;
}

export function copyText(text) {
  try { return navigator.clipboard.writeText(text); } catch { return Promise.resolve(); }
}

// A tiny debounce for search boxes.
export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Read a File as a data URL (for uploads and paste).
export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

// The empty TipTap document every editor starts from.
export const blankDoc = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });

export function docText(doc) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'text') { out.push(n.text || ''); return; }
    (n.content || []).forEach(walk);
    if (n.type === 'paragraph' || n.type === 'heading') out.push('\n');
  };
  walk(doc);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}

export function isDocBlank(doc) {
  return !docText(doc).trim();
}

export function sectionNames(doc) {
  return new Set((doc?.content || []).filter((n) => n.type === 'heading').map((n) => docText(n).trim().toLowerCase()));
}

// Which sections a type expects (the editor prompts for the missing ones
// until they are added or dismissed).
export const EXPECTED_SECTIONS = {
  sop: ['Purpose', 'Steps', 'Safety'],
  policy: ['Purpose', 'Who It Applies To', 'The Rules'],
  how_to: [],
  reference: [],
};
