import { useEffect, useMemo, useState } from 'react';
import { Check, LayoutDashboard, Archive, User, Package, ClipboardList, ShoppingCart, Briefcase, Users } from 'lucide-react';
import { useRole } from '../../contexts/RoleContext';
import { useInventory } from '../../contexts/InventoryContext';
import { useRequisitions } from '../../contexts/RequisitionContext';
import { NAV } from '../Sidebar';
import { SUBMENUS } from '../MobileMenu';
import { openContact } from '../../lib/contactNav';
import { api } from '../../api';

// ONE search for the whole app (Neil, Oct 14 2026). The header bar on every
// module and the phone sheet both draw from this hook, so what a search
// finds, how it is grouped and where a pick goes never differs by screen.
//
// Sources, in the order the groups are shown:
//   Pages      - the sidebar's screens and their sections, role-gated like
//                the sidebar itself (local, instant).
//   Tasks / Projects / People / Portfolios / Teams - the Task module's
//                content through /tasks search (debounced, 2+ characters).
//   Items / Checkouts / Purchase Requests - from the data the app already
//                holds in its contexts (local, instant).

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
  checked_out: 'Checked out', permanently_assigned: 'Perm. Assigned', retired: 'Retired',
};
function itemStatusLabel(item) {
  const s = (item.ownershipType === 'permanent' && item.status === 'available')
    ? ((!item.assignedToEmail && item.location) ? 'location_assigned' : 'unassigned')
    : item.status;
  return ITEM_STATUS_LABELS[s] || (s || '').replace(/_/g, ' ');
}

const navigate = (view, sub) => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub ?? undefined } }));

export function useNexusSearch(query, { enabled = true } = {}) {
  const { can, myGrantedModules, myEmail } = useRole();
  const { items = [], checkouts = [] } = useInventory() || {};
  const { requisitions = [] } = useRequisitions() || {};
  const q = (query || '').trim().toLowerCase();
  const isManager = can?.('manager');

  // Screens registry: sidebar NAV (same role gating) + each module's sections.
  const screens = useMemo(() => {
    const visible = NAV.filter(i => !i.divider && (!i.minRole || can?.('administrator') || myGrantedModules?.has(i.view)));
    const out = [];
    for (const item of visible) {
      out.push({ view: item.view, sub: null, label: item.label, context: null });
      const entry = SUBMENUS[item.view];
      const subs = !entry ? null : Array.isArray(entry) ? entry : (can?.('manager') ? entry.manager : entry.employee);
      if (subs) for (const s of subs) out.push({ view: item.view, sub: s.sub, label: s.label, context: item.label });
    }
    return out;
  }, [can, myGrantedModules]);

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
    if (!q) return [];
    const match = (...fields) => fields.some(f => (f || '').toLowerCase().includes(q));
    const out = [];
    const add = (key, label, rows, more = null) => { if (rows.length) out.push({ key, label, rows, more }); };

    add('pages', 'Pages', screens.filter(s => match(s.label, s.context, s.view)).slice(0, 6).map(s => ({
      key: `page:${s.view}:${s.sub || ''}`, Icon: LayoutDashboard, title: s.label, detail: s.context,
      run: () => navigate(s.view, s.sub),
    })));

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
      let more = null;
      if (total > list.length) {
        more = g.key === 'tasks'
          ? { label: `See all ${total} tasks`, run: () => { toTasks('mine'); setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:tasks-search', { detail: { q: (query || '').trim() } })), 0); } }
          : { label: `and ${total - list.length} more ${g.label.toLowerCase()}` };
      }
      add(g.key, g.label, rows, more);
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
        detail: [c.requestedBy, (c.status || '').replace(/_/g, ' ')].filter(Boolean).join(' · '),
        run: () => navigate('inventory', isManager ? 'checkouts' : 'myitems'),
      });
    }
    add('checkouts', 'Checkouts', checkoutRows);

    const reqRows = [];
    for (const r of requisitions) {
      if (reqRows.length >= 4) break;
      if (match(r.item, r.employeeName, r.id)) reqRows.push({
        key: `req:${r.id}`, Icon: ShoppingCart, title: `${r.item} - ${r.employeeName}`,
        detail: [r.id, (r.status || '').replace(/_/g, ' ')].filter(Boolean).join(' · '),
        run: () => navigate('purchase', 'log'),
      });
    }
    add('requests', 'Purchase Requests', reqRows);
    return out;
  }, [q, query, screens, hits, items, checkouts, requisitions, can, isManager, myEmail]);

  const rows = useMemo(() => groups.flatMap(g => g.rows), [groups]);
  return { groups, rows, searching, count: rows.length };
}
