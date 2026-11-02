// Forms & Checklists (Neil, 11/02/2026) - the rules the Documents > Forms tab,
// the entry panel and the library share. No React here, so the screens and
// their tests read the same answers. Spec: docs/superpowers/specs/
// 2026-11-02-forms-design.md. A form is a DocTemplate with docType 'form';
// an entry is a doc_form_entries row as GET /forms/entries returns it.
import { FIELD_TYPE_LABEL, SHOW_IF_OPS } from '../lib/mergeFieldTypes';
import { formatDate, formatDateTime } from '../lib/datetime';

export const FORM_CATEGORIES = [
  ['inspection', 'Inspection'], ['incident', 'Incident Report'], ['vehicle', 'Vehicle Check'],
  ['checklist', 'Checklist'], ['safety', 'Safety'], ['other', 'Other'],
];
export const categoryLabel = (key) => FORM_CATEGORIES.find(([v]) => v === key)?.[1] || (key ? key[0].toUpperCase() + key.slice(1) : 'Other');

// Who may fill a form - the Announcements audience rule, so it is one known rule.
export const AUDIENCES = [
  ['company', 'Everyone At The Company'], ['department', 'One Department'], ['site', 'One Work Site'],
];

// Review states are set by a person, never by code. Soft label colors
// (components/StatusLabel.jsx): open work is slate, done is green, a follow-up
// is the one that asks for attention.
export const ENTRY_STATES = {
  submitted: { label: 'Submitted', color: '#64748b', tone: 'ink' },
  reviewed: { label: 'Reviewed', color: '#16a34a', tone: 'green' },
  follow_up: { label: 'Needs Follow-Up', color: '#d97706', tone: 'amber' },
  closed: { label: 'Closed', color: '#94a3b8', tone: 'muted' },
};
export const entryState = (status) => ENTRY_STATES[status] || ENTRY_STATES.submitted;
// The states a reviewer may set, with the button each one is.
export const REVIEW_ACTIONS = [['reviewed', 'Mark Reviewed'], ['follow_up', 'Needs Follow-Up'], ['closed', 'Close']];

export const isForm = (t) => !!t && t.docType === 'form';

const GENERAL = 'General';
export const sectionName = (def) => String(def?.section || '').trim() || GENERAL;

/** The field list in section order: [{ section, fields }], the order the author set. */
export function groupBySection(defs = []) {
  const out = [];
  for (const def of defs) {
    const name = sectionName(def);
    let g = out.find((x) => x.section === name);
    if (!g) { g = { section: name, fields: [] }; out.push(g); }
    g.fields.push(def);
  }
  return out;
}
export const sectionsOf = (defs = []) => groupBySection(defs).map((g) => g.section);

/**
 * What a repeat group is called on screen - ONE rule, shared with the PDF
 * (backend/form_entry_pdf.py group_label): its first member's Section, else
 * the group key humanized ("tires" -> "Tires", "tire_rows" -> "Tire Rows").
 * `defs` may be the whole field list or just the group's members.
 */
export const humanizeKey = (key) => String(key || '').split(/[\s_-]+/).filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
export function groupLabel(group, defs = []) {
  const first = (defs || []).find((d) => String(d?.repeat?.group || '') === String(group || ''));
  return String(first?.section || '').trim() || humanizeKey(group);
}

/** The repeating groups in a field list: [{ group, max, fields }]. */
export function repeatGroups(defs = []) {
  const out = [];
  for (const def of defs) {
    const name = String(def?.repeat?.group || '').trim();
    if (!name) continue;
    let g = out.find((x) => x.group === name);
    if (!g) { g = { group: name, max: Number(def.repeat.max) || 10, fields: [] }; out.push(g); }
    g.fields.push(def);
  }
  return out;
}

const yesNo = (v) => (v === true || v === 'true' ? 'Yes' : v === false || v === 'false' ? 'No' : '');
const num = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

