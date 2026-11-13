import { createElement, useEffect, useMemo, useState } from 'react';
import { Check, LayoutDashboard, Archive, User, Package, ClipboardList, ShoppingCart, Briefcase, Users, BookOpen, HardHat, Link2, StickyNote, PenTool, FileText } from 'lucide-react';
import { LinkIcon } from '../LinkIcon.jsx';
import TicketToken from '../icons/TicketToken';
import { useRole } from '../../contexts/RoleContext';
import { useInventory } from '../../contexts/InventoryContext';
import { useRequisitions } from '../../contexts/RequisitionContext';
import { NAV, isNavItemVisible } from '../Sidebar';
import { visibleSubs } from '../MobileMenu';
import { openContact } from '../../lib/contactNav';
import { openPersonTasks } from '../../lib/personTasksNav';
import { setPendingOpen } from '../../lib/pendingOpen';
import { formatDate } from '../../lib/datetime';
import { visibleActions, findActions, runQuickAction } from '../../lib/quickCreate';
import { api } from '../../api';
import { useTableValue } from '../../tasks/tableCols';

// ONE search for the whole app (Neil, Oct 14 2026). The header bar on every
// module and the phone sheet both draw from this hook, so what a search
// finds, how it is grouped and where a pick goes never differs by screen.
//
// Sources, in the order the groups are shown:
//   Tasks / Projects / People / Portfolios / Teams - the Task module's
//                content through /tasks search (debounced, 2+ characters).
//   Jobs       - construction jobs (work orders and projects) through
//                /construction/search, walled like the module (11/03/2026).
//   Tickets / Notes / Documents - everything else a person can open
//                (11/13/2026), each asked of its own module, which answers
//                with its own list's access rule: tickets by subject or
//                number (the ticket list's scope; a typed number that is a
//                ticket's leads the results), notes and boards (own and
//                shared), the Documents library by title. Asked only of a
//                module the person can open.
//   Items / Checkouts / Purchase Requests - from the data the app already
//                holds in its contexts (local, instant).
//   Links      - the company links and the person's Personal Links
//                (11/08/2026), loaded once per session while a search is
//                typed; a pick opens the site in a new tab and records the
//                click the way the Links page does.
//   Quick Actions - the bolt's own actions by name (lib/quickCreate.js: its
//                list, its visibility rule; a pick runs through the bolt).
//                "time off" offers Request Time Off. Above Pages - and above
//                everything once the typed text is plainly an action's name
//                ("new ti", "request t").
//   Pages      - the sidebar's screens and their sections, visible exactly
//                when the sidebar shows them (local, instant). Last, so
//                Enter on a typed title opens the thing, not the module
//                whose name happens to contain the same letters.
//
// People are for everyone (11/13/2026): the Task module's search needs the
// Tasks grant, so the People group also reads the curated Nexus People
// directory (/myhr/directory - never an M365 list), each person once.
//
// Favorites and Recents (Neil, 11/07/2026): with nothing typed, the search
// opens on the person's starred results and the last ones they opened. Each
// pickable row carries `save` ({ key, kind, title, detail, to }) - `to` says
// where it goes (a task id, a person, or a view / sub), never a closure - and
// the lists live in the person's own settings (task-prefs table "search",
// `data`), so they follow them to every computer. A saved row opens the
// record as it is now, inside the person's access; nothing is cached but the
// name.

export const SEARCH_PLACEHOLDER = 'Search Nexus';
export const SEARCH_HINT = 'Tasks, tickets, notes, documents, people, pages and actions.';
export const SEARCH_LABEL = 'Search Nexus';
const MIN_CONTENT_CHARS = 2;
const CONTENT_GROUPS = [
  { key: 'tasks',      label: 'Tasks' },
  { key: 'projects',   label: 'Projects' },
  { key: 'people',     label: 'People' },
  { key: 'portfolios', label: 'Portfolios' },
  { key: 'teams',      label: 'Teams' },
  { key: 'jobs',       label: 'Jobs' },
];
const EMPTY_HITS = { tasks: [], projects: [], people: [], portfolios: [], teams: [], jobs: [] };
const JOB_TYPE_LABEL = { work_order: 'Work Order', project: 'Project' };
const DEBOUNCE_MS = 180;
const NONE = [];
const PEOPLE_MAX = 6;

