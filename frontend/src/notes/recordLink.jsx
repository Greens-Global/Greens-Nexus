// Record Links (Neil, 11/06/2026): type [[ in a note to link any Nexus record -
// another note or board, a task, a ticket, a construction job, a Knowledge Base page -
// as a chip that opens it. Every record linked this way lists the note under
// "Mentioned In" (components/MentionedIn.jsx, GET /notes/mentions).
//
// A link is saved as
//   <a data-type="recordLink" data-ref="task:<id>" title="T">T</a>
// with no href, so the server's sanitizer (routers/notes.py _NoteSanitizer,
// _RECORD_REF) keeps exactly those attributes, and a note exported or shown as
// plain HTML still reads as the record's name. The title is the name when the
// link was made; opening the chip always opens the record as it is now, inside
// the reader's own access (a note they cannot open says so, never more).
//
// The picker searches through the same APIs the header search uses (no second
// index): the caller's notes, /tasks/search, /construction/search, /kb/search.
import { useEffect, useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { StickyNote, PenTool, SquareCheckBig, HardHat, BookOpen, LifeBuoy } from 'lucide-react';
import { api } from '../api';
import { openTask } from './notesTasks';
import { setPendingOpen } from '../lib/pendingOpen';
import { safeRef } from '../lib/recordRef';

export const RECORD_KINDS = ['note', 'task', 'ticket', 'job', 'kb'];
export { safeRef };
const safeTitle = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '');
export const splitRef = (ref) => {
  const r = safeRef(ref);
  if (!r) return { kind: '', id: '' };
  const i = r.indexOf(':');
  return { kind: r.slice(0, i), id: r.slice(i + 1) };
};

export const RECORD_META = {
  note: { label: 'Note', icon: StickyNote },
  board: { label: 'Board', icon: PenTool },
  task: { label: 'Task', icon: SquareCheckBig },
  ticket: { label: 'Ticket', icon: LifeBuoy },
  job: { label: 'Job', icon: HardHat },
  kb: { label: 'Knowledge Base', icon: BookOpen },
};

const navigate = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));

/** Open the record a link points at, the way the header search opens it. */
export function openRecord(ref) {
  const { kind, id } = splitRef(ref);
  if (!kind) return;
  if (kind === 'note') navigate('dashboard', `notes:${id}`);
  else if (kind === 'task') openTask(id);
  else if (kind === 'ticket') {
    setPendingOpen('ticket', id);
    window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: id } }));
    navigate('tickets');
  }
  else if (kind === 'job') navigate('ops', `project:${id}`);
  else if (kind === 'kb') navigate('sop', `page:${encodeURIComponent(id)}`);
}

function ChipView({ node }) {
  const ref = safeRef(node.attrs.ref);
  const { kind } = splitRef(ref);
  const meta = RECORD_META[kind] || RECORD_META.note;
  const Icon = meta.icon;
  const title = safeTitle(node.attrs.title) || `Untitled ${meta.label}`;
  return (
    <NodeViewWrapper as="span" className="nt-reclink" data-kind={kind} data-ref={ref || undefined} contentEditable={false}>
      <button type="button" className="nt-reclink-btn" disabled={!ref} onClick={() => openRecord(ref)}
        title={`Open the ${meta.label.toLowerCase()} "${title}"`} aria-label={`Open ${meta.label} ${title}`}>
        <Icon size={13} strokeWidth={2} aria-hidden="true" />
        <span className="nt-reclink-title">{title}</span>
      </button>
    </NodeViewWrapper>
  );
}

export const RecordLink = Node.create({
  name: 'recordLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      ref: { default: '', parseHTML: (el) => safeRef(el.getAttribute('data-ref') || ''), renderHTML: (a) => (safeRef(a.ref) ? { 'data-ref': safeRef(a.ref) } : {}) },
      title: { default: '', parseHTML: (el) => safeTitle(el.getAttribute('title') || el.textContent || ''), renderHTML: (a) => ({ title: safeTitle(a.title) }) },
    };
  },
  // Ahead of the link mark's a[href]: a chip that arrives with an href (pasted,
  // or typed live by an older editor) is still a chip, and the href is dropped.
  parseHTML() { return [{ tag: 'a[data-type="recordLink"]', priority: 100 }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, { 'data-type': 'recordLink' }), safeTitle(node.attrs.title) || 'Untitled'];
  },
  renderText({ node }) { return safeTitle(node.attrs.title); },
  addNodeView() { return ReactNodeViewRenderer(ChipView); },
});

