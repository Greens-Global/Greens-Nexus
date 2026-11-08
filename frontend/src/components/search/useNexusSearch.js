import { createElement, useEffect, useMemo, useState } from 'react';
import { Check, LayoutDashboard, Archive, User, Package, ClipboardList, ShoppingCart, Briefcase, Users, BookOpen, HardHat, Link2 } from 'lucide-react';
import { LinkIcon } from '../LinkIcon.jsx';
import { useRole } from '../../contexts/RoleContext';
import { useInventory } from '../../contexts/InventoryContext';
import { useRequisitions } from '../../contexts/RequisitionContext';
import { NAV, isNavItemVisible } from '../Sidebar';
import { visibleSubs } from '../MobileMenu';
import { openContact } from '../../lib/contactNav';
import { openPersonTasks } from '../../lib/personTasksNav';
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
//   Items / Checkouts / Purchase Requests - from the data the app already
//                holds in its contexts (local, instant).
//   Links      - the company links and the person's Personal Links
//                (11/08/2026), loaded once per session while a search is
//                typed; a pick opens the site in a new tab and records the
//                click the way the Links page does.
//   Pages      - the sidebar's screens and their sections, visible exactly
//                when the sidebar shows them (local, instant). Last, so
//                Enter on a typed title opens the thing, not the module
//                whose name happens to contain the same letters.
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
export const SEARCH_HINT = 'Pages, tasks, projects, people, items and requests.';
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
const SAVED_ICON = { task: Check, job: HardHat, person: User, item: Package, checkout: ClipboardList, request: ShoppingCart, kb: BookOpen, page: LayoutDashboard, link: Link2 };
// What the store hands back is the person's own JSON: only well-formed entries count.
const cleanTo = (to) => {
  if (!to || typeof to !== 'object') return null;
  if (typeof to.task === 'string' && to.task) return { task: to.task.slice(0, 100) };
  if (typeof to.person === 'string' && to.person.includes('@')) return { person: to.person.slice(0, 200), name: String(to.name || '').slice(0, 200) };
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
  const { myRole, isExternal, can, canAccessModule, myGrantedModules, myEmail } = useRole();
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
  const searching = wantContent && (answer.term !== term || kbAnswer.term !== term || jobAnswer.term !== term);

  const groups = useMemo(() => {
    if (!live) return [];
    const match = (...fields) => fields.some(f => (f || '').toLowerCase().includes(q));
    const out = [];
    // A group's `note` is information ("and 4 more projects"); a "See all"
    // line is a ROW (more: true) so the keyboard reaches it too.
    const add = (key, label, rows, note = '') => { if (rows.length) out.push({ key, label, rows, note }); };

    const toTasks = (sub) => navigate('tasks', sub);
    for (const g of CONTENT_GROUPS) {
      const list = hits[g.key] || [];
      const total = hits.totals?.[g.key] || 0;
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

    add('pages', 'Pages', screens.filter(s => match(s.label, s.context, s.view)).slice(0, 6).map(s => ({
      key: `page:${s.view}:${s.sub || ''}`, Icon: LayoutDashboard, title: s.label, detail: s.context,
      save: { kind: 'page', to: { view: s.view, sub: s.sub || undefined } },
      run: () => navigate(s.view, s.sub),
    })));
    return out;
  }, [live, q, query, screens, hits, kbRows, items, checkouts, requisitions, isManager, myEmail, canTasks, links]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [enabled, live, favorites, recents, favKeys, canTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = live ? groups : savedGroups;
  const rows = useMemo(() => shown.flatMap(g => g.rows), [shown]);
  return { groups: shown, rows, searching, count: rows.length, remember, toggleFavorite, isFavorite, saved: !live };
}