// One server source (11/13/2026): asked once the typing pauses, its answer
// kept WITH the term it answers (never shown for other text), and a failure
// is an empty answer - one source that is down never blanks the others.
// `ask` may throw; nothing here retries (api.js already does).
function useSource(term, want, ask) {
  const [answer, setAnswer] = useState({ term: '', rows: NONE });
  useEffect(() => {
    if (!want) return undefined;
    let live = true;
    const id = setTimeout(() => {
      Promise.resolve().then(() => ask(term))
        .then((rows) => { if (live) setAnswer({ term, rows: Array.isArray(rows) ? rows : NONE }); })
        .catch(() => { if (live) setAnswer({ term, rows: NONE }); });
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(id); };
  }, [term, want]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = !want || answer.term === term;
  return { rows: want && answer.term === term ? answer.rows : NONE, ready };
}

// The directory's people a search names - by name or email, a name that
// starts with the words first, then alphabetical (the Task search's rule).
function matchPeople(list, term) {
  const q = term.toLowerCase();
  const first = (p) => (p.name.toLowerCase().startsWith(q) ? 0 : 1);
  return (Array.isArray(list) ? list : [])
    .filter((p) => p?.email && (String(p.name || '').toLowerCase().includes(q) || String(p.email).toLowerCase().includes(q)))
    .map((p) => ({ email: p.email, name: p.name || p.email }))
    .sort((a, b) => first(a) - first(b) || a.name.localeCompare(b.name));
}

// Mirrors of tickets/ticketMeta (ticketNoShort, the status words) and
// notes/notesModel (noteTitle), kept local so the header never imports
// those modules.
const TICKET_STATUS_LABELS = {
  new: 'Open', open: 'Open', in_progress: 'In Progress', waiting_user: 'Waiting for User', waiting: 'Waiting for User',
  waiting_vendor: 'Waiting for Vendor', on_hold: 'On Hold', reopened: 'Reopened', resolved: 'Resolved', closed: 'Closed',
};
const ticketNo = (code) => { const digits = String(code || '').replace(/\D/g, ''); return digits ? `#${Number(digits)}` : ''; };
const noteTitle = (n) => (n.title || '').trim() || (n.kind === 'daily' ? 'Daily Scratchpad' : n.kind === 'board' ? 'Untitled Board' : 'Untitled Note');

// A ticket opens the way the bell and My Work open it: the note for a module
// still loading, the view, then the live event (lib/pendingOpen.js).
const openTicket = (id, view) => {
  setPendingOpen('ticket', id);
  navigate(view);
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: id } })), 0);
};
// A document opens beside the library's list, where the library opens it
// (components/DocumentsBrowser.jsx drains the note or hears the event).
const DOCUMENT_OPEN_EVENT = 'nexus:open-document';
const openDocument = (id) => {
  setPendingOpen('document', id);
  navigate('documents', 'documents-browse');
  setTimeout(() => window.dispatchEvent(new CustomEvent(DOCUMENT_OPEN_EVENT, { detail: { id } })), 0);
};

// Mirror of InventoryManagement's displayStatus labels, kept local so this
// never imports the 8k-line view (and the module -> search import cycle).
const ITEM_STATUS_LABELS = {
  available: 'Available', unassigned: 'Unassigned', location_assigned: 'Assigned · Location',
  checked_out: 'Checked Out', permanently_assigned: 'Perm. Assigned', retired: 'Retired',
};
// Status labels are Title Case ("Pending Receipt", never "pending receipt").
const statusLabel = (s) => (s || '').split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
function itemStatusLabel(item) {
  const s = (item.ownershipType === 'permanent' && item.status === 'available')
    ? ((!item.assignedToEmail && item.location) ? 'location_assigned' : 'unassigned')
    : item.status;
  return ITEM_STATUS_LABELS[s] || statusLabel(s);
}