/** The content to insert for a picked row: the chip and a space after it. */
export const recordContent = (row) => [
  { type: 'recordLink', attrs: { ref: safeRef(`${row.kind === 'board' ? 'note' : row.kind}:${row.id}`), title: safeTitle(row.title) } },
  { type: 'text', text: ' ' },
];

const PER_KIND = 4;
const settle = (p) => Promise.resolve().then(p).catch(() => null);

/**
 * The [[ picker's rows for `query` (null = closed): `{ rows, loading }`.
 * Each row is { key, kind, id, title, detail }. With nothing typed yet it
 * offers the caller's latest notes. `excludeId` is the open note.
 */
export function useRecordSearch(query, excludeId = '') {
  const [state, setState] = useState({ term: null, rows: [] });
  const term = query == null ? null : query.trim();
  useEffect(() => {
    if (term == null) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      const wide = term.length >= 2;
      const [notes, tasks, jobs, kb, tickets] = await Promise.all([
        settle(() => api.notesList(term ? { q: term } : {})),
        wide ? settle(() => api.searchTaskModule(term, PER_KIND)) : null,
        wide ? settle(() => api.searchJobs(term, PER_KIND)) : null,
        wide ? settle(() => api.kbSearch(term, { limit: PER_KIND, log: false })) : null,
        wide ? settle(() => api.searchTickets(term, PER_KIND)) : null,
      ]);
      if (!alive) return;
      const rows = [];
      (notes?.notes || []).filter((n) => n.id !== excludeId && !n.trashedAt && n.kind !== 'daily').slice(0, term ? PER_KIND : 6)
        .forEach((n) => rows.push({ key: `note:${n.id}`, kind: n.kind === 'board' ? 'board' : 'note', id: n.id, title: n.title || (n.kind === 'board' ? 'Untitled Board' : 'Untitled Note'), detail: n.mine ? '' : `from ${n.owner}` }));
      (tasks?.tasks || []).slice(0, PER_KIND)
        .forEach((x) => rows.push({ key: `task:${x.id}`, kind: 'task', id: x.id, title: x.title || 'Untitled Task', detail: [x.completed ? 'Done' : '', x.projectName].filter(Boolean).join(' · ') }));
      (tickets?.tickets || []).slice(0, PER_KIND)
        .forEach((x) => rows.push({ key: `ticket:${x.id}`, kind: 'ticket', id: x.id, title: x.subject || 'Untitled Ticket', detail: [x.code && `#${x.code}`, ['resolved', 'closed'].includes(x.status) ? 'Done' : ''].filter(Boolean).join(' · ') }));
      (jobs?.jobs || []).slice(0, PER_KIND)
        .forEach((x) => rows.push({ key: `job:${x.id}`, kind: 'job', id: x.id, title: x.name || 'Untitled Job', detail: [x.code, x.address].filter(Boolean).join(' · ') }));
      (kb?.results || []).slice(0, PER_KIND)
        .forEach((x) => rows.push({ key: `kb:${x.id}`, kind: 'kb', id: x.id, title: x.title || 'Untitled Page', detail: [x.type_label, x.code].filter(Boolean).join(' · ') }));
      setState({ term, rows: rows.filter((r) => safeRef(`${r.kind === 'board' ? 'note' : r.kind}:${r.id}`)) });
    }, 160);
    return () => { alive = false; clearTimeout(t); };
  }, [term, excludeId]);
  if (term == null) return { rows: [], loading: false };
  return { rows: state.term === term ? state.rows : [], loading: state.term !== term };
}

