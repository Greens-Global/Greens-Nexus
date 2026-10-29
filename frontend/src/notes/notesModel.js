// Notes - the pieces every Notes surface shares (Dashboard > Notes, Quick
// Note, the Notes widget; Neil, Oct 29 2026). backend/routers/notes.py owns
// the rows; this file is day keys, grouping, labels, the local draft and the
// Markdown export / import.
import { formatDate, formatWeekday, formatMonthYear } from '../lib/datetime';

// A color label is a thin rule beside the note, never a filled chip.
export const NOTE_COLORS = [
  { key: '', label: 'No Color', css: 'transparent' },
  { key: 'green', label: 'Green', css: 'var(--wk-green, #00a25b)' },
  { key: 'blue', label: 'Blue', css: 'var(--wk-blue, #3d7ee8)' },
  { key: 'amber', label: 'Amber', css: 'var(--wk-orange, #e8930c)' },
  { key: 'red', label: 'Red', css: 'var(--wk-red, #e2445c)' },
  { key: 'purple', label: 'Purple', css: '#8b5cf6' },
  { key: 'slate', label: 'Slate', css: '#64748b' },
];
export const colorCss = (key) => (NOTE_COLORS.find((c) => c.key === key) || NOTE_COLORS[0]).css;

const pad2 = (n) => String(n).padStart(2, '0');

// The person's own calendar day, 'YYYY-MM-DD' - a note's day is local, never UTC.
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDays(day, n) {
  const [y, m, d] = String(day).split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

export const monthOf = (day) => String(day || '').slice(0, 7);

export function shiftMonth(month, n) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

// "October 2026"
export function monthLabel(month) {
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m) return '';
  return formatMonthYear(new Date(y, m - 1, 1));
}

// A day header in the list: "Today", "Yesterday", else "Tuesday, 10/27/2026".
export function dayHeading(day, today = localDay()) {
  if (!day) return 'No Date';
  if (day === today) return 'Today';
  if (day === addDays(today, -1)) return 'Yesterday';
  if (day === addDays(today, 1)) return 'Tomorrow';
  return `${formatWeekday(day)}, ${formatDate(day)}`;
}

export const noteTitle = (n) => (n?.title || '').trim() || (n?.kind === 'daily' ? 'Daily Scratchpad' : 'Untitled Note');

// [{ day, notes }] newest day first; inside a day, pinned first then newest edit.
export function groupByDay(notes) {
  const by = new Map();
  for (const n of notes || []) {
    const k = n.day || '';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(n);
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, list]) => ({
      day,
      notes: list.slice().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || String(b.updatedAt).localeCompare(String(a.updatedAt))),
    }));
}

export function htmlToText(html) {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') return String(html).replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('p,li,h1,h2,h3,h4,blockquote,pre,tr,br').forEach((el) => el.append('\n'));
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

export const countWords = (text) => (String(text || '').trim().match(/\S+/g) || []).length;

// "edited 3 min ago" / "edited 10/27/2026"
export function editedLabel(iso, now = Date.now()) {
  if (!iso) return '';
  const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'edited just now';
  const m = Math.round(s / 60);
  if (m < 60) return `edited ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `edited ${h} hr ago`;
  return `edited ${formatDate(new Date(t))}`;
}

// ── local draft ──────────────────────────────────────────────────────────
// What was typed and not yet saved, per note, so a tab switch, a reload or a
// crash loses nothing. Cleared once the server has it. Browser storage may
// be missing (a private window) - every access is guarded.
const DRAFT_PREFIX = 'nx-note-draft:';

export function readDraft(id) {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + id);
    const d = raw ? JSON.parse(raw) : null;
    return d && typeof d === 'object' ? d : null;
  } catch { return null; }
}

export function writeDraft(id, draft) {
  try { window.localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify({ ...draft, at: Date.now() })); } catch { /* storage unavailable */ }
}

// Quick Note's shortcut: Ctrl+Alt+N, Ctrl+Cmd+N on a Mac. Not Ctrl/Cmd+Shift+N
// - every browser keeps that for a private window and never hands it to the
// page. Read as e.key, so an AltGr letter (Ctrl+Alt on many keyboards, e.g.
// Polish AltGr+N = ń) is typed as usual and never caught.
const onMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
export const quickNoteKeys = () => (onMac() ? 'Ctrl+Cmd+N' : 'Ctrl+Alt+N');
export function isQuickNoteKey(e) {
  if (e.shiftKey || e.repeat) return false;
  if (e.ctrlKey && e.metaKey && !e.altKey) return e.code === 'KeyN' || (e.key || '').toLowerCase() === 'n';
  return !!(e.ctrlKey && e.altKey && !e.metaKey) && (e.key || '').toLowerCase() === 'n';
}

// The note last opened on the Notes page - Quick Note offers it beside today's scratchpad.
const LAST_KEY = 'nx-notes-last';
export function rememberLastNote(id) {
  try { window.localStorage.setItem(LAST_KEY, id || ''); } catch { /* storage unavailable */ }
}
export function lastNoteId() {
  try { return window.localStorage.getItem(LAST_KEY) || ''; } catch { return ''; }
}

export function clearDraft(id) {
  try { window.localStorage.removeItem(DRAFT_PREFIX + id); } catch { /* storage unavailable */ }
}

// ── Markdown ─────────────────────────────────────────────────────────────
function inlineMd(node) {
  let out = '';
  node.childNodes.forEach((c) => {
    if (c.nodeType === 3) { out += c.textContent.replace(/([*_`[\]])/g, '\\$1'); return; }
    if (c.nodeType !== 1) return;
    const tag = c.tagName.toLowerCase();
    const inner = inlineMd(c);
    if (tag === 'strong' || tag === 'b') out += `**${inner}**`;
    else if (tag === 'em' || tag === 'i') out += `*${inner}*`;
    else if (tag === 's' || tag === 'del' || tag === 'strike') out += `~~${inner}~~`;
    else if (tag === 'code') out += `\`${c.textContent}\``;
    else if (tag === 'mark') out += `==${inner}==`;
    else if (tag === 'a') out += `[${inner}](${c.getAttribute('href') || ''})`;
    else if (tag === 'br') out += '  \n';
    else out += inner;
  });
  return out;
}