/** One answer as a person reads it (the panel, a ticket body, the CSV). */
export function formatAnswer(def, value) {
  const type = def?.type || 'text';
  if (value === undefined || value === null || value === '') return '';
  switch (type) {
    case 'yesno': return yesNo(value);
    case 'checkbox': return value === true || value === 'true' || value === 'Yes' ? 'Yes' : 'No';
    case 'rating': return `${num(value)} of 5`;
    case 'photo': return Array.isArray(value) ? `${value.length} photo${value.length === 1 ? '' : 's'}` : String(value);
    case 'signature': return value ? 'Signed' : '';
    case 'gps': {
      if (typeof value !== 'object') return String(value);
      const where = value.siteName ? `${value.siteName} ` : '';
      return `${where}(${value.lat}, ${value.lng})`.trim();
    }
    case 'date': return formatDate(value, String(value));
    case 'time': return String(value);
    case 'currency': { const n = Number(value); return Number.isNaN(n) ? String(value) : n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
    default: return Array.isArray(value) ? value.join(', ') : String(value);
  }
}

export const mapsLink = (gps) => (gps && gps.lat !== undefined && gps.lng !== undefined
  ? `https://www.google.com/maps/search/?api=1&query=${gps.lat},${gps.lng}` : '');

/** Every photo and signature URL in an entry, in field order (repeat rows included). */
export function entryFiles(defs = [], answers = {}) {
  const urls = [];
  const take = (def, v) => {
    if (def.type === 'photo' && Array.isArray(v)) urls.push(...v.filter(Boolean));
    else if (def.type === 'signature' && typeof v === 'string' && v) urls.push(v);
  };
  for (const def of defs) {
    if (def.repeat?.group) {
      for (const row of (Array.isArray(answers[def.repeat.group]) ? answers[def.repeat.group] : [])) take(def, row?.[def.token]);
    } else take(def, answers[def.token]);
  }
  return [...new Set(urls)];
}

/**
 * The answers as text, by section - the body of a ticket or a task made from
 * the entry. Repeat groups print one numbered line per row; photos and the
 * signature print their links, so the ticket keeps the evidence.
 */
export function answersAsText(defs = [], answers = {}) {
  const lines = [];
  const known = new Set();
  const line = (def, v) => {
    known.add(def.token);
    if (def.type === 'photo' && Array.isArray(v)) {
      if (v.length) lines.push(`${def.label || def.token}:`, ...v.map((u) => `  ${u}`));
      return;
    }
    if (def.type === 'signature' && v) { lines.push(`${def.label || def.token}: ${v}`); return; }
    const text = formatAnswer(def, v);
    if (text) lines.push(`${def.label || def.token}: ${text}`);
  };
  for (const { section, fields } of groupBySection(defs)) {
    const start = lines.length;
    const groups = new Set();
    for (const def of fields) {
      const g = def.repeat?.group;
      if (!g) { line(def, answers[def.token]); continue; }
      if (groups.has(g)) continue;
      groups.add(g);
      known.add(g);
      const rows = Array.isArray(answers[g]) ? answers[g] : [];
      const members = fields.filter((f) => f.repeat?.group === g);
      members.forEach((m) => known.add(m.token));
      rows.forEach((row, i) => {
        const parts = members.map((m) => { const t = formatAnswer(m, row?.[m.token]); return t ? `${m.label || m.token} ${t}` : ''; }).filter(Boolean);
        if (parts.length) lines.push(`${i + 1}. ${parts.join(', ')}`);
      });
    }
    if (lines.length > start) lines.splice(start, 0, section);
  }
  // An answer the template no longer names still prints, by its token.
  for (const [k, v] of Object.entries(answers || {})) {
    if (known.has(k) || v === undefined || v === null || v === '') continue;
    lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return lines.join('\n');
}

/** The title a ticket or task made from an entry starts with. */
export const entryTitle = (e) => `${e.title || 'Form Entry'}${e.submittedByName || e.submittedBy ? ` - ${e.submittedByName || e.submittedBy}` : ''}`;

/** The body a ticket or task made from an entry starts with. */
export function entryBody(e, defs = []) {
  const head = [
    `${e.title || 'Form'} submitted by ${e.submittedByName || e.submittedBy || 'someone'} on ${formatDateTime(e.submittedAt)}${e.workSiteName ? ` at ${e.workSiteName}` : ''}.`,
  ];
  const body = answersAsText(defs, e.answers || {});
  return [...head, '', body].join('\n').trim();
}

/** "Shown when Any Damage? is Yes" - how a field's showIf reads on the list. */
export function showIfSummary(def, defs = []) {
  const rule = def?.showIf;
  if (!rule?.token) return '';
  const other = defs.find((d) => d.token === rule.token);
  const name = other?.label || rule.token;
  const opWord = (SHOW_IF_OPS.find(([k]) => k === rule.op)?.[1] || 'Is').toLowerCase();
  if (rule.op === 'empty' || rule.op === 'notEmpty') return `Shown when ${name} ${opWord}`;
  const value = other?.type === 'yesno' ? yesNo(rule.value) || String(rule.value ?? '')
    : Array.isArray(rule.value) ? rule.value.join(', ') : String(rule.value ?? '');
  return `Shown when ${name} ${opWord} ${value}`.trim();
}

export const typeLabel = (type) => FIELD_TYPE_LABEL[type] || type || 'Text';

/** A form entry in the Documents library's row shape (lib/documentLibrary.js). */
export function formEntryRow(e) {
  return {
    id: `form:${e.id}`, kind: 'form_entry', entryId: e.id, title: e.title, forName: e.submittedByName || e.submittedBy || '',
    company: e.company || '', tags: [], folderId: '', parties: [], status: 'final', entryStatus: e.status,
    templateId: e.templateId, workSiteName: e.workSiteName || '', updatedAt: e.reviewedAt || e.submittedAt || '',
    entry: e,
  };
}
