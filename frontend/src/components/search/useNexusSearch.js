import { useEffect, useMemo, useState } from 'react';
import { Check, LayoutDashboard, Archive, User, Package, ClipboardList, ShoppingCart, Briefcase, Users } from 'lucide-react';
import { useRole } from '../../contexts/RoleContext';
import { useInventory } from '../../contexts/InventoryContext';
import { useRequisitions } from '../../contexts/RequisitionContext';
import { NAV, isNavItemVisible } from '../Sidebar';
import { SUBMENUS } from '../MobileMenu';
import { openContact } from '../../lib/contactNav';
import { api } from '../../api';

// ONE search for the whole app (Neil, Oct 14 2026). The header bar on every
// module and the phone sheet both draw from this hook, so what a search
// finds, how it is grouped and where a pick goes never differs by screen.
//
// Sources, in the order the groups are shown:
//   Tasks / Projects / People / Portfolios / Teams - the Task module's
//                content through /tasks search (debounced, 2+ characters).
//   Items / Checkouts / Purchase Requests - from the data the app already
//                holds in its contexts (local, instant).
//   Pages      - the sidebar's screens and their sections, visible exactly
//                when the sidebar shows them (local, instant). Last, so
//                Enter on a typed title opens the thing, not the module
//                whose name happens to contain the same letters.

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
];
const EMPTY_HITS = { tasks: [], projects: [], people: [], portfolios: [], teams: [] };

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

const navigate = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub ?? undefined } }));

export function useNexusSearch(query, { enabled = true } = {}) {
  const { myRole, isExternal, can, myGrantedModules, myEmail } = useRole();
  const { items = [], checkouts = [] } = useInventory() || {};
  const { requisitions = [] } = useRequisitions() || {};
  const q = (query || '').trim().toLowerCase();
  const live = enabled && q.length > 0;
  const isManager = can?.('manager');
  const qaEnabled = useQaEnabled(live);

  // Screens registry: the sidebar's NAV, visible exactly as the sidebar
  // shows it, plus each module's sections. Built only while a search is
  // open and typed (`can` is a new function each render, so it is keyed on
  // the role it reads instead).
  const screens = useMemo(() => {
    if (!live) return [];
    const visible = NAV.filter(i => !i.divider && isNavItemVisible(i, { isExternal, can, myGrantedModules, qaEnabled }));
    const out = [];
    for (const item of visible) {
      out.push({ view: item.view, sub: null, label: item.label, context: null });
      const entry = SUBMENUS[item.view];
      const subs = !entry ? null : Array.isArray(entry) ? entry : (can?.('manager') ? entry.manager : entry.employee);
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
  const hits = wantContent && answer.term === term ? answer.data : EMPTY_HITS;
  const searching = wantContent && answer.term !== term;

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
          run: () => { toTasks('mine'); setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId: item.id } })), 0); },
        };
        if (g.key === 'people') return {
          key: `person:${item.email}`, Icon: User, title: item.name, detail: item.email,
          // A person opens their Contact Directory card (Oct 2026).
          run: () => openContact(item.email),
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
        run: () => navigate('inventory', can?.('supervisor') ? 'manage' : 'catalog'),
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
        run: () => navigate('inventory', isManager ? 'checkouts' : 'myitems'),
      });
    }
    add('checkouts', 'Checkouts', checkoutRows);

    const reqRows = [];
    for (const r of requisitions) {
      if (reqRows.length >= 4) break;
      if (match(r.item, r.employeeName, r.id)) reqRows.push({
        key: `req:${r.id}`, Icon: ShoppingCart, title: `${r.item} - ${r.employeeName}`,
        detail: [r.id, statusLabel(r.status)].filter(Boolean).join(' · '),
        run: () => navigate('purchase', 'log'),
      });
    }
    add('requests', 'Purchase Requests', reqRows);

    add('pages', 'Pages', screens.filter(s => match(s.label, s.context, s.view)).slice(0, 6).map(s => ({
      key: `page:${s.view}:${s.sub || ''}`, Icon: LayoutDashboard, title: s.label, detail: s.context,
      run: () => navigate(s.view, s.sub),
    })));
    return out;
  }, [live, q, query, screens, hits, items, checkouts, requisitions, isManager, myEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => groups.flatMap(g => g.rows), [groups]);
  return { groups, rows, searching, count: rows.length };
}
