// ticketViewShared - split out of TicketsView.jsx (Oct 2026); the code below
// moved verbatim, see TicketsView.jsx for the module overview.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useTasks } from '../tasks/TasksContext';
import { isEmptyDoc } from '../tasks/RichDescription';
import { setPendingOpen } from '../lib/pendingOpen';
import { isTicketDrawerOpen } from './recordingDraft';
import { PRIORITY_META, PRIORITY_ORDER } from '../tasks/theme';
import { dialog as appDialog } from '../ui/dialog';
import {
  fmtDate, TICKET_TYPE_META, TICKET_TYPE_ORDER, TICKET_TYPE_KEYS,
  TICKET_STATUS_META, TICKET_STATUS_ORDER, CLOSED_STATES,
  nextClock, toEmailList,
  SERVICE_AREAS,
  topicArea,
} from './ticketMeta';
// The help topic's optional "Which one?" level (Neil, Oct 1 2026).
import { HELP_SUBTOPIC_KEY } from './ticketMeta';
import { uploadTicketEvidence } from './evidenceUpload';
import { mediaKind } from '../lib/voice';
import { useFrequentCollaborators } from '../tasks/frequentPeople';

// Desktop list-view column layout - the single source of truth for widths,
// labels and sort keys, shared by the header (labels + drag handles + sort
// arrows) and every row. `sort` pulls the comparable value off a ticket; `ctx`
// ({ nameOf, companyName }) is threaded in from TicketsView for the
// lookup-backed columns. Order/widths themselves are no longer state on this
// component - useTableColumns (tasks/tableCols.jsx, the same drag-to-reorder/
// resize kit the Task List uses) owns them, persisted to the user's profile
// under table:"tickets" so an arrangement follows them between devices.
// checkbox/type/resolved are `fixed`: structure, not data - they never move.
// `shrink` (Oct 6): how narrow a column may get. Until someone drags a width,
// every data column is elastic - minmax(shrink, width as a share) - so the
// table fills the screen it is on and only scrolls sideways once every column
// is at its floor (Pranshu: "no horizontal scroll bar at the bottom").
// Desk re-cut (Neil, 10/31/2026): the title is elastic and takes the slack
// (`template` - never squeezed below 260px, so the words stay readable on a
// 1,300px list); Status and Priority hold one word each; Due Date became Next
// Clock (ticketMeta.nextClock - the reply or resolution clock in words);
// Updated joins and Created steps back (`defaultHidden` - one click away in
// Columns, saved per person). Company is hidden by default only while the
// loaded tickets are one company (TicketsView sets that flag). The shrink
// floors sum to 1,160px with every default column showing (1,240px once
// Company joins), under a 1,300px list, so the defaults never force a
// horizontal scroll.
const TICKET_COLUMNS = [
  { key: 'checkbox', label: '', width: 34, fixed: true },
  { key: 'type', label: '', width: 34, fixed: true },
  // minWidth: a floor even under a width someone dragged - the title is what
  // the row IS, and it must never be squeezed to nothing to make room for
  // another column (Neil, Oct 1).
  { key: 'title', label: 'Title', minWidth: 260, template: 'minmax(260px, 1fr)', sort: (t) => (t.subject || '').toLowerCase() },
  { key: 'company', label: 'Company', width: 130, shrink: 80, sort: (t, ctx) => (ctx.companyName(t.companyId) || '').toLowerCase() },
  // Status carries a second small label while a ticket awaits approval.
  { key: 'state', label: 'Status', width: 140, shrink: 130, sort: (t) => TICKET_STATUS_ORDER.indexOf(t.status) },
  { key: 'priority', label: 'Priority', width: 110, shrink: 100, sort: (t) => PRIORITY_ORDER.indexOf(t.priority) },
  // Whichever SLA clock bites next, in words; sorts by that deadline (paused
  // after every live clock, no clock last).
  { key: 'clock', label: 'Next Clock', width: 150, shrink: 130, sort: (t) => nextClock(t).at },
  { key: 'requester', label: 'Requester', width: 140, shrink: 110, sort: (t, ctx) => (ctx.nameOf(t.requesterId) || '').toLowerCase() },
  { key: 'assignee', label: 'Assignee', width: 140, shrink: 110, sort: (t, ctx) => (ctx.nameOf(t.assigneeId) || '').toLowerCase() },
  // The last change to the ticket, as an age ("3h ago"); the exact moment is
  // the tooltip. A ticket saved before modified_at existed uses its creation.
  { key: 'updated', label: 'Updated', width: 100, shrink: 88, sort: (t) => t.modifiedAt || t.createdAt || '' },
  { key: 'created', label: 'Created', width: 110, shrink: 92, defaultHidden: true, sort: (t) => t.createdAt || '' },
  // The newest reply, last (Neil, Oct 1 2026) - see LatestComment.jsx. Wide
  // enough by default for a picture and a line of the preview; sorts by when.
  { key: 'latestComment', label: 'Latest Comment', width: 260, minWidth: 160, shrink: 140, sort: (t) => t.latestComment?.createdAt || '' },
  { key: 'resolved', label: '', width: 24, fixed: true },
];
// ── What do you need help with? ──────────────────────────────────────────────
// Replaced the Application picker (every External Links app, grouped by the
// department that used it) on Neil's walkthrough, Sep 30: "these are not core
// applications within the company... if I have a physical maintenance issue,
// why am I scrolling through a big list of random items". The options now come
// from the department picked above it (HELP_TOPICS, see ticketMeta.js), and the
// answer is still stored on the ticket's `application` - so reports, CSV and
// every ticket raised before this keep their value.