// QA-gated screens (Testing) show only while QA is on - asked once, shared
// by every search surface.
let qaKnown = null;   // null until asked; the answer is shared by every surface
let qaAsk = null;
function useQaEnabled(enabled) {
  const [answered, setAnswered] = useState(qaKnown);
  useEffect(() => {
    if (!enabled || qaKnown !== null) return undefined;
    let live = true;
    qaAsk = qaAsk || api.qaEnabled().then(r => !!r?.enabled).catch(() => false).then(v => { qaKnown = v; return v; });
    qaAsk.then(v => { if (live) setAnswered(v); });
    return () => { live = false; };
  }, [enabled]);
  return (qaKnown ?? answered) === true;
}

const FAV_MAX = 12;
const RECENT_MAX = 8;
const EMPTY_SAVED = { favorites: [], recents: [] };
const SAVED_ICON = { task: Check, job: HardHat, person: User, item: Package, checkout: ClipboardList, request: ShoppingCart, kb: BookOpen, page: LayoutDashboard, link: Link2, ticket: TicketToken, note: StickyNote, board: PenTool, document: FileText };
// What the store hands back is the person's own JSON: only well-formed entries count.
const cleanTo = (to) => {
  if (!to || typeof to !== 'object') return null;
  if (typeof to.task === 'string' && to.task) return { task: to.task.slice(0, 100) };
  if (typeof to.person === 'string' && to.person.includes('@')) return { person: to.person.slice(0, 200), name: String(to.name || '').slice(0, 200) };
  if (typeof to.ticket === 'string' && to.ticket) return { ticket: to.ticket.slice(0, 100), view: to.view === 'tickets' ? 'tickets' : 'support' };
  if (typeof to.doc === 'string' && to.doc) return { doc: to.doc.slice(0, 120) };
  if (typeof to.view === 'string' && /^[a-z0-9-]{1,40}$/i.test(to.view)) return { view: to.view, sub: typeof to.sub === 'string' ? to.sub.slice(0, 300) : undefined };
  if (typeof to.url === 'string' && /^https?:\/\//i.test(to.url)) return { url: to.url.slice(0, 2000), link: typeof to.link === 'string' ? to.link.slice(0, 40) : undefined };
  return null;
};

// Links (11/08/2026): the company directory and the person's own links,
// asked for once per session the first time a search is typed - the same
// calls the Links page makes. `link` is "external:<id>" or "personal:<id>".
let linksKnown = null;
let linksAsk = null;
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
function useLinks(enabled) {
  const [loaded, setLoaded] = useState(linksKnown);
  useEffect(() => {
    if (!enabled || linksKnown !== null) return undefined;
    let live = true;
    linksAsk = linksAsk || Promise.all([
      api.getExternalLinks().then((r) => (Array.isArray(r) ? r : [])).catch(() => []),
      api.getPersonalLinks().then((r) => (Array.isArray(r) ? r : [])).catch(() => []),
    ]).then(([company, personal]) => { linksKnown = { company, personal }; return linksKnown; });
    linksAsk.then((v) => { if (live) setLoaded(v); });
    return () => { live = false; };
  }, [enabled]);
  return linksKnown || loaded || { company: [], personal: [] };
}
// The Links page calls this after any link changes, so the next search
// reads the directory again.
export const resetLinksSearchCache = () => { linksKnown = null; linksAsk = null; };
const openSite = (url, link) => {
  window.open(url, '_blank', 'noopener');
  const [kind, id] = (link || '').split(':');
  if (kind === 'external' && id) api.clickExternalLink(Number(id)).catch(() => {});
  if (kind === 'personal' && id) api.clickPersonalLink(Number(id)).catch(() => {});
};
const linkIcon = (url) => createElement(LinkIcon, { url, size: 20, iconSize: 12, radius: 5, fg: 'var(--muted)', bg: 'var(--mist)', gradient: false });
const cleanEntry = (e) => {
  if (!e || typeof e !== 'object' || typeof e.key !== 'string' || !SAVED_ICON[e.kind]) return null;
  const to = cleanTo(e.to);
  if (!to) return null;
  return { key: e.key.slice(0, 200), kind: e.kind, title: String(e.title || '').slice(0, 200) || 'Untitled', detail: String(e.detail || '').slice(0, 200), to };
};
const cleanList = (list, max) => (Array.isArray(list) ? list.map(cleanEntry).filter(Boolean).slice(0, max) : []);

const navigate = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub ?? undefined } }));

