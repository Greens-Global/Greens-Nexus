// The Documents library's rules (Neil, 10/31/2026): one row per document, one
// set of status words, the left views. No React here so the screen and its tests
// read the same answers. Rows come from GET /documents/library, plus the HR
// packet rows from GET /hr/packet-documents for whoever may read them, plus
// the form entries from GET /forms/entries (Neil, 11/02/2026 - a form entry
// reads like the rest of Documents; its row opens forms/EntryPanel.jsx).
import { ENTRY_STATES, formEntryRow } from '../forms/formsModel';

const TONE_OF_HR = {
  Signed: 'green', 'Out For Signature': 'blue', 'In Review': 'amber', 'Waiting On Details': 'amber', Declined: 'red',
};

/** An HR Records row in the library's shape. */
export function hrRow(r) {
  return {
    id: `hr:${r.documentId}`, kind: 'hr', title: r.title, forName: r.person, company: '', tags: [], folderId: '',
    hrStatus: r.status, packet: r.packet, templateId: r.templateId, templateName: r.templateName,
    templateVersion: r.templateVersion, locked: !!r.locked, eventId: r.eventId, documentId: r.documentId,
    signRequestId: r.signRequestId || '', signed: !!r.signed, updatedAt: r.updatedAt || '',
    status: r.status === 'Archived' ? 'archived' : 'final', parties: [],
  };
}

/** The library plus HR Records and form entries; a person's own copy of a packet envelope shows once. */
export function mergeRows(library, hr, forms = []) {
  const hrRows = (hr || []).map(hrRow);
  const formRows = (forms || []).map(formEntryRow);
  const covered = new Set(hrRows.map((r) => r.signRequestId).filter(Boolean));
  const own = (library || []).filter((r) => r.kind !== 'envelope' || !covered.has(r.signRequestId));
  return [...own, ...hrRows, ...formRows].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/** The one status a row shows: a word and the color of its dot. */
export function rowStatus(row) {
  if (row.kind === 'hr') return { label: row.hrStatus, tone: TONE_OF_HR[row.hrStatus] || 'muted' };
  if (row.kind === 'form_entry') { const s = ENTRY_STATES[row.entryStatus] || ENTRY_STATES.submitted; return { label: s.label, tone: s.tone }; }
  if (row.status === 'archived') return { label: 'Archived', tone: 'muted' };
  if (row.myTurn) return { label: 'Your Signature Needed', tone: 'amber' };
  switch (row.signStatus) {
    case 'pending':
      return { label: row.signers ? `Out For Signature - ${row.signed || 0} of ${row.signers}` : 'Out For Signature', tone: 'blue' };
    case 'completed': return { label: 'Signed', tone: 'green' };
    case 'declined': return { label: 'Declined', tone: 'red' };
    case 'voided': return { label: 'Voided', tone: 'muted' };
    case 'expired': return { label: 'Expired', tone: 'muted' };
    default: break;
  }
  return row.status === 'draft' ? { label: 'Draft', tone: 'muted' } : { label: 'Final', tone: 'ink' };
}

const SIGNING_ROLES = ['signer', 'countersigner', 'witness'];

/** Who a row is for: its person, else whoever signs it. Older documents have neither. */
export function rowFor(row) {
  if (row.forName) return row.forName;
  const names = (row.parties || []).filter((p) => SIGNING_ROLES.includes(p.role) && p.name).map((p) => p.name);
  if (!names.length) return '';
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

const isSigned = (r) => (r.kind === 'hr' ? r.hrStatus === 'Signed' : r.signStatus === 'completed');
const isOut = (r) => (r.kind === 'hr' ? r.hrStatus === 'Out For Signature' : r.signStatus === 'pending');

export const VIEWS = [
  { key: 'needs', label: 'Needs Me', empty: 'Nothing is waiting on you.', match: (r) => !!r.myTurn },
  { key: 'all', label: 'All Documents', empty: 'No documents yet.', match: (r) => r.status !== 'archived' },
  { key: 'drafts', label: 'My Drafts', empty: 'No drafts. Documents you are still writing appear here.', match: (r) => r.status === 'draft' && !!r.mine },
  { key: 'shared', label: 'Shared With Me', empty: 'Nothing has been shared with you yet.', match: (r) => r.status !== 'archived' && !!r.shareCan },
  { key: 'out', label: 'Out For Signature', empty: 'Nothing is out for signature.', match: (r) => r.status !== 'archived' && isOut(r) },
  { key: 'signed', label: 'Signed', empty: 'No signed documents yet.', match: (r) => r.status !== 'archived' && isSigned(r) },
  { key: 'hr', label: 'HR Records', hrOnly: true, empty: 'No HR packet documents yet.', match: (r) => r.kind === 'hr' },
  // Shown only when the person has entries to see (DocumentsBrowser).
  { key: 'forms', label: 'Form Entries', formsOnly: true, empty: 'No form entries yet.', match: (r) => r.kind === 'form_entry' },
  { key: 'archived', label: 'Archived', empty: 'Nothing is archived.', match: (r) => r.status === 'archived' },
];

const folderKey = (id) => `folder:${id}`;
export { folderKey };

/** The rows of a left view, a folder included. */
export function rowsInView(rows, view) {
  const v = VIEWS.find((x) => x.key === view);
  if (v) return rows.filter(v.match);
  if (String(view).startsWith('folder:')) {
    const id = view.slice('folder:'.length);
    return rows.filter((r) => r.folderId === id && r.status !== 'archived');
  }
  return rows;
}

/** One search: title, person, signer, tag, folder, company, status. */
export function searchRows(rows, q, folders = []) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows;
  const nameOf = new Map(folders.map((f) => [f.id, f.name]));
  return rows.filter((r) => [
    r.title, r.forName, r.company, nameOf.get(r.folderId), rowStatus(r).label, r.packet,
    ...(r.tags || []), ...(r.parties || []).map((p) => p.name),
  ].some((x) => String(x || '').toLowerCase().includes(needle)));
}

const SORTS = {
  title: (r) => String(r.title || '').toLowerCase(),
  for: (r) => rowFor(r).toLowerCase(),
  status: (r) => rowStatus(r).label.toLowerCase(),
  company: (r) => String(r.company || '').toLowerCase(),
  updatedAt: (r) => String(r.updatedAt || ''),
};

export function sortRows(rows, key, dir) {
  const read = SORTS[key] || SORTS.updatedAt;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * read(a).localeCompare(read(b)));
}