function blockMd(el, depth = 0) {
  const tag = el.tagName.toLowerCase();
  const indent = '  '.repeat(depth);
  if (/^h[1-4]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inlineMd(el)}`;
  if (tag === 'p') return inlineMd(el);
  if (tag === 'hr') return '---';
  if (tag === 'pre') return '```\n' + el.textContent.replace(/\n$/, '') + '\n```';
  if (tag === 'blockquote') return [...el.children].map((c) => blockMd(c)).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n');
  if (tag === 'ul' || tag === 'ol') {
    const task = el.getAttribute('data-type') === 'taskList';
    return [...el.children].map((li, i) => {
      const box = task || li.getAttribute('data-type') === 'taskItem'
        ? (li.getAttribute('data-checked') === 'true' ? '- [x] ' : '- [ ] ')
        : (tag === 'ol' ? `${i + 1}. ` : '- ');
      const parts = [...li.children];
      const head = parts.filter((c) => !/^(ul|ol)$/i.test(c.tagName)).map((c) => (c.tagName.toLowerCase() === 'div' ? [...c.children].map((x) => blockMd(x)).join(' ') : inlineMd(c))).join(' ');
      const text = head || inlineMd(li);
      const nested = parts.filter((c) => /^(ul|ol)$/i.test(c.tagName)).map((c) => blockMd(c, depth + 1)).join('\n');
      return `${indent}${box}${text}${nested ? '\n' + nested : ''}`;
    }).join('\n');
  }
  if (tag === 'table') {
    const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => inlineMd(td).replace(/\|/g, '\\|').trim()));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
    return [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  }
  return inlineMd(el);
}

export function htmlToMarkdown(html, title = '') {
  if (typeof DOMParser === 'undefined') return String(html || '');
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const blocks = [...doc.body.children].map((c) => blockMd(c)).filter((b) => b !== '');
  return `${title ? `# ${title}\n\n` : ''}${blocks.join('\n\n')}\n`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineHtml(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\\([*_`[\]])/g, '$1');
}

// A Markdown or text file into note HTML (Import). Headings, lists,
// checklists, quotes, code fences, rules and inline marks; anything else is
// a paragraph. The server sanitizes it again on save.
export function markdownToHtml(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null;     // { tag, task }
  let para = [];
  const closePara = () => { if (para.length) { out.push(`<p>${inlineHtml(para.join(' '))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(list.task ? '</ul>' : `</${list.tag}>`); list = null; } };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closePara(); closeList();
      const code = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if (!line.trim()) { closePara(); closeList(); continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { closePara(); closeList(); out.push(`<h${m[1].length}>${inlineHtml(m[2])}</h${m[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { closePara(); closeList(); out.push('<hr>'); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { closePara(); closeList(); out.push(`<blockquote><p>${inlineHtml(m[1])}</p></blockquote>`); continue; }
    if ((m = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line))) {
      closePara();
      if (!list || !list.task) { closeList(); out.push('<ul data-type="taskList">'); list = { tag: 'ul', task: true }; }
      out.push(`<li data-type="taskItem" data-checked="${m[1].trim() ? 'true' : 'false'}"><p>${inlineHtml(m[2])}</p></li>`);
      continue;
    }
    if ((m = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(line))) {
      closePara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.task || list.tag !== tag) { closeList(); out.push(`<${tag}>`); list = { tag, task: false }; }
      out.push(`<li><p>${inlineHtml(m[2])}</p></li>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  closePara(); closeList();
  return out.join('');
}

// A file name for an export: the title, safe for every operating system.
export function exportFileName(note, ext = 'md') {
  const base = noteTitle(note).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Note';
  return `${base}.${ext}`;
}

export function downloadText(name, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Print / Save as PDF through a hidden frame, so the page itself is untouched.
export function printNote(note, html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const day = note.day ? formatDate(note.day) : '';
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(noteTitle(note))}</title>
<style>body{font:14px/1.6 Inter,system-ui,sans-serif;color:#111827;margin:40px}h1.t{font-size:22px;margin:0 0 4px}
.d{color:#6b7280;font-size:12px;margin-bottom:24px}table{border-collapse:collapse}td,th{border:1px solid #d1d5db;padding:4px 8px}
blockquote{border-left:3px solid #d1d5db;margin:0;padding-left:12px;color:#4b5563}pre{background:#f3f4f6;padding:10px;border-radius:6px}
ul[data-type=taskList]{list-style:none;padding-left:4px}li[data-checked=true]>*{text-decoration:line-through;color:#6b7280}
li[data-type=taskItem]::before{content:'\\2610  '}li[data-checked=true]::before{content:'\\2611  '}li[data-type=taskItem]>*{display:inline}</style>
</head><body><h1 class="t">${esc(noteTitle(note))}</h1><div class="d">${esc(day)}</div>${html || ''}</body></html>`);
  doc.close();
  setTimeout(() => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { /* print blocked */ }
    setTimeout(() => frame.remove(), 1500);
  }, 150);
}