export function useNexusSearch(query, { enabled = true } = {}) {
  const role = useRole();
  const { myRole, isExternal, can, canAccessModule, myGrantedModules, myEmail } = role;
  const { items = [], checkouts = [] } = useInventory() || {};
  const { requisitions = [] } = useRequisitions() || {};
  const q = (query || '').trim().toLowerCase();
  const live = enabled && q.length > 0;
  const isManager = can?.('manager');
  const canTasks = !!(can?.('administrator') || myGrantedModules?.has?.('tasks'));
  const qaEnabled = useQaEnabled(live);
  const links = useLinks(live);

  // Screens registry: the sidebar's NAV, visible exactly as the sidebar
  // shows it, plus each module's sections. Built only while a search is
  // open and typed (`can` is a new function each render, so it is keyed on
  // the role it reads instead).
  const screens = useMemo(() => {
    if (!live) return [];
    // `inTeam` (Workforce Analytics): listed once, as Team's tab below.
    const visible = NAV.filter(i => !i.divider && !i.inTeam && isNavItemVisible(i, { isExternal, can, myGrantedModules, qaEnabled }));
    const out = [];
    for (const item of visible) {
      out.push({ view: item.view, sub: null, label: item.label, context: null });
      // The phone menu's own rule, so a gated tab (Team > Workforce
      // Analytics) is never listed for someone who cannot open it.
      const subs = visibleSubs(item.view, { can, canAccessModule, isExternal });
      if (subs) for (const s of subs) out.push({ view: item.view, sub: s.sub, label: s.label, context: item.label });
    }
    return out;
  }, [live, myRole, isExternal, myGrantedModules, qaEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Task-module content, debounced so a fast typist makes one call rather
  // than one per keystroke. A failure is an empty answer: the local groups
  // keep working when the API is down.
  // The answer is kept WITH the term it answers, so a stale answer is never
  // shown for the text now in the box and nothing has to be reset in an
  // effect.
  const term = (query || '').trim();
  const wantContent = enabled && term.length >= MIN_CONTENT_CHARS;
  const [answer, setAnswer] = useState({ term: '', data: EMPTY_HITS });
  useEffect(() => {
    if (!wantContent) return undefined;
    let live = true;
    const id = setTimeout(() => {
      api.searchTaskModule(term)
        .then((r) => { if (live) setAnswer({ term, data: { ...EMPTY_HITS, ...r } }); })
        .catch(() => { if (live) setAnswer({ term, data: EMPTY_HITS }); });
    }, 180);
    return () => { live = false; clearTimeout(id); };
  }, [term, wantContent]);
  // Construction jobs (11/03/2026): their own walled search, same debounce,
  // folded into the content hits so the Jobs group reads like the others.
  const [jobAnswer, setJobAnswer] = useState({ term: '', rows: [], total: 0 });
  useEffect(() => {
    if (!wantContent) return undefined;
    let live = true;
    const id = setTimeout(() => {
      Promise.resolve().then(() => api.searchJobs(term, 5))
        .then((r) => { if (live) setJobAnswer({ term, rows: r?.jobs || [], total: r?.total || 0 }); })
        .catch(() => { if (live) setJobAnswer({ term, rows: [], total: 0 }); });
    }, 180);
    return () => { live = false; clearTimeout(id); };
  }, [term, wantContent]);
  const taskHits = wantContent && answer.term === term ? answer.data : EMPTY_HITS;
  const hits = useMemo(() => (wantContent && jobAnswer.term === term
    ? { ...taskHits, jobs: jobAnswer.rows, totals: { ...(taskHits.totals || {}), jobs: jobAnswer.total } }
    : taskHits), [taskHits, jobAnswer, term, wantContent]);
  // Knowledge Base pages (Oct 2026 rebuild): the server's own ranking over
  // published pages, same debounce, same "answer travels with its term" rule.
  const [kbAnswer, setKbAnswer] = useState({ term: '', rows: [] });
  useEffect(() => {
    if (!wantContent) return undefined;
    let live = true;
    const id = setTimeout(() => {
      api.kbSearch(term, { limit: 5, log: false })   // type-ahead: never a missed search
        .then((r) => { if (live) setKbAnswer({ term, rows: r?.results || [] }); })
        .catch(() => { if (live) setKbAnswer({ term, rows: [] }); });
    }, 180);
    return () => { live = false; clearTimeout(id); };
  }, [term, wantContent]);
  const kbRows = wantContent && kbAnswer.term === term ? kbAnswer.rows : [];
  // Tickets, notes, documents and people (11/13/2026) - each asked only of a
  // module this person can open, by the rule that opens it: the left menu's
  // for Tickets / Help Center and the Dashboard, the Documents tabs' own
  // grant check (views/Documents.jsx), company staff for the directory.
  const navOk = (view) => { const n = NAV.find((x) => x.view === view); return !!n && isNavItemVisible(n, { isExternal, can, myGrantedModules, qaEnabled }); };
  const onDesk = navOk('tickets');
  const tickets = useSource(term, wantContent && (onDesk || navOk('support')),
    (t) => api.searchTicketsEverywhere(t, 5).then((r) => r?.tickets));
  const notes = useSource(term, wantContent && navOk('dashboard'),
    (t) => api.searchNotes(t, 5).then((r) => r?.notes));
  const docs = useSource(term, wantContent && navOk('documents') && (!canAccessModule || !!canAccessModule('documents', 'administrator')),
    (t) => api.searchDocumentLibrary(t, 5));
  const directory = useSource(term, wantContent && !isExternal,
    (t) => api.getPeopleDirectory().then((r) => matchPeople(r, t)));
  const searching = wantContent && (answer.term !== term || kbAnswer.term !== term || jobAnswer.term !== term
    || !tickets.ready || !notes.ready || !docs.ready || !directory.ready);

  const groups = useMemo(() => {
    if (!live) return [];
    const match = (...fields) => fields.some(f => (f || '').toLowerCase().includes(q));
    const out = [];
    // A group's `note` is information ("and 4 more projects"); a "See all"
    // line is a ROW (more: true) so the keyboard reaches it too.
    const add = (key, label, rows, note = '') => { if (rows.length) out.push({ key, label, rows, note }); };

    const toTasks = (sub) => navigate('tasks', sub);
    // People: the Task module's answer as it came, then the directory's
    // matches it did not carry - a person is listed once.
    const taskPeople = hits.people || [];
    const named = new Set(taskPeople.map((p) => String(p.email || '').toLowerCase()));
    const morePeople = directory.rows.filter((p) => !named.has(p.email.toLowerCase()));
    const people = [...taskPeople, ...morePeople.slice(0, Math.max(0, PEOPLE_MAX - taskPeople.length))];
    const peopleTotal = Math.max(hits.totals?.people || 0, taskPeople.length) + morePeople.length;
    for (const g of CONTENT_GROUPS) {
      const list = g.key === 'people' ? people : (hits[g.key] || []);
      const total = g.key === 'people' ? peopleTotal : (hits.totals?.[g.key] || 0);
      const rows = list.map((item) => {
        if (g.key === 'tasks') return {
          key: `task:${item.id}`, Icon: Check, title: item.title, done: !!item.completed,
          detail: [item.parentTitle ? `in ${item.parentTitle}` : '', item.projectName].filter(Boolean).join(' · '),
          save: { kind: 'task', to: { task: String(item.id) } },
          run: () => { toTasks('mine'); setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId: item.id } })), 0); },
        };
        if (g.key === 'jobs') return {
          key: `job:${item.id}`, Icon: HardHat, title: item.name,
          detail: [JOB_TYPE_LABEL[item.jobType] || 'Project', item.code, item.address].filter(Boolean).join(' · '),
          save: { kind: 'job', to: { view: 'ops', sub: `project:${item.id}` } },
          run: () => navigate('ops', `project:${item.id}`),
        };
        if (g.key === 'people') return {
          key: `person:${item.email}`, Icon: User, title: item.name, detail: item.email,
          save: { kind: 'person', to: { person: item.email, name: item.name } },
          // A person opens their page in Tasks - their tasks - for anyone
          // with the Task module (Neil, Oct 18 2026); the Contact Directory
          // card for everyone else.
          run: () => (canTasks ? openPersonTasks(item.email, item.name) : openContact(item.email)),
        };
        const Icon = item.archived ? Archive : g.key === 'teams' ? Users : g.key === 'portfolios' ? Briefcase : LayoutDashboard;
        return {
          key: `${g.key}:${item.id}`, Icon, title: item.name, tag: item.archived ? 'Archived' : '',
          run: () => toTasks(g.key),
        };
      });
      let note = '';
      if (total > list.length) {
        if (g.key === 'tasks') rows.push({
          key: 'more:tasks', more: true, title: `See all ${total} tasks`,
          run: () => { toTasks('mine'); setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:tasks-search', { detail: { q: (query || '').trim() } })), 0); },
        });
        else note = `and ${total - list.length} more ${g.label.toLowerCase()}`;
      }
      add(g.key, g.label, rows, note);
    }

    const ticketRows = tickets.rows.map((t) => {
      // The server says where it opens; the desk only for someone the left menu gives it to.
      const view = t.view === 'tickets' && onDesk ? 'tickets' : 'support';
      return {
        key: `ticket:${t.id}`, Icon: TicketToken, title: t.subject || 'Untitled Ticket',
        detail: [ticketNo(t.code), TICKET_STATUS_LABELS[t.status] || statusLabel(t.status)].filter(Boolean).join(' · '),
        // An Ask HR ticket is found and opened, never kept: its subject is
        // not copied into Favorites or Recent.
        save: t.confidential ? undefined : { kind: 'ticket', to: { ticket: String(t.id), view } },
        run: () => openTicket(t.id, view),
      };
    });
    add('tickets', 'Tickets', ticketRows);

    add('notes', 'Notes', notes.rows.map((n) => {
      const board = n.kind === 'board';
      return {
        key: `note:${n.id}`, Icon: board ? PenTool : StickyNote, title: noteTitle(n),
        detail: [board ? 'Board' : 'Note', n.kind === 'daily' && n.day ? formatDate(n.day) : '', n.mine ? '' : 'Shared With You'].filter(Boolean).join(' · '),
        save: { kind: board ? 'board' : 'note', to: { view: 'dashboard', sub: `notes:${n.id}` } },
        run: () => navigate('dashboard', `notes:${n.id}`),
      };
    }));

    add('documents', 'Documents', docs.rows.map((d) => ({
      key: `doc:${d.id}`, Icon: FileText, title: d.title || 'Untitled Document', tag: d.status === 'archived' ? 'Archived' : '',
      detail: [d.docKind === 'sheet' ? 'Sheet' : d.kind === 'envelope' ? 'Nexus Sign' : 'Document', d.forName, d.company].filter(Boolean).join(' · '),
      save: { kind: 'document', to: { doc: String(d.id) } },
      run: () => openDocument(String(d.id)),
    })));

    const itemRows = [];
    for (const i of items) {
      if (itemRows.length >= 5) break;
      // Employees only ever see catalog (temporary) items - permanently
      // assigned equipment never surfaces in their search (Pranshu, Jun 16).
      if (!isManager && i.ownershipType !== 'transient') continue;
      if (match(i.name, i.make, i.model, i.itemType, i.location)) itemRows.push({
        key: `item:${i.id}`, Icon: Package, title: i.name,
        detail: [i.itemType, i.location, itemStatusLabel(i)].filter(Boolean).join(' · '),
        // Opens the item record (Items redesign, 11/02/2026: <tab>@<itemId>).
        save: { kind: 'item', to: { view: 'inventory', sub: `${isManager ? 'inventory' : 'borrow'}@${i.id}` } },
        run: () => navigate('inventory', `${isManager ? 'inventory' : 'borrow'}@${i.id}`),
      });
    }
    add('items', 'Items', itemRows);

    const checkoutRows = [];
    for (const c of checkouts) {
      if (checkoutRows.length >= 4) break;
      // Employees only see their OWN checkouts in search (Pranshu, Jun 16).
      if (!isManager && (c.requestedByEmail || '').toLowerCase() !== (myEmail || '').toLowerCase()) continue;
      if (match(c.itemName, c.requestedBy)) checkoutRows.push({
        key: `checkout:${c.id}`, Icon: ClipboardList, title: c.itemName,
        detail: [c.requestedBy, statusLabel(c.status)].filter(Boolean).join(' · '),
        save: { kind: 'checkout', to: { view: 'inventory', sub: `${isManager ? 'requests' : 'mystuff'}@${c.itemId}` } },
        run: () => navigate('inventory', `${isManager ? 'requests' : 'mystuff'}@${c.itemId}`),
      });
    }
    add('checkouts', 'Checkouts', checkoutRows);

    const reqRows = [];
    for (const r of requisitions) {
      if (reqRows.length >= 4) break;
      if (match(r.item, r.employeeName, r.id)) reqRows.push({
        key: `req:${r.id}`, Icon: ShoppingCart, title: `${r.item} - ${r.employeeName}`,
        detail: [r.id, statusLabel(r.status)].filter(Boolean).join(' · '),
        save: { kind: 'request', to: { view: 'myhr', sub: 'purchase' } },
        run: () => navigate('myhr', 'purchase'),
      });
    }
    add('requests', 'Purchase Requests', reqRows);

    add('kb', 'Knowledge Base', kbRows.map((p) => ({
      key: `kb:${p.id}`, Icon: BookOpen, title: p.title,
      detail: [p.type_label, p.code, (p.collection || []).map((c) => c.name).join(' / ')].filter(Boolean).join(' · '),
      save: { kind: 'kb', to: { view: 'sop', sub: `page:${encodeURIComponent(p.id)}` } },
      run: () => navigate('sop', `page:${encodeURIComponent(p.id)}`),
    })));

    const linkRows = [];
    for (const l of links.company) {
      if (linkRows.length >= 5) break;
      if (match(l.name, l.description, hostOf(l.url), ...(l.categories || []))) linkRows.push({
        key: `link:external:${l.id}`, icon: linkIcon(l.url), title: l.name,
        detail: [(l.categories || [])[0], hostOf(l.url)].filter(Boolean).join(' · '),
        save: { kind: 'link', to: { url: l.url, link: `external:${l.id}` } },
        run: () => openSite(l.url, `external:${l.id}`),
      });
    }
    for (const l of links.personal) {
      if (linkRows.length >= 8) break;
      if (match(l.name, l.description, hostOf(l.url), l.category)) linkRows.push({
        key: `link:personal:${l.id}`, icon: linkIcon(l.url), title: l.name,
        detail: ['Personal', hostOf(l.url)].filter(Boolean).join(' · '),
        save: { kind: 'link', to: { url: l.url, link: `personal:${l.id}` } },
        run: () => openSite(l.url, `personal:${l.id}`),
      });
    }
    add('links', 'Links', linkRows);

    // Quick Actions: the bolt's list for this person, run through the bolt.
    // Not saved to Favorites or Recent - an action is not a record.
    const actions = findActions(visibleActions(role), term);
    add('actions', 'Quick Actions', actions.map(({ item }) => ({
      key: `action:${item.key}`, Icon: item.Icon, title: item.label,
      run: () => runQuickAction(item.key),
    })));

    add('pages', 'Pages', screens.filter(s => match(s.label, s.context, s.view)).slice(0, 6).map(s => ({
      key: `page:${s.view}:${s.sub || ''}`, Icon: LayoutDashboard, title: s.label, detail: s.context,
      save: { kind: 'page', to: { view: s.view, sub: s.sub || undefined } },
      run: () => navigate(s.view, s.sub),
    })));
    // What leads: a typed ticket number that is a ticket's, and an action
    // whose name is plainly what was typed. Everything else keeps its place.
    const lead = (key) => { const i = out.findIndex((g) => g.key === key); if (i > 0) out.unshift(...out.splice(i, 1)); };
    if (tickets.rows[0]?.exact) lead('tickets');
    if (actions[0]?.starts) lead('actions');
    return out;
  }, [live, q, query, term, screens, hits, kbRows, items, checkouts, requisitions, isManager, myEmail, canTasks, links, tickets.rows, notes.rows, docs.rows, directory.rows, onDesk, myRole, isExternal, myGrantedModules]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Favorites and Recents ────────────────────────────────────────────────
  const [savedRaw, setSaved] = useTableValue('search', 'data', EMPTY_SAVED);
  const favorites = useMemo(() => cleanList(savedRaw?.favorites, FAV_MAX), [savedRaw]);
  const recents = useMemo(() => cleanList(savedRaw?.recents, RECENT_MAX), [savedRaw]);
  const favKeys = useMemo(() => new Set(favorites.map((f) => f.key)), [favorites]);
  const runTo = (to) => {
    if (to.task) {
      navigate('tasks', 'mine');
      setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId: to.task } })), 0);
    } else if (to.person) {
      if (canTasks) openPersonTasks(to.person, to.name); else openContact(to.person);
    } else if (to.ticket) {
      openTicket(to.ticket, to.view === 'tickets' && onDesk ? 'tickets' : 'support');
    } else if (to.doc) {
      openDocument(to.doc);
    } else if (to.url) {
      openSite(to.url, to.link);
    } else navigate(to.view, to.sub);
  };
  const entryOf = (row) => (row?.save ? cleanEntry({ ...row.save, key: row.key, title: row.title, detail: row.detail }) : null);
  const write = (next) => {
    try { setSaved(next); } catch { /* the lists are a convenience: a failed save never blocks the pick */ }
  };
  const remember = (row) => {
    const e = entryOf(row);
    if (!e) return;
    write({ favorites, recents: [e, ...recents.filter((r) => r.key !== e.key)].slice(0, RECENT_MAX) });
  };
  const toggleFavorite = (row) => {
    const e = entryOf(row);
    if (!e) return;
    const next = favKeys.has(e.key) ? favorites.filter((f) => f.key !== e.key) : [e, ...favorites].slice(0, FAV_MAX);
    write({ favorites: next, recents });
  };
  const isFavorite = (row) => !!row?.key && favKeys.has(row.key);
  const savedGroups = useMemo(() => {
    if (!enabled || live) return [];
    const toRow = (e) => ({ key: e.key, Icon: SAVED_ICON[e.kind], icon: e.to.url ? linkIcon(e.to.url) : undefined, title: e.title, detail: e.detail, save: e, run: () => runTo(e.to) });
    const out = [];
    if (favorites.length) out.push({ key: 'favorites', label: 'Favorites', rows: favorites.map(toRow), note: '' });
    const recent = recents.filter((r) => !favKeys.has(r.key));
    if (recent.length) out.push({ key: 'recents', label: 'Recent', rows: recent.map(toRow), note: '' });
    return out;
  }, [enabled, live, favorites, recents, favKeys, canTasks, onDesk]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = live ? groups : savedGroups;
  const rows = useMemo(() => shown.flatMap(g => g.rows), [shown]);
  return { groups: shown, rows, searching, count: rows.length, remember, toggleFavorite, isFavorite, saved: !live };
}