/** Where Documents opens: what is waiting on you, otherwise everything. */
export const startView = (rows) => (rows.some((r) => r.myTurn) ? 'needs' : 'all');

// ── The library's shape (Pranshu, 11/13/2026, canvas
// https://claude.ai/artifact/TapZUK47Diz1k3jgFh5TNW): 12 rows a page, rows
// grouped by when they changed, each with a kind line under its name.
export const PAGE_SIZE = 12;

/** "This week" / "Earlier this month" / "Older", by the row's updatedAt. */
export function groupLabel(row, now = new Date()) {
  const t = Date.parse(row.updatedAt || '');
  if (!Number.isFinite(t)) return 'Older';
  const d = new Date(t);
  const dayMs = 86400000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfToday - 6 * dayMs) return 'This week';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'Earlier this month';
  return 'Older';
}

/** The second line under a name: kind, folder, how many sign. */
export function rowSubline(row, folders = []) {
  const kind = row.kind === 'hr' ? 'Packet' : row.kind === 'form_entry' ? 'Form entry' : row.docKind === 'sheet' ? 'Sheet' : 'Document';
  const folder = folders.find((f) => f.id === row.folderId)?.name || (row.kind === 'hr' ? 'HR' : '');
  const signers = row.signers > 1 ? `${row.signers} signers` : '';
  return [kind, folder, signers].filter(Boolean).join(' · ');
}

/** One page of rows; `page` is 1-based and clamped. */
export function pageOf(rows, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages, from: rows.length ? (p - 1) * size + 1 : 0, to: Math.min(rows.length, p * size) };
}

/** Initials for an avatar: "Sophia Martinez" -> "SM". */
export const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// ── Templates (Neil, 10/31/2026: Active and Published are one step) ──────────

export const TEMPLATE_STATES = {
  draft: { label: 'Draft', tone: 'muted' },
  published: { label: 'Published', tone: 'green' },
  changes: { label: 'Unpublished Changes', tone: 'amber' },
  archived: { label: 'Archived', tone: 'muted' },
};

export const templateStatus = (t) => TEMPLATE_STATES[t.state] || TEMPLATE_STATES[t.status] || TEMPLATE_STATES.draft;
/** Anything published makes documents, in its published wording. */
export const templateUsable = (t) => t.state === 'published' || t.state === 'changes';

/** The Templates board's cards: one per category that has a template, in the categories' order. */
export function templateCards(templates, categories) {
  return categories
    .map(([key, label]) => {
      const rows = (templates || []).filter((t) => t.category === key).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { key, label, rows, pending: rows.filter((t) => t.state !== 'published').length };
    })
    .filter((c) => c.rows.length > 0);
}