// Work-site names for the Facility / Site service questions.
function useTicketSites() {
  const [sites, setSites] = useState([]);
  useEffect(() => {
    let alive = true;
    api.getTicketSites()
      .then((rows) => { if (alive) setSites(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setSites([]); });
    return () => { alive = false; };
  }, []);
  return sites;
}

// The service area a ticket about this topic files under, for the client-side
// preview of what the server derives on save (service_area_for in
// backend/routers/tickets.py): a curated topic's own area, and General for
// anything typed.
function areaForTopic(topic) {
  const name = (topic || '').trim();
  if (!name) return '';
  return topicArea(name) || 'general';
}

// Is this department offered on Submit a Ticket? Off in Settings > Ticket
// Manager (Neil, Oct 1: "I don't want a construction ticket"), or deleted from
// the company's global list - both still name the tickets already filed.
const offeredAtIntake = (d) => d.enabled !== false && !d.removed;

// typeFields with the help topic's "Which one?" answer set ('' removes it).
function withHelpSubtopic(typeFields, sub) {
  const next = { ...(typeFields || {}) };
  if (sub) next[HELP_SUBTOPIC_KEY] = sub;
  else delete next[HELP_SUBTOPIC_KEY];
  return next;
}

// Is `value` one of this department's listed topics? (case-insensitive)
function listedTopic(group, value) {
  const v = (value || '').trim().toLowerCase();
  return v ? (group?.topics || []).find((tp) => (tp.name || '').trim().toLowerCase() === v) : null;
}

// List-view grouping. Carries its own labels rather than title-casing the key,
// which only worked while every dimension happened to be one word.
const GROUP_BY_OPTIONS = [
  { key: 'none', label: 'None' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'type', label: 'Type' },
  { key: 'serviceArea', label: 'Service Area' },
  { key: 'assignee', label: 'Assignee' },
];

// -v2: saved widths win over the defaults, so widening State/Priority above
// would have left everyone who had ever loaded the list on the old, too-narrow
// numbers. Bumping the key retires them once.
// Option lists for the kit dropdowns, in one place - the filter sheet, the
// filter menu, the create wizard and the drawer each used to carry their own
// hand-written <option> list of the same choices.
const statusOptions = () => TICKET_STATUS_ORDER.map((s) => [s, TICKET_STATUS_META[s].label]);
const priorityOptions = () => PRIORITY_ORDER.map((p) => [p, PRIORITY_META[p].label]);
// The list's Type filter: all five, on or off - a type switched off at intake
// still has its tickets to find.
const typeOptions = () => TICKET_TYPE_KEYS.map((ty) => [ty, TICKET_TYPE_META[ty].label]);
// Same list, each with its plain-English definition under it in the open
// dropdown (Neil, Sep 30) - where a requester (or the desk re-typing a
// ticket) actually picks one.
const typeIntakeOptions = () => TICKET_TYPE_ORDER.map((ty) => ({ id: ty, label: TICKET_TYPE_META[ty].label, desc: TICKET_TYPE_META[ty].hint || '' }));
const slaFilterOptions = [['all', 'Any SLA'], ['breached', 'SLA Breached'], ['at_risk', 'Due Soon'], ['ok', 'On Track'], ['paused', 'Paused']];
// Open/Unassigned are buckets, not statuses - they must be listed or the
// control renders blank when a summary tile selects one.
const statusFilterOptions = () => [['all', 'All Statuses'], ['open', 'Open (Not Resolved)'],
  ['unassigned', 'Unassigned'], ...statusOptions()];
const serviceAreaOptions = () => SERVICE_AREAS.map((a) => [a.key, a.label]);
const groupByOptions = () => GROUP_BY_OPTIONS.map((g) => [g.key, g.label]);

// The drawer's edit gates for one ticket, in one place for the list row, the
// board and the phone's Move To (Oct 2026 review: the board let anyone drag
// any card, and the row's status cell skipped the requester carve-out the
// drawer applies). UI convenience only - _ticket_edit_scope in
// backend/routers/tickets.py is the real boundary.
export function ticketRights(t, myEmail, privileged) {
  const me = (myEmail || '').toLowerCase();
  const isRequester = (t.requesterId || '').toLowerCase() === me;
  const isAssignee = (t.assigneeId || '').toLowerCase() === me;
  const priv = !!privileged;
  const requesterLocked = isRequester && !isAssignee && !priv && t.status !== 'open';
  const locked = t.status === 'in_progress' && !!t.assigneeId;
  const canWorking = priv || (!requesterLocked && (locked ? isAssignee : true));
  const requesterOnly = isRequester && !priv && !isAssignee;
  return { isRequester, isAssignee, requesterOnly, canWorking, canEditStatus: canWorking && !requesterOnly };
}

// Real Supabase Storage upload for ticket evidence (screenshots, documents,
// screen recordings) - works for any file size, unlike the old inline-data-URL
// scheme it replaced (which silently dropped anything over 2MB; recordings
// always would have). Bucket must exist on the Supabase project - public,
// same as Testing's qa-evidence - create `ticket-evidence` there.
function attachmentKindOf(f) {
  if ((f.type || '').startsWith('image/')) return 'image';
  // A voice note plays in the attachment viewer (Neil, Oct 30 2026); the
  // extension decides for an iPhone clip that came with no type.
  return mediaKind(f) || 'doc';
}

// Posts one file to a ticket - the ticket must already exist (attachments are
// keyed by ticket id). A failed storage upload still records the attachment
// by name (returns false) so the attempt isn't silently lost - the caller
// decides whether/how to surface that.
async function uploadTicketFile(ticketId, f) {
  const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
  const kind = attachmentKindOf(f);
  let url = '';
  let ok = true;
  try { url = await uploadTicketEvidence(f, kind); } catch { ok = false; }
  // The server refuses a URL outside our storage (400) - that file is not on
  // the ticket either, so it counts as failed too.
  try { await api.addTicketAttachment(ticketId, { name: f.name, size, kind, url }); } catch { ok = false; }
  return ok;
}

// "Could not attach <name>: <server's reason>" - a refused attachment (e.g.
// a URL outside our storage, 400) used to vanish without a word.
const attachFailed = (name) => (e) => appDialog.alert(`Could not attach "${name}": ${e?.message || e}`, { title: 'Attachment Not Saved' });

// Does a (possibly rich) description say anything? An editor that was opened
// and left empty saves "<p></p>"; a screenshot on its own still counts.
const hasRichText = (html) => !!html && (!isEmptyDoc(html) || /<img\b/i.test(html));

/** The task module's Collaborators extras for a ticket's picker: the
 *  module's teams (approved, plus your own personal ones), "Save as a Team"
 *  (a personal team, as in the task module), and the people you share the
 *  most tasks with. */
function useCollaboratorExtras() {
  const { teams = [], createTeam } = useTasks();
  const frequent = useFrequentCollaborators();
  return {
    teams, frequent,
    onSaveTeam: createTeam ? ({ name, memberIds }) => createTeam({ name, memberIds, personal: true }) : null,
  };
}

// Who can be a ticket's collaborator: the People list (staff, A-Z) as the
// Requester dropdown shows it, plus anyone already on it who is not in the
// list, less the requester (already on the ticket).
function collaboratorOptions(people, keep, requester) {
  const req = (requester || '').toLowerCase();
  const rows = people.filter((p) => !p.external)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }))
    .map((p) => ({ id: p.email, label: p.name, desc: p.email }));
  const known = new Set(rows.map((r) => r.id));
  for (const e of keep || []) if (e && !known.has(e)) { rows.push({ id: e, label: e, desc: e }); known.add(e); }
  return rows.filter((r) => r.id !== req);
}

// Plain text from a dialog going out as a reply - escaped, one <p> per line,
// the same shape the rich editor writes.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const textToHtml = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  .map((l) => `<p>${escapeHtml(l)}</p>`).join('');

// Does moving this ticket to `status` need the Resolve dialog? Any move INTO
// Resolved/Closed from a status that is still being worked.
export const needsResolution = (t, status) => CLOSED_STATES.includes(status) && !CLOSED_STATES.includes(t?.status);

// ── Edit drawer (modal) ───────────────────────────────────────────────────────
// Plain-text rendering of a type-field or custom-field value, for actors who
// can see it but (per the drawer's field gating below) can't edit it.
function readOnlyFieldValue(f, value, nameOf) {
  if (f.type === 'person') return value ? (nameOf(value) || value) : '-';
  if (f.type === 'multiperson') {
    const ids = toEmailList(value);
    return ids.length ? ids.map((e) => nameOf(e) || e).join(', ') : '-';
  }
  if (f.type === 'checklist') {
    const items = Array.isArray(value) ? value : [];
    return items.length ? items.map((it) => `${it.done ? '✓' : '○'} ${it.label}`).join('  ·  ') : '-';
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (value === '' || value == null) return '-';
  if (f.type === 'date') return fmtDate(value);
  return String(value);
}

// What each star means, in the requester's words - shown while they pick and
// on the Overview card afterwards.
const CSAT_LABELS = { 1: 'Very Dissatisfied', 2: 'Dissatisfied', 3: 'Neutral', 4: 'Satisfied', 5: 'Very Satisfied' };

// After a recording made from an EXISTING ticket stops, bring the person back
// to that ticket if they wandered off mid-recording (shared by the Attachments
// tab and the Conversation, Oct 6). Links in a reply use escapeHtml (above).
const returnToTicketAfterRecording = (ticketId) => (v) => {
  if (v || isTicketDrawerOpen(ticketId)) return;
  setPendingOpen('ticket', ticketId);
  window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId } }));
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tickets' } }));
};

export {
  TICKET_COLUMNS, useTicketSites, areaForTopic, offeredAtIntake, withHelpSubtopic, listedTopic,
  statusOptions, priorityOptions, typeOptions, typeIntakeOptions, slaFilterOptions,
  statusFilterOptions, serviceAreaOptions, groupByOptions, attachmentKindOf, uploadTicketFile,
  attachFailed, hasRichText, useCollaboratorExtras, collaboratorOptions, escapeHtml, textToHtml,
  readOnlyFieldValue, CSAT_LABELS, returnToTicketAfterRecording,
};
