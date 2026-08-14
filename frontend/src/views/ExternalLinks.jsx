import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { PersonalLockGate } from '../credvault/vaultShared';
import { LinkIcon, ICON_MAP } from '../components/LinkIcon.jsx';
import { useLinkViews } from './useLinkViews';
import {
  Search, Plus, Pencil, Trash2, X, Star, Globe, LayoutGrid, List,
  Settings2, Bookmark, History,
  GripVertical, AlertTriangle, Upload, FolderOpen, Download, Lock, KeyRound, Info,
  FolderPlus, Check, RefreshCw, SlidersHorizontal, Save,
  MoreHorizontal, Copy,
} from 'lucide-react';

// ── Personal, client-side only (favorites / recents / view density) ──
// Deliberately NOT backend fields - these are per-browser shortcuts, same
// spirit as a browser bookmarks bar, so they stay snappy with zero API calls
// and never need a migration. Keyed by email so a shared kiosk PC doesn't
// bleed one person's shortcuts into another's session.
const lsKey = (email, kind) => `nexus:extlinks:${kind}:${(email || 'anon').toLowerCase()}`;
function readIds(email, kind) {
  try { return JSON.parse(localStorage.getItem(lsKey(email, kind)) || '[]'); } catch { return []; }
}
function writeIds(email, kind, ids) {
  try { localStorage.setItem(lsKey(email, kind), JSON.stringify(ids)); } catch { /* storage disabled/full - shortcuts just won't persist */ }
}

// Mirrors the old start.greensglobal.com department dropdown (Neil, Aug 12) -
// "Development" deliberately excluded per that ask. Admin-managed now (Aug
// 14, "give the option to add, rename and remove any department and
// categories" in Manage) via external-links/taxonomy, no longer a
// hardcoded frontend constant - see ExternalLinks' own `taxonomy` state
// below, fetched on mount and threaded down as props everywhere a
// department/category picker needs the curated list.

// Curated icon set an admin picks from when adding/editing a link - kept to
// business-app-shaped icons rather than exposing all ~1500 lucide icons.
const ICON_OPTIONS = [
  'Link2', 'Mail', 'Calendar', 'Users2', 'FolderKanban', 'Rocket', 'MessagesSquare',
  'BookOpen', 'HelpCircle', 'Clock', 'FileSpreadsheet', 'Zap', 'Wifi', 'Landmark',
  'Wallet', 'Building2', 'Newspaper', 'GraduationCap', 'LineChart', 'Briefcase',
  'Shield', 'Globe', 'Megaphone', 'HardHat', 'Ruler', 'CreditCard', 'PiggyBank',
  'Receipt', 'ClipboardList', 'Headphones', 'Video', 'CheckSquare', 'Cloud',
  'Presentation', 'Gauge', 'Bird', 'Warehouse',
];
// Duplicate-URL detection (Add Link / Add Personal Link) - normalizes away
// the differences that would otherwise let the same site get added twice
// (http vs https, www. vs not, a trailing slash, mixed case) without masking
// genuinely different pages on the same host (different path = different
// link). Mirrors _normalize_url in external_links.py - keep both in sync.
function normalizeUrl(u) {
  try {
    const withProto = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    const parsed = new URL(withProto);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return (u || '').trim().toLowerCase();
  }
}

// Stable color per category, cycling the app's existing --color-* tokens
// (same palette InventoryManagement's TYPE_META draws from) so every tile's
// accent is consistent without an admin having to pick a color by hand.
const PALETTE = ['blue', 'green', 'orange', 'purple', 'red', 'gold'];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function colorFor(category) {
  const tone = PALETTE[hashStr(category || '') % PALETTE.length];
  return { fg: `hsl(var(--color-${tone}))`, bg: `hsla(var(--color-${tone}),0.12)` };
}

// Company and Personal Links share one launcher/folders now (Aug 13), but
// stay two different backend records with two different ownership models -
// a folder entry is just {item_type, item_id}, so every place that renders
// one needs to resolve which table it came from and which actions/who's
// allowed to use them. Centralized here once rather than re-branching this
// at every call site: a Personal Link is always fully editable by its owner
// (that's the whole point of it being personal), a Company Link is only
// editable by someone who already holds the existing manager/admin grant -
// personalization (position, folder, favorite) never changes that.
// itemsById is {external: Map<id,link>, personal: Map<id,link>} - a plain
// Map<id,link> stops being safe once two tables share the same autoincrement
// id space in one view.
function resolveEntryLink(itemsById, entry) {
  return entry.item_type === 'personal' ? itemsById.personal.get(entry.item_id) : itemsById.external.get(entry.item_id);
}
// The default order for a pristine (never-arranged) tab, expressed as
// layout `items` entries - used both to seed a user's first mutation (see
// makeSeededMutate) and to render the very first paint before any mutation
// has happened at all. Company Links default to pinned first, then admin
// sort_order, then name (mirrors Manage's own list); Personal Links have no
// pin concept, so just sort_order then name.
function defaultOrderItems(links, sourceType = 'external') {
  const ordered = [...links].sort((a, b) => (sourceType === 'external'
    ? (Number(b.is_pinned) - Number(a.is_pinned)) || (a.sort_order - b.sort_order) || a.name.localeCompare(b.name)
    : (a.sort_order - b.sort_order) || a.name.localeCompare(b.name)));
  return ordered.map((l, i) => ({ item_type: sourceType, item_id: l.id, folder_id: null, position: i }));
}
// Whether this tab (external|personal) has any real customization yet -
// NOT the hook's isCustomized flag alone, which just means "a layout row
// exists" (true the moment someone favorites a single link, since favorites
// live in the same document) - using that directly would dump a user into
// an otherwise-empty custom view the first time they favorite anything,
// before they ever touched ordering.
function hasCustomOrderFor(layout, sourceType) {
  return layout.items.some(i => i.item_type === sourceType)
    || layout.folders.some(f => (f.item_type || 'external') === sourceType);
}
function entryActions(entry, itemsById, ctx) {
  const link = resolveEntryLink(itemsById, entry);
  if (!link) return null;
  if (entry.item_type === 'personal') {
    return {
      // No favorite toggle and no "move to folder" picker on Personal Links
      // (Aug 14 - "i don't have to see bookmark, folder icon we hover over
      // the application") - just grip/edit/delete. Folders still work by
      // drag, this only drops the two extra hover-row icons.
      link, sourceType: 'personal', color: PERSONAL_COLOR, canManage: true, canDelete: true,
      vaultLinked: !!link.vault_cred_id,
      onOpen: () => ctx.onOpenPersonal(link), onEdit: () => ctx.onEditPersonal(link), onDelete: () => ctx.onDeletePersonal(link),
    };
  }
  return {
    // Edit/Delete deliberately omitted for Company Links (Neil, Aug 13) -
    // Manage is the one place those live now, not the tile hover row.
    // canManage still gates whether Manage itself is reachable elsewhere on
    // the page; it's just no longer what shows/hides an inline pencil here.
    link, sourceType: 'external', color: colorFor(link.category), canManage: ctx.canManage, canDelete: ctx.canDelete,
    vaultLinked: false,
    isFavorite: ctx.favoriteExternalIds.includes(link.id),
    onToggleFavorite: () => ctx.toggleFavorite(link.id),
    onOpen: () => ctx.onOpenExternal(link),
  };
}

const emptyForm = { name: '', url: '', category: '', description: '', department: '', company: '', icon: 'Link2', is_pinned: false };

export default function ExternalLinks() {
  const { canAccessModule, myEmail } = useRole();
  const canManage = canAccessModule('external-links', 'manager', 'editor');
  const canDelete = canAccessModule('external-links', 'administrator', 'full');

  const [links, setLinks] = useState(null);
  const [meta, setMeta] = useState({ departments: [], categories: [] });
  const [error, setError] = useState(false);
  const [banner, setBanner] = useState(null); // { kind: 'ok'|'err', text }

  const [department, setDepartment] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');

  // Personal Links' own filter bar (Aug 14) - separate state from the
  // Company filters above so switching tabs doesn't clobber either one's
  // in-progress search/filter.
  const [pDepartment, setPDepartment] = useState('');
  const [pCategory, setPCategory] = useState('');
  const [pq, setPq] = useState('');

  // List/Tile view toggle (Aug 14) - two independent toggles, one for the
  // main grid (beside All Categories) and one for the My Favorites strip
  // (beside its own header), since a user might want the big grid compact
  // but favorites still as a quick-glance pill row, or vice versa. Tile is
  // the only mode Customize/drag works in - list is read-only browsing, so
  // switching to Customize forces tile view (see the `editing` effect below).
  const [gridView, setGridView] = useState('tile');
  const [favView, setFavView] = useState('tile');
  useEffect(() => { if (editing) setGridView('tile'); }, [editing]);

  // Company list for the filter/Add-Link dropdown, sourced from the same
  // curated People directory every other company/department picker in Nexus
  // uses (CLAUDE.md: never M365/GAL-derived) - NOT the HR module's own
  // /hr/entities endpoint, which is gated to HR viewers and would leave most
  // managers unable to even see the option list when adding a link.
  const [companies, setCompanies] = useState([]);
  useEffect(() => {
    api.getPeopleDirectory().then(dir => {
      const map = new Map();
      (dir || []).forEach(p => { if (p.company && !map.has(p.company)) map.set(p.company, p.companyName || p.company); });
      setCompanies([...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => setCompanies([]));
  }, []);
  const companyName = (id) => companies.find(c => c.id === id)?.name || id;

  const [modal, setModal] = useState(null); // { mode: 'add'|'edit', form, id }
  const [saving, setSaving] = useState(false);
  const [showManage, setShowManage] = useState(false);

  // Admin-managed Department/Category picker options (Aug 14) - shared by
  // both Company and Personal Links now that Personal Links also carry
  // department/category. `taxonomy.departments`/`.categories` are the raw
  // {id, kind, name} rows (Manage needs the id to rename/delete); the plain
  // name arrays below are what every dropdown/datalist/filter actually maps
  // over.
  const [taxonomy, setTaxonomy] = useState({ departments: [], categories: [] });
  const loadTaxonomy = useCallback(() => {
    api.getExternalLinksTaxonomy().then(t => setTaxonomy(t || { departments: [], categories: [] })).catch(() => {});
  }, []);
  useEffect(() => { loadTaxonomy(); }, [loadTaxonomy]);
  const departmentNames = useMemo(() => taxonomy.departments.map(d => d.name), [taxonomy]);
  const categoryNames = useMemo(() => taxonomy.categories.map(c => c.name), [taxonomy]);

  const addTaxonomy = async (kind, name) => {
    await api.createExternalLinkTaxonomy(kind, name);
    loadTaxonomy();
  };
  const renameTaxonomy = async (id, name) => {
    await api.renameExternalLinkTaxonomy(id, name);
    loadTaxonomy();
    load(); // a rename bulk-updates every link using the old name server-side - resync so the grid reflects it immediately
  };
  const deleteTaxonomy = async (id) => {
    await api.deleteExternalLinkTaxonomy(id);
    loadTaxonomy();
  };

  // Company/Personal split (same "which vault am I looking at" pattern as the
  // Credential Vault's Company/Personal toggle) - Personal Links used to sit
  // as a strip pinned above the shared directory regardless of what an
  // employee was actually browsing, which read as clutter ahead of the thing
  // most people open this view for. Now it's its own section, switched to
  // deliberately rather than always-on.
  const [section, setSection] = useState('company'); // 'company' | 'personal'

  // Personal Links - private, owner-scoped rows from their own table (not
  // client-local like favorites/recents above): visible only to the signed-in
  // user, both by API filtering (owner_email) and by never being surfaced
  // anywhere in Manage/Needs Attention/the command palette, which all stay
  // scoped to the shared ExternalLink directory.
  const [personalLinks, setPersonalLinks] = useState(null);
  const [personalModal, setPersonalModal] = useState(null); // { mode: 'add'|'edit', form, id }
  const [personalSaving, setPersonalSaving] = useState(false);

  // Copy-and-go: a Personal Link can still be paired with one of the
  // owner's own Credential Vault personal credentials on links that already
  // have one set (opening it reveals + copies the password to the
  // clipboard first, then opens the site) - the Add/Edit modal's own
  // picker for attaching a NEW one was removed (Aug 14, "i don't want
  // password section" in that modal). No in-page autofill either way (a
  // website can't reach into another origin's login form; that needs a
  // browser extension, which this is not).
  const [pendingVaultOpen, setPendingVaultOpen] = useState(null); // link waiting on Personal Vault unlock
  const [showVaultLockGate, setShowVaultLockGate] = useState(false);

  // Personalization (Aug 13, multi-view Aug 14) - app ordering, folders,
  // and favorites are backend-persisted per account as named, switchable
  // "Link Views" (see useLinkViews.js), not localStorage, so they follow
  // the signed-in user across devices/browsers. Recent stays localStorage-
  // only on purpose - it's an auto-derived, ephemeral trail (last 8
  // clicked), not something deliberately arranged.
  const {
    views, activeId, activeView, layout, loading: layoutLoading, editing, dirty, saveError,
    setEditing, mutate, mutateNow, switchView, save: saveView, saveAsNew, createNewView,
    setDefaultView, clearDefaultView, removeView, renameView, toggleFavorite: toggleFavoriteRaw,
    clearSaveError, reload: reloadViews,
  } = useLinkViews();
  useEffect(() => {
    if (saveError) { setBanner({ kind: 'err', text: saveError }); clearSaveError(); }
  }, [saveError, clearSaveError]);

  // Favorites can reference either a Company Link or a Personal Link (their
  // ids are both plain autoincrement ints on separate tables, hence the
  // item_type tag) - derive the plain-id arrays each call site already
  // expects (favorites.includes(l.id)) so AppTile doesn't need to know
  // about the type distinction. Favoriting stays instant regardless of
  // Customize/edit state - see useLinkViews.js's toggleFavorite docstring.
  const favoriteExternalIds = useMemo(() => layout.favorites.filter(f => f.item_type === 'external').map(f => f.item_id), [layout.favorites]);
  const favoritePersonalIds = useMemo(() => layout.favorites.filter(f => f.item_type === 'personal').map(f => f.item_id), [layout.favorites]);
  const toggleFavorite = useCallback((id) => toggleFavoriteRaw('external', id), [toggleFavoriteRaw]);
  const togglePersonalFavorite = useCallback((id) => toggleFavoriteRaw('personal', id), [toggleFavoriteRaw]);

  const [recents, setRecents] = useState(() => readIds(myEmail, 'recents'));
  useEffect(() => { setRecents(readIds(myEmail, 'recents')); }, [myEmail]);

  const pushRecent = useCallback((id) => {
    setRecents(prev => {
      const next = [id, ...prev.filter(x => x !== id)].slice(0, 8);
      writeIds(myEmail, 'recents', next);
      return next;
    });
  }, [myEmail]);

  const load = useCallback(() => {
    setError(false);
    Promise.all([api.getExternalLinks(), api.getExternalLinksMeta()])
      .then(([l, m]) => { setLinks(l || []); setMeta(m || { departments: [], categories: [] }); })
      .catch(() => { setError(true); });
    // Separate, independent load - a Personal Links hiccup shouldn't block
    // the shared directory from rendering (and vice versa).
    api.getPersonalLinks().then(p => setPersonalLinks(p || [])).catch(() => setPersonalLinks([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 3500);
    return () => clearTimeout(t);
  }, [banner]);

  const all = links || [];

  // Personal shortcuts - shown above the filtered grid regardless of the
  // current department/category filter (mirrors Okta's own "recent apps"
  // ribbon, which isn't scoped by the app-group filters either). A favorite
  // can be either a Company or a Personal Link, so resolve against whichever
  // list matches its item_type - `_uid` disambiguates the render key since
  // the two tables' autoincrement ids can collide.
  const favoriteLinks = useMemo(() => layout.favorites
    .map(f => {
      const link = (f.item_type === 'personal' ? (personalLinks || []) : all).find(l => l.id === f.item_id);
      return link ? { ...link, _uid: `${f.item_type}-${link.id}`, _favType: f.item_type } : null;
    })
    .filter(Boolean), [layout.favorites, all, personalLinks]);
  const recentLinks = useMemo(() => recents.map(id => all.find(l => l.id === id)).filter(Boolean), [recents, all]);

  // Department/Company filters: "All ..." shows everything, including
  // company-wide links (field === ''); picking a specific department scopes
  // strictly to that department - a company-wide link used to also show up
  // under every single department choice, which made picking one feel like
  // it barely narrowed anything (Neil/Pranshu, Aug 13 - "shows too many
  // links"). Company stays independent of department (AND'd).
  const deptFiltered = useMemo(() => all.filter(l => {
    const deptOk = !department || l.department === department;
    const coOk = !companyFilter || l.company === companyFilter || !l.company;
    return deptOk && coOk;
  }), [all, department, companyFilter]);

  // categoriesInUse drives the header stat ("N categories") - only what
  // actually has links. categoriesAvailable drives the filter chips, which
  // show the fixed CATEGORIES list up front (Neil, Aug 13) plus any
  // additional ones present in the data, so a category isn't hidden until
  // something's filed under it.
  const categoriesInUse = useMemo(
    () => [...new Set(deptFiltered.map(l => l.category).filter(Boolean))],
    [deptFiltered]
  );
  const categoriesAvailable = useMemo(() => {
    const extra = categoriesInUse.filter(c => !categoryNames.includes(c)).sort();
    return [...categoryNames, ...extra];
  }, [categoriesInUse, categoryNames]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return deptFiltered.filter(l => {
      if (category && l.category !== category) return false;
      if (!needle) return true;
      return [l.name, l.description, l.category, l.department].some(v => (v || '').toLowerCase().includes(needle));
    });
  }, [deptFiltered, category, q]);

  // Company My Layout and Personal Links each get their own itemsById with
  // the OTHER type left as an empty Map on purpose - even though both types
  // can now live in the same layout document (Aug 14, folders on Personal
  // Links too), resolveEntryLink returning undefined for the other type is
  // what makes it structurally impossible for a Company entry to render
  // inside Personal Links or vice versa, regardless of what's in the data.
  const unifiedItemsById = useMemo(() => ({
    external: new Map(filtered.map(l => [l.id, l])),
    personal: new Map(),
  }), [filtered]);
  // Personal Links' own filter bar (Aug 14) - mirrors the Company filter
  // logic above, minus the Company dropdown (Personal Links has no
  // company-portfolio concept). Only narrows what's resolvable via
  // personalItemsById (the same "quietly drops out of the grid/any folder"
  // behavior filtered has for Company) - never touches the underlying
  // personalLinks list or what seededPersonalMutate seeds from.
  const personalFiltered = useMemo(() => {
    const needle = pq.trim().toLowerCase();
    return (personalLinks || []).filter(l => {
      if (pDepartment && l.department !== pDepartment) return false;
      if (pCategory && l.category !== pCategory) return false;
      if (!needle) return true;
      return [l.name, l.description, l.category, l.department].some(v => (v || '').toLowerCase().includes(needle));
    });
  }, [personalLinks, pDepartment, pCategory, pq]);
  const personalCategoriesAvailable = useMemo(
    () => [...new Set([...categoryNames, ...(personalLinks || []).map(l => l.category).filter(Boolean)])].sort(),
    [categoryNames, personalLinks]
  );
  const personalDepartmentsAvailable = useMemo(
    () => [...new Set([...departmentNames, ...(personalLinks || []).map(l => l.department).filter(Boolean)])].sort(),
    [departmentNames, personalLinks]
  );
  const personalItemsById = useMemo(() => ({
    external: new Map(),
    personal: new Map(personalFiltered.map(l => [l.id, l])),
  }), [personalFiltered]);

  // A view (or Home) can easily have zero items for one of the two types -
  // e.g. every existing view was built before Personal folders existed, or
  // this is Home itself. LinksLayoutSection renders the synthesized default
  // order for display in that case, but an actual drag needs something real
  // in `items` to reorder - this wraps a mutator (the hook's dirty-tracked
  // `mutate`, or its always-live `mutateNow`) to seed that tab's default
  // order in first, on whichever mutator is passed.
  const seedFirst = (sourceType, sourceLinks, updater) => (prev) => {
    const seeded = hasCustomOrderFor(prev, sourceType)
      ? prev
      : { ...prev, items: [...prev.items, ...defaultOrderItems(sourceLinks, sourceType)] };
    return updater(seeded);
  };
  const makeSeededMutate = (sourceType, sourceLinks) => (updater) => mutate(seedFirst(sourceType, sourceLinks, updater));
  const seededMutate = makeSeededMutate('external', all);
  const seededPersonalMutate = makeSeededMutate('personal', personalLinks || []);
  // Always-live counterpart used only for organizing an already-open
  // folder's contents (Aug 14, "when we drag an application from folder it
  // is not responsive... we should have the option to drag the application
  // from folder also and move to any other folder or just keep it on main
  // screen") - saves immediately, same as favoriting, so this works without
  // first entering Customize mode. Rearranging the main screen itself still
  // requires Customize/Save/Done, unchanged.
  const makeSeededMutateNow = (sourceType, sourceLinks) => (updater) => mutateNow(seedFirst(sourceType, sourceLinks, updater));
  const seededMutateNow = makeSeededMutateNow('external', all);
  const seededPersonalMutateNow = makeSeededMutateNow('personal', personalLinks || []);

  // View switcher name-prompt modal state + the actions that open it -
  // mirrors CustomDashboard.jsx's NameModal/openName/wrap pattern one
  // screen over. `wrap` is what turns a silent NameModal-swallowed
  // rejection into a visible banner - without it, a failed save/rename/
  // create just left the modal re-clickable with no explanation.
  const [nameModal, setNameModal] = useState(null);
  const [viewMenu, setViewMenu] = useState(false);
  const openName = (opts) => { setViewMenu(false); setNameModal(opts); };
  const wrap = (fn, okMsg) => async (...a) => {
    try { await fn(...a); if (okMsg) setBanner({ kind: 'ok', text: okMsg }); }
    catch (e) { setBanner({ kind: 'err', text: e?.message || 'Something went wrong.' }); throw e; }
  };
  const confirmDiscard = () => !dirty || window.confirm('You have unsaved changes to your layout - discard them?');
  const guardedSwitch = (id) => { if (confirmDiscard()) switchView(id); };
  const isOwnView = !!activeView;
  const saveViewLayout = wrap(async () => {
    if (isOwnView) { await saveView(); return; }
    openName({
      title: 'Save your layout', initial: 'My view', cta: 'Save view',
      onSubmit: wrap(async (name) => { const v = await saveAsNew(name); await setDefaultView(v.id); }, 'Layout saved'),
    });
  }, isOwnView ? 'Layout saved' : null);
  const saveAsNewView = () => openName({
    title: 'Save as a new view', initial: '', cta: 'Create view',
    onSubmit: wrap(name => saveAsNew(name), 'View created'),
  });
  const renameCurrentView = () => openName({
    title: 'Rename view', initial: activeView?.name || '', cta: 'Rename',
    onSubmit: wrap(name => renameView(activeId, name), 'Renamed'),
  });
  const createNew = () => openName({
    title: 'Create a new view', label: 'Starts from the default layout - customize it after', initial: '', cta: 'Create view',
    onSubmit: wrap(name => createNewView(name), 'View created - customize away'),
  });
  const guardedNew = () => { if (confirmDiscard()) createNew(); };
  const guardedDone = () => { if (confirmDiscard()) { setEditing(false); reloadViews(); } };
  const makeDefault = wrap(async () => { setViewMenu(false); if (activeId) await setDefaultView(activeId); }, 'Set as your default');
  const deleteCurrentView = () => {
    setViewMenu(false);
    if (!activeId) return;
    if (window.confirm(`Delete "${activeView?.name}"?`)) removeView(activeId).catch(e => setBanner({ kind: 'err', text: e?.message }));
  };

  const openLink = (link) => {
    window.open(link.url, '_blank', 'noopener,noreferrer');
    pushRecent(link.id);
    api.clickExternalLink(link.id).then(updated => {
      setLinks(prev => (prev || []).map(l => (l.id === link.id ? updated : l)));
    }).catch(() => {});
  };

  // Drag-reorder (Manage > All Links) - optimistic update, one bulk PATCH per
  // drop rather than per-row, then resync from the server if it fails so a
  // rejected reorder doesn't leave the UI showing an order that didn't save.
  const reorderCategory = async (orderedIds) => {
    const rank = new Map(orderedIds.map((id, i) => [id, (i + 1) * 10]));
    setLinks(prev => (prev || []).map(l => (rank.has(l.id) ? { ...l, sort_order: rank.get(l.id) } : l)));
    try {
      await api.reorderExternalLinks(orderedIds.map(id => ({ id, sort_order: rank.get(id) })));
    } catch (e) {
      setBanner({ kind: 'err', text: e?.message || 'Could not save the new order.' });
      load();
    }
  };

  const onImported = (createdLinks) => {
    if (!createdLinks.length) return;
    setLinks(prev => [...(prev || []), ...createdLinks]);
    createdLinks.forEach(l => {
      if (!meta.categories.includes(l.category)) setMeta(m => ({ ...m, categories: [...new Set([...m.categories, l.category])].sort() }));
      if (l.department && !meta.departments.includes(l.department)) setMeta(m => ({ ...m, departments: [...new Set([...m.departments, l.department])].sort() }));
    });
  };

  // Shorten Descriptions (Aug 14) - the short-category autofill only ever
  // applied going forward to new Add Link submissions; a link added before
  // that shipped (or via CSV import, which never set a description at all)
  // keeps its old long description until someone explicitly refreshes it,
  // here or per-row.
  const refreshDescription = async (link) => {
    try {
      const updated = await api.refreshLinkDescription(link.id);
      setLinks(prev => (prev || []).map(l => (l.id === link.id ? updated : l)));
    } catch (e) {
      setBanner({ kind: 'err', text: e?.message || `Could not refresh "${link.name}"'s description.` });
    }
  };
  const refreshAllDescriptions = async () => {
    try {
      const res = await api.refreshAllLinkDescriptions();
      await load(); // one bulk call already wrote every row server-side - just resync the list
      setBanner({ kind: 'ok', text: `Updated ${res.updated} of ${res.total} link descriptions.` });
    } catch (e) {
      setBanner({ kind: 'err', text: e?.message || 'Could not refresh descriptions.' });
    }
  };

  const openAdd = () => setModal({ mode: 'add', id: null, form: { ...emptyForm, department, company: companyFilter, category: category || '' } });
  const openAddForDept = (dept) => setModal({ mode: 'add', id: null, form: { ...emptyForm, department: dept } });
  const openEdit = (link) => setModal({
    mode: 'edit', id: link.id,
    form: {
      name: link.name, url: link.url, category: link.category, description: link.description || '',
      department: link.department || '', company: link.company || '', icon: link.icon || 'Link2', is_pinned: !!link.is_pinned,
    },
  });

  const save = async () => {
    const f = modal.form;
    if (!f.name.trim() || !f.url.trim() || !f.category.trim()) {
      setBanner({ kind: 'err', text: 'Name, URL, and category are required.' });
      return;
    }
    const url = /^https?:\/\//i.test(f.url.trim()) ? f.url.trim() : `https://${f.url.trim()}`;
    const dupe = all.find(l => l.id !== modal.id && normalizeUrl(l.url) === normalizeUrl(url));
    if (dupe) {
      setBanner({ kind: 'err', text: `This link is already added as "${dupe.name}"${dupe.department ? ` (${dupe.department})` : ''}.` });
      return;
    }
    setSaving(true);
    try {
      if (modal.mode === 'add') {
        const created = await api.createExternalLink({ ...f, url });
        setLinks(prev => [...(prev || []), created]);
        setBanner({ kind: 'ok', text: `"${created.name}" added.` });
      } else {
        const updated = await api.updateExternalLink(modal.id, { ...f, url });
        setLinks(prev => (prev || []).map(l => (l.id === modal.id ? updated : l)));
        setBanner({ kind: 'ok', text: `"${updated.name}" updated.` });
      }
      if (!meta.categories.includes(f.category)) setMeta(m => ({ ...m, categories: [...m.categories, f.category].sort() }));
      if (f.department && !meta.departments.includes(f.department)) setMeta(m => ({ ...m, departments: [...m.departments, f.department].sort() }));
      setModal(null);
    } catch (e) {
      setBanner({ kind: 'err', text: e?.message || 'Could not save this link.' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (link) => {
    if (!window.confirm(`Remove "${link.name}" from External Links? This cannot be undone.`)) return;
    try {
      await api.deleteExternalLink(link.id);
      setLinks(prev => (prev || []).filter(l => l.id !== link.id));
      setBanner({ kind: 'ok', text: `"${link.name}" removed.` });
    } catch (e) {
      setBanner({ kind: 'err', text: e?.message || 'Could not remove this link.' });
    }
  };

  const bumpPersonalClick = (link) => {
    api.clickPersonalLink(link.id).then(updated => {
      setPersonalLinks(prev => (prev || []).map(l => (l.id === link.id ? updated : l)));
    }).catch(() => {});
  };

  // No vault credential attached - the plain open, unchanged from before.
  const openPersonalLink = (link) => {
    if (!link.vault_cred_id) {
      window.open(link.url, '_blank', 'noopener,noreferrer');
      bumpPersonalClick(link);
      return;
    }
    // A window opened synchronously in the click handler is never treated as
    // a popup; one opened after the `await` below (once reveal() returns)
    // usually would be, since the click's user-activation window has likely
    // expired by then - so open a blank tab now and point it at the real URL
    // once we know whether the copy succeeded. Deliberately no noopener/
    // noreferrer here: per spec, either one makes window.open() return null
    // instead of a handle, which would leave this tab permanently stuck on
    // about:blank since there'd be nothing left to navigate. Sever the
    // opener link manually right after navigating it instead, once it's
    // safe to do so.
    const win = window.open('', '_blank');
    revealAndOpen(link, win);
  };

  const gotoAndDetach = (win, url) => {
    if (!win) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
    win.location = url;
    try { win.opener = null; } catch { /* older browser - opener link stays, acceptable fallback */ }
  };

  const revealAndOpen = async (link, win) => {
    try {
      const res = await api.cvPersonalReveal(link.vault_cred_id);
      try { await navigator.clipboard?.writeText(res.secret); } catch { /* clipboard blocked - link still opens */ }
      setBanner({ kind: 'ok', text: `Password for "${link.name}" copied to your clipboard - paste it on the page that just opened.` });
      gotoAndDetach(win, link.url);
      bumpPersonalClick(link);
    } catch (e) {
      if (e?.status === 403 && e?.detail?.code === 'personal_vault_locked') {
        win?.close();
        setPendingVaultOpen(link);
        setShowVaultLockGate(true);
        return;
      }
      setBanner({ kind: 'err', text: e?.message || 'Could not copy the linked password - opening the link only.' });
      gotoAndDetach(win, link.url);
      bumpPersonalClick(link);
    }
  };

  const openAddPersonal = () => setPersonalModal({ mode: 'add', id: null, form: { name: '', url: '', description: '', icon: 'Link2', vault_cred_id: '', department: '', category: '' } });
  const openEditPersonal = (link) => setPersonalModal({
    mode: 'edit', id: link.id,
    form: {
      name: link.name, url: link.url, description: link.description || '', icon: link.icon || 'Link2', vault_cred_id: link.vault_cred_id || '',
      department: link.department || '', category: link.category || '',
    },
  });

  const savePersonal = async () => {
    const f = personalModal.form;
    if (!f.name.trim() || !f.url.trim()) {
      setBanner({ kind: 'err', text: 'Name and URL are required.' });
      return;
    }
    const url = /^https?:\/\//i.test(f.url.trim()) ? f.url.trim() : `https://${f.url.trim()}`;
    const dupe = (personalLinks || []).find(l => l.id !== personalModal.id && normalizeUrl(l.url) === normalizeUrl(url));
    if (dupe) {
      setBanner({ kind: 'err', text: `This is already in your Personal Links as "${dupe.name}".` });
      return;
    }
    setPersonalSaving(true);
    try {
      if (personalModal.mode === 'add') {
        const created = await api.createPersonalLink({ ...f, url });
        setPersonalLinks(prev => [...(prev || []), created]);
        setBanner({ kind: 'ok', text: `"${created.name}" added to Personal Links.` });
      } else {
        const updated = await api.updatePersonalLink(personalModal.id, { ...f, url });
        setPersonalLinks(prev => (prev || []).map(l => (l.id === personalModal.id ? updated : l)));
        setBanner({ kind: 'ok', text: `"${updated.name}" updated.` });
      }
      setPersonalModal(null);
    } catch (e) {
      setBanner({ kind: 'err', text: e?.message || 'Could not save this link.' });
    } finally {
      setPersonalSaving(false);
    }
  };

  const removePersonal = async (link) => {
    if (!window.confirm(`Remove "${link.name}" from your Personal Links?`)) return;
    try {
      await api.deletePersonalLink(link.id);
      setPersonalLinks(prev => (prev || []).filter(l => l.id !== link.id));
      setBanner({ kind: 'ok', text: `"${link.name}" removed.` });
    } catch (e) {
      setBanner({ kind: 'err', text: e?.message || 'Could not remove this link.' });
    }
  };

  // My Layout's per-entry action/permission set (see entryActions) - built
  // here, after every handler it references is defined, since this is a
  // plain object evaluated immediately (unlike the JSX below, which only
  // reads these closures once actually invoked on a later render pass).
  const actionCtx = {
    canManage, canDelete,
    favoriteExternalIds, toggleFavorite, favoritePersonalIds, togglePersonalFavorite,
    onOpenExternal: openLink, onEditExternal: openEdit, onDeleteExternal: remove,
    onOpenPersonal: openPersonalLink, onEditPersonal: openEditPersonal, onDeletePersonal: removePersonal,
  };

  // Gate on layoutLoading too, not just links - resolving personalization
  // after the grid has already painted the default category view would flash
  // straight into "My Layout" for anyone customized, which is exactly the
  // visible layout jump the personalization spec calls out to avoid.
  const isLoading = (links === null || layoutLoading) && !error;
  const isEmpty = !isLoading && !error && filtered.length === 0;

  const totalClicks = all.reduce((s, l) => s + (l.clicks || 0), 0);

  return (
    <div>
      <div className="view-header">
        <div className="view-title-group">
          <h2>External Links</h2>
          <p>
            Every tool the company runs on, one launchpad.
            {all.length > 0 && ` ${all.length} apps across ${categoriesInUse.length || meta.categories.length} categories, ${totalClicks.toLocaleString()} launches all-time.`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* View select + "..." menu trigger read as ONE joined control
              (Aug 14 - "i don't see the use of 3 dot button separately,
              incorporate them with... view selection") rather than two
              separate pill buttons sitting side by side. The dropdown menu
              lives on this OUTER wrapper (position: relative, no overflow
              clip), not inside the inner overflow:hidden pill below it -
              putting it inside the clipped pill was why the menu never
              actually appeared ("its just a placeholder", Aug 14): it was
              rendering, just clipped to invisible by the pill's own bounds. */}
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--wk-line2)', borderRadius: 10, overflow: 'hidden' }}>
              <select value={activeId || ''}
                onChange={e => { const val = e.target.value; if (val === '__new__') guardedNew(); else guardedSwitch(val || null); }}
                className="form-select" title="Switch layout view"
                style={{ fontSize: 12.5, fontWeight: 600, width: 150, padding: '7px 30px 7px 11px', lineHeight: 1.4, height: 'auto', border: 'none', borderRadius: 0, background: 'var(--card)' }}>
                <option value="">Home</option>
                {views.length > 0 && (
                  <optgroup label="My views">
                    {views.map(v => <option key={v.id} value={v.id}>{v.name}{v.isDefault ? ' ★' : ''}</option>)}
                  </optgroup>
                )}
                <option value="__new__">＋ New view…</option>
              </select>
              <button onClick={() => setViewMenu(m => !m)} title="View options"
                style={{ display: 'flex', alignItems: 'center', padding: '0 9px', border: 'none', borderLeft: '1px solid var(--wk-line2)', background: 'var(--card)', cursor: 'pointer', color: 'var(--muted)' }}>
                <MoreHorizontal size={15} />
              </button>
            </div>
            {viewMenu && (
              <div onMouseLeave={() => setViewMenu(false)} style={{ position: 'absolute', right: 0, top: 42, background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 12, boxShadow: '0 18px 50px rgba(17,24,39,0.18)', padding: 6, zIndex: 50, minWidth: 210 }}>
                <div style={{ padding: '6px 10px 9px', borderBottom: '1px solid var(--line)', marginBottom: 5 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', maxWidth: 210, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeView?.name || 'Home'}</div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>{activeView ? (activeView.isDefault ? 'Your default view' : 'Personal view') : 'Built-in layout'}</div>
                </div>
                {isOwnView && <ViewMenuItem icon={Pencil} label="Rename view" onClick={() => { setViewMenu(false); renameCurrentView(); }} />}
                {isOwnView && !activeView.isDefault && <ViewMenuItem icon={Star} label="Set as my default" onClick={makeDefault} />}
                {!isOwnView && views.some(v => v.isDefault) && (
                  <ViewMenuItem icon={LayoutGrid} label="Make Home my default"
                    onClick={() => { setViewMenu(false); clearDefaultView().catch(e => setBanner({ kind: 'err', text: e?.message })); }} />
                )}
                <div style={{ borderTop: '1px solid var(--line)', margin: '5px 0' }} />
                <ViewMenuItem icon={Copy} label="Save as new view" onClick={() => { setViewMenu(false); saveAsNewView(); }} />
                {isOwnView && <ViewMenuItem icon={Trash2} label="Delete view" danger onClick={deleteCurrentView} />}
              </div>
            )}
          </div>
          {editing ? (
            <>
              <button className="primary-btn" style={{ opacity: dirty ? 1 : 0.6 }} onClick={saveViewLayout} disabled={!dirty}>
                <Save size={14} /> {dirty ? 'Save' : 'Saved'}
              </button>
              <button className="secondary-btn" onClick={guardedDone}><X size={14} /> Done</button>
            </>
          ) : (
            <button className="secondary-btn" onClick={() => setEditing(true)}><SlidersHorizontal size={14} /> Customize</button>
          )}
          {section === 'company' && canManage && (
            <button className="primary-btn" onClick={() => setShowManage(true)}>
              <Settings2 size={14} /> Manage
            </button>
          )}
        </div>
      </div>

      {banner && (
        <div style={{
          marginBottom: 14, padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
          background: banner.kind === 'ok' ? 'hsla(var(--color-green),0.12)' : 'hsla(var(--color-red),0.12)',
          color: banner.kind === 'ok' ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))',
        }}>
          {banner.text}
        </div>
      )}

      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, borderRadius: 12, border: '1px solid var(--wk-line2)', background: 'var(--mist)', padding: 4, marginBottom: 20 }}>
        <button onClick={() => setSection('company')} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          border: 'none', cursor: 'pointer', fontFamily: 'inherit', transition: 'background .15s, color .15s',
          background: section === 'company' ? 'var(--card)' : 'transparent',
          color: section === 'company' ? 'var(--ink)' : 'var(--muted)',
          boxShadow: section === 'company' ? '0 1px 4px rgba(0,0,0,.12)' : 'none',
        }}>
          <Globe size={13} /> Company Links
        </button>
        <button onClick={() => setSection('personal')} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          border: 'none', cursor: 'pointer', fontFamily: 'inherit', transition: 'background .15s, color .15s',
          background: section === 'personal' ? PERSONAL_COLOR.fg : 'transparent',
          color: section === 'personal' ? '#fff' : 'var(--muted)',
          boxShadow: section === 'personal' ? '0 1px 4px rgba(0,0,0,.12)' : 'none',
        }}>
          <Lock size={13} /> Personal Links{personalLinks && personalLinks.length > 0 ? ` (${personalLinks.length})` : ''}
        </button>
      </div>

      {section === 'personal' && (<>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
            <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input
              className="form-input" placeholder="Search your links..."
              style={{ paddingLeft: 36 }} value={pq} onChange={e => setPq(e.target.value)}
            />
          </div>
          <select className="form-select" style={{ width: 'auto', minWidth: 170 }} value={pDepartment} onChange={e => setPDepartment(e.target.value)}>
            <option value="">All Departments</option>
            {personalDepartmentsAvailable.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className="form-select" style={{ width: 'auto', minWidth: 170 }} value={pCategory} onChange={e => setPCategory(e.target.value)}>
            <option value="">All Categories</option>
            {personalCategoriesAvailable.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <PersonalLinksSection
          layout={layout} itemsById={personalItemsById} actionCtx={actionCtx}
          mutate={seededPersonalMutate} immediateMutate={seededPersonalMutateNow} allLinks={personalLinks || []}
          onAdd={openAddPersonal} editable={editing}
        />
      </>)}

      {section === 'company' && (<>
        {/* Personal shortcuts - client-local, not scoped by the filters below */}
        {favoriteLinks.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
              <Bookmark size={14} style={{ color: 'hsl(var(--color-blue))' }} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)', flex: 1 }}>My Favorites</span>
              <ViewToggle view={favView} onChange={setFavView} />
            </div>
            {favView === 'tile' ? (
              <PersonalStrip links={favoriteLinks} onOpen={(l) => (l._favType === 'personal' ? openPersonalLink(l) : openLink(l))} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {favoriteLinks.map(l => {
                  const { fg, bg } = colorFor(l.category);
                  return (
                    <LinksListRow key={l._uid || l.id}
                      icon={<LinkIcon url={l.url} iconKey={l.icon} size={26} iconSize={13} radius={7} fg={fg} bg={bg} gradient={false} />}
                      name={l.name} sub={l.category}
                      onOpen={() => (l._favType === 'personal' ? openPersonalLink(l) : openLink(l))} />
                  );
                })}
              </div>
            )}
          </div>
        )}
        {recentLinks.length > 0 && (
          <PersonalStrip title="Recently Used" icon={History} iconColor="var(--muted)" links={recentLinks}
            onOpen={openLink} />
        )}

        {/* Filter bar - category chips sit inline beside the Companies
            dropdown (Aug 14), not stacked on their own row below, so the
            filter bar reads as one control group instead of two. The chip
            strip gets its own shrinkable/scrollable flex item (minWidth: 0)
            so a long category list scrolls horizontally in place rather
            than pushing the search box and dropdowns off narrower screens. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
            <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input
              className="form-input" placeholder="Search apps, tools, banks..."
              style={{ paddingLeft: 36 }} value={q} onChange={e => setQ(e.target.value)}
            />
          </div>
          <select className="form-select" style={{ width: 'auto', minWidth: 170 }} value={department}
            onChange={e => { setDepartment(e.target.value); setCategory(''); }}>
            <option value="">All Departments</option>
            {[...new Set([...departmentNames, ...meta.departments])].sort().map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          {companies.length > 0 && (
            <select className="form-select" style={{ width: 'auto', minWidth: 170 }} value={companyFilter}
              onChange={e => { setCompanyFilter(e.target.value); setCategory(''); }}>
              <option value="">All Companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {categoriesAvailable.length > 0 && (
            <select className="form-select" style={{ width: 'auto', minWidth: 170 }} value={category}
              onChange={e => setCategory(e.target.value)}>
              <option value="">All Categories</option>
              {categoriesAvailable.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {!editing && <ViewToggle view={gridView} onChange={setGridView} />}
        </div>

        <AsyncSection
          loading={isLoading}
          error={error}
          isEmpty={isEmpty}
          onRetry={load}
          skeleton={<SkeletonBlocks count={16} height={86} borderRadius={16} gridTemplateColumns="repeat(auto-fill, 86px)" />}
          emptyContent={
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)' }}>
              <LayoutGrid size={32} style={{ opacity: 0.4, marginBottom: 10 }} />
              <p style={{ fontSize: 14 }}>No links match these filters yet.</p>
              {canManage && <p style={{ fontSize: 13, marginTop: 4 }}>Use "Manage" to start building this department's directory.</p>}
            </div>
          }
        >
          <Section title="My Layout" icon={LayoutGrid}>
            <LinksLayoutSection
              sourceType="external" layout={layout} itemsById={unifiedItemsById} actionCtx={actionCtx}
              mutate={seededMutate} immediateMutate={seededMutateNow} allLinks={all} editable={editing}
              view={gridView}
            />
          </Section>
        </AsyncSection>
      </>)}

      {showManage && (
        <ManageModal
          links={all} onClose={() => setShowManage(false)}
          onAdd={openAdd} onAddForDept={openAddForDept} onEdit={openEdit} onDelete={remove}
          canDelete={canDelete} onReorder={reorderCategory} onImported={onImported}
          companyName={companyName}
          onRefreshDescription={refreshDescription} onRefreshAllDescriptions={refreshAllDescriptions}
          taxonomy={taxonomy} onAddTaxonomy={addTaxonomy} onRenameTaxonomy={renameTaxonomy} onDeleteTaxonomy={deleteTaxonomy}
          departmentNames={departmentNames}
        />
      )}

      {modal && (
        <LinkModal
          modal={modal} setModal={setModal} save={save} saving={saving}
          departments={[...new Set([...departmentNames, ...meta.departments])].sort()}
          categories={[...new Set([...categoryNames, ...meta.categories])].sort()} companies={companies}
          existingLinks={all}
        />
      )}

      {personalModal && (
        <PersonalLinkModal modal={personalModal} setModal={setPersonalModal} save={savePersonal} saving={personalSaving} existingLinks={personalLinks || []}
          departments={departmentNames} categories={categoryNames} />
      )}

      {showVaultLockGate && (
        <PersonalLockGate
          userEmail={myEmail}
          onClose={() => { setShowVaultLockGate(false); setPendingVaultOpen(null); }}
          onUnlocked={() => {
            setShowVaultLockGate(false);
            const link = pendingVaultOpen;
            setPendingVaultOpen(null);
            if (link) openPersonalLink(link);
          }}
        />
      )}

      {nameModal && <NameModal {...nameModal} onClose={() => setNameModal(null)} />}
    </div>
  );
}

function Section({ title, icon: Icon, color, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        {Icon && <Icon size={15} style={{ color: color?.fg || 'var(--muted)' }} />}
        <h3 style={{
          fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em',
          color: color?.fg || 'var(--muted)', margin: 0,
        }}>
          {title}
        </h3>
        <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
      </div>
      {children}
    </div>
  );
}

// Tile/List toggle (Aug 14) - two independent instances live in this view
// (the main grid, beside All Categories; My Favorites, beside its own
// header), each with its own state so picking one doesn't affect the other.
function ViewToggle({ view, onChange }) {
  return (
    <div style={{ display: 'inline-flex', background: 'var(--mist)', borderRadius: 8, padding: 2 }}>
      <button type="button" onClick={() => onChange('tile')} title="Tile view"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 26, border: 'none',
          borderRadius: 6, cursor: 'pointer', background: view === 'tile' ? 'var(--card)' : 'transparent',
          color: view === 'tile' ? 'var(--ink)' : 'var(--muted)', boxShadow: view === 'tile' ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
        }}>
        <LayoutGrid size={14} />
      </button>
      <button type="button" onClick={() => onChange('list')} title="List view"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 26, border: 'none',
          borderRadius: 6, cursor: 'pointer', background: view === 'list' ? 'var(--card)' : 'transparent',
          color: view === 'list' ? 'var(--ink)' : 'var(--muted)', boxShadow: view === 'list' ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
        }}>
        <List size={14} />
      </button>
    </div>
  );
}

// Compact list-view row - the read-only alternative to an icon AppTile/
// FolderTile, used only when a Tile/List toggle is set to List. Folders
// show a member count instead of a description; both open the same way
// tiles do (a link opens the URL, a folder opens FolderModal).
function LinksListRow({ icon, name, sub, onOpen, isFolder }) {
  return (
    <button onClick={onOpen} className="dash-link-row"
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', border: 'none', background: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', width: '100%', fontFamily: 'inherit' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
      {icon}
      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {sub && <span style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>{sub}</span>}
      {isFolder && <FolderOpen size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
    </button>
  );
}

// One flat accent (not category-hashed like colorFor, since personal links
// have no category) so every tile in this section reads as visually distinct
// from the shared directory below it at a glance.
const PERSONAL_COLOR = { fg: 'hsl(var(--color-purple))', bg: 'hsla(var(--color-purple),0.12)' };

// Full section, not a compact strip like Favorites/Recently Used - the user
// asked for these to be a first-class section they build up themselves, not
// just a shortcut ribbon. Private end to end: PersonalLink rows are scoped to
// owner_email server-side, so nothing here is visible to anyone else,
// regardless of role - not even in Manage or the command palette, which only
// ever touch the shared ExternalLink directory.
//
// Drag-to-reorder and folders (Aug 14, "add folders to personal links too")
// reuse the exact same LinksLayoutSection Company Links already uses, just
// pointed at item_type: "personal" - see that component's own docstring for
// how one layout document stays split cleanly between the two tabs.
function PersonalLinksSection({ layout, itemsById, actionCtx, mutate, immediateMutate, allLinks, onAdd, editable }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Lock size={14} style={{ color: PERSONAL_COLOR.fg }} />
        <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: PERSONAL_COLOR.fg, margin: 0 }}>
          Personal Links
        </h3>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Only visible to you</span>
        <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
      </div>
      <LinksLayoutSection
        sourceType="personal" layout={layout} itemsById={itemsById} actionCtx={actionCtx}
        mutate={mutate} immediateMutate={immediateMutate} allLinks={allLinks} editable={editable}
        extraAddTile={{ label: 'Add Link', onClick: onAdd }}
      />
    </div>
  );
}

function PersonalLinkModal({ modal, setModal, save, saving, existingLinks, departments, categories }) {
  const { mode, form } = modal;
  const setForm = (patch) => setModal(m => ({ ...m, form: { ...m.form, ...patch } }));
  const duplicate = useMemo(() => {
    if (!form.url.trim()) return null;
    return existingLinks.find(l => l.id !== modal.id && normalizeUrl(l.url) === normalizeUrl(form.url)) || null;
  }, [form.url, existingLinks, modal.id]);

  // Same auto-fill as the Company Links Add Link modal (see LinkModal) -
  // fetch the site's own meta description once the URL field is blurred,
  // fill it in only if the description is still empty or was itself the
  // last auto-fill (never overwrite something the user actually typed).
  const [fetchingPreview, setFetchingPreview] = useState(false);
  const autoFilledDescRef = useRef('');
  const fetchPreview = async () => {
    const raw = form.url.trim();
    if (!raw || (form.description && form.description !== autoFilledDescRef.current)) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    setFetchingPreview(true);
    try {
      const preview = await api.previewExternalLink(url);
      if (preview?.description) {
        autoFilledDescRef.current = preview.description;
        setForm({ description: preview.description });
      }
    } catch {
      /* best-effort prefill - the field just stays as it was */
    } finally {
      setFetchingPreview(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !saving && setModal(null)}>
      <div className="modal-content" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{mode === 'add' ? 'Add Personal Link' : 'Edit Personal Link'}</h3>
          <button className="close-btn" onClick={() => setModal(null)}><X size={16} /></button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
            <Lock size={12} /> Only visible to you - no one else, including managers, can see this.
          </p>
          <div className="form-group">
            <label>Name</label>
            <input className="form-input" value={form.name} onChange={e => setForm({ name: e.target.value })} placeholder="e.g. My Timesheet" autoFocus />
          </div>
          <div className="form-group">
            <label>URL</label>
            <input className="form-input" value={form.url} onChange={e => setForm({ url: e.target.value })} onBlur={fetchPreview} placeholder="https://..." />
            {duplicate && (
              <p style={{ fontSize: 11.5, color: 'hsl(var(--color-red))', margin: '5px 0 0', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                Already in your Personal Links as "{duplicate.name}" - pick a different link, or edit that one instead.
              </p>
            )}
          </div>
          <div className="form-group">
            <label>
              Description
              {fetchingPreview && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginLeft: 8 }}>Fetching from site...</span>}
            </label>
            <textarea className="form-input" rows={2} value={form.description}
              onChange={e => setForm({ description: e.target.value })} placeholder="Optional note to yourself - or leave blank, we'll try to pull it from the site" />
          </div>
          <div className="form-grid" style={{ padding: 0 }}>
            <div className="form-group">
              <label>Category</label>
              <input className="form-input" list="personal-link-categories" value={form.category}
                onChange={e => setForm({ category: e.target.value })} placeholder="e.g. Productivity" />
              <datalist id="personal-link-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            <div className="form-group">
              <label>Department</label>
              <select className="form-select" value={form.department} onChange={e => setForm({ department: e.target.value })}>
                <option value="">None</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Icon</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6 }}>
              {ICON_OPTIONS.map(key => {
                const Ico = ICON_MAP[key];
                const active = form.icon === key;
                return (
                  <button key={key} type="button" onClick={() => setForm({ icon: key })} title={key}
                    style={{
                      height: 32, borderRadius: 8, border: active ? '2px solid var(--wk-brand)' : '1px solid var(--wk-line2)',
                      background: active ? 'var(--wk-brand-tint)' : 'var(--card)', color: active ? 'var(--wk-brand)' : 'var(--muted)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    }}>
                    <Ico size={15} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="secondary-btn" onClick={() => setModal(null)} disabled={saving}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={saving || !!duplicate}>{saving ? 'Saving...' : mode === 'add' ? 'Add Link' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  );
}

// Horizontal shortcut row (Favorites / Recently Used) - compact pill-tiles,
// distinct from the full card grid below so personal shortcuts read as a
// quick-launch strip rather than another section to scan top to bottom.
function PersonalStrip({ title, icon: Icon, iconColor, links, onOpen }) {
  return (
    <div style={title ? { marginBottom: 18 } : undefined}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
          <Icon size={14} style={{ color: iconColor }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{title}</span>
        </div>
      )}
      <div className="scroll-tabs" style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
        {links.map(l => {
          const { fg, bg } = colorFor(l.category);
          return (
            <button
              key={l._uid || l.id} onClick={() => onOpen(l)} title={l.description || l.name}
              style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 8px 8px',
                borderRadius: 30, border: '1px solid var(--wk-line2)', background: 'var(--card)', cursor: 'pointer',
                transition: 'border-color .12s, transform .12s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = fg; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--wk-line2)'; }}
            >
              <LinkIcon url={l.url} iconKey={l.icon} size={26} iconSize={13} radius="50%" fg={fg} bg={bg} gradient={false} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{l.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── App Launcher tiles (Aug 2026 redesign) ──────────────────────────────────
// Replaces the old description-cards with compact iPhone/Android-style app
// icons: icon + name only. Description/category/admin actions surface on
// hover (or an explicit tap on touch devices, since CSS :hover doesn't fire
// reliably there) instead of sitting on the tile permanently - see the
// .app-tile rules in style.css for the hover/tooltip mechanics themselves.
// One shared tile for Company Links, Personal Links, and any future
// dashboard/folder surface - `data-link-id` is there so a future
// drag-and-drop library or folder feature can hook in without a rewrite;
// .app-grid is a plain flex-wrap for the same reason (easy to wrap in a DnD
// context or split into folder sub-grids later, unlike a CSS Grid with fixed
// track counts).
function AppGrid({ children }) {
  return <div className="app-grid">{children}</div>;
}

function AppTile({
  link, color, canManage, canDelete, isFavorite, onToggleFavorite, onOpen, onEdit, onDelete,
  iconSize = 60, iconGradient = true, vaultLinked = false, sourceType,
  dragHandleProps, dropProps, moveControls,
}) {
  const [showTip, setShowTip] = useState(false);
  const tipTimer = useRef(null);
  useEffect(() => () => clearTimeout(tipTimer.current), []);
  const toggleTip = (e) => {
    e.stopPropagation();
    setShowTip(s => {
      const next = !s;
      clearTimeout(tipTimer.current);
      if (next) tipTimer.current = setTimeout(() => setShowTip(false), 2500);
      return next;
    });
  };

  const description = link.description || '';
  const hasActions = !!(onToggleFavorite || (canManage && (onEdit || onDelete)) || moveControls || dragHandleProps);
  // Stable per-link id (not React's own, which isn't guaranteed unique
  // across a whole page) so aria-describedby can point at this tile's own
  // tooltip specifically - undefined (no attribute at all) when there's
  // nothing to describe, rather than pointing at an element that doesn't
  // exist.
  const tooltipId = description ? `app-tile-tip-${link.id}` : undefined;
  // Subtle source indicator (Aug 13) - Company and Personal Links now share
  // one launcher/folders, so at-a-glance it must still be obvious which is
  // which. Company Links get no badge (the implicit default, keeps the
  // common case visually quiet); Personal gets a small lock in the corner
  // ExternalLink's is_pinned always leaves empty (PersonalLink has no pin
  // concept, so the two badges never collide) plus a tooltip/title suffix -
  // "small badge" + "tooltip information" from the two suggested approaches,
  // deliberately not a third visual element that would bulk up the tile.
  const isPersonal = sourceType === 'personal';
  const tooltipText = description ? (isPersonal ? `${description} · Personal` : description) : undefined;
  const plainTitle = !description ? (isPersonal ? `${link.name} (Personal)` : link.name) : undefined;

  return (
    <div
      className="app-tile" onClick={onOpen} data-link-id={link.id} data-item-type={sourceType || 'external'}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title={plainTitle}
      aria-describedby={tooltipId}
      // Press-and-hold anywhere on the tile to drag it, not just the tiny
      // grip icon - matches the phone-launcher gesture this is modeled on.
      // HTML5 drag-and-drop already disambiguates this from a plain click on
      // its own: dragstart only fires once the browser sees real pointer
      // movement while the button is held, so a quick tap still opens the
      // link as normal. The grip icon stays as a visual "this is
      // draggable" hint, it's no longer the only place that works.
      draggable={!!dragHandleProps} {...(dragHandleProps || {})}
      {...dropProps}
    >
      <div className="app-tile-icon-wrap">
        <LinkIcon url={link.url} iconKey={link.icon} size={iconSize} radius={Math.round(iconSize * 0.28)} fg={color.fg} bg={color.bg} gradient={iconGradient} />
        {link.is_pinned && <span className="app-tile-pin" title="Pinned"><Star size={9} fill="currentColor" /></span>}
        {!link.is_pinned && isPersonal && <span className="app-tile-pin app-tile-personal-badge" title="Personal Link - only visible to you"><Lock size={8} /></span>}
        {isFavorite && <span className="app-tile-fav-badge"><Bookmark size={9} fill="currentColor" /></span>}
        {vaultLinked && <span className="app-tile-key-badge" title="Copies its saved password when opened"><KeyRound size={9} /></span>}
        {hasActions && (
          <div className="app-tile-actions" draggable={false} onClick={e => e.stopPropagation()} onDragStart={e => e.stopPropagation()}>
            {dragHandleProps && (
              <span className="app-tile-grip" title="Drag to reorder">
                <GripVertical size={11} />
              </span>
            )}
            {onToggleFavorite && (
              <IconBtn onClick={onToggleFavorite} title={isFavorite ? 'Remove from My Favorites' : 'Add to My Favorites'}>
                <Bookmark size={11} fill={isFavorite ? 'hsl(var(--color-blue))' : 'none'} style={{ color: isFavorite ? 'hsl(var(--color-blue))' : 'var(--muted)' }} />
              </IconBtn>
            )}
            {canManage && onEdit && <IconBtn onClick={onEdit} title="Edit link"><Pencil size={11} /></IconBtn>}
            {canManage && canDelete && onDelete && <IconBtn onClick={onDelete} title="Delete link" danger><Trash2 size={11} /></IconBtn>}
            {moveControls?.extra}
          </div>
        )}
        {description && (
          <>
            <div id={tooltipId} role="tooltip" className={`app-tile-tooltip${showTip ? ' show' : ''}`}>{tooltipText}</div>
            <button
              type="button" className="app-tile-info-btn" onClick={toggleTip}
              title="Show description" aria-label={showTip ? 'Hide description' : 'Show description'}
              aria-expanded={showTip} aria-controls={tooltipId}
            >
              <Info size={10} />
            </button>
          </>
        )}
      </div>
      <span className="app-tile-name">{link.name}</span>
    </div>
  );
}

function AddAppTile({ label, onClick }) {
  return (
    <button type="button" className="app-tile app-tile-add" onClick={onClick}>
      <div className="app-tile-add-icon"><Plus size={22} /></div>
      <span className="app-tile-name">{label}</span>
    </button>
  );
}

// ── Personalization: My Layout (Aug 13) ─────────────────────────────────────
// Once a user customizes (reorders, favorites into a folder, etc.), Company
// Links switches from the admin category-grouped view to this - the user's
// own arrangement, backend-persisted (see useLinkLayout.js). Small, focused
// components rather than one giant one so drag-and-drop/folders stay
// separable pieces, per the "prepare for future enhancements" precedent this
// module has followed all session (data-link-id on tiles, plain flex grid).

// Click-outside-closing folder picker for "move this item to a folder" -
// self-contained rather than pulled in from credvault's Dropdown, which is
// scoped to that module's own stylesheet.
function FolderPicker({ folders, currentFolderId, onMove, onCreateNew }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <IconBtn onClick={() => setOpen(o => !o)} title="Move to folder...">
        <FolderOpen size={11} />
      </IconBtn>
      {open && (
        <div className="folder-picker">
          {currentFolderId && (
            <button type="button" className="folder-picker-item" onClick={() => { onMove(null); setOpen(false); }}>
              Remove from folder
            </button>
          )}
          {folders.filter(f => f.id !== currentFolderId).map(f => (
            <button key={f.id} type="button" className="folder-picker-item" onClick={() => { onMove(f.id); setOpen(false); }}>
              {f.name}
            </button>
          ))}
          <button type="button" className="folder-picker-item folder-picker-new" onClick={() => { onCreateNew(); setOpen(false); }}>
            <FolderPlus size={12} /> New Folder...
          </button>
        </div>
      )}
    </div>
  );
}

function FolderTile({ folder, memberLinks, onOpen, dragHandleProps, dropProps, isDropTarget }) {
  const preview = memberLinks.slice(0, 4);
  return (
    <div
      className={`app-tile app-tile-folder${isDropTarget ? ' app-tile-drop-target' : ''}`} onClick={onOpen} data-folder-id={folder.id}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title={folder.name}
      draggable={!!dragHandleProps} {...(dragHandleProps || {})}
      {...dropProps}
    >
      <div className="app-tile-icon-wrap">
        <div className="app-folder-preview">
          {preview.length === 0
            ? <FolderOpen size={22} style={{ color: 'var(--muted)' }} />
            : preview.map(l => (
              <div key={l.id} className="app-folder-preview-cell">
                <LinkIcon url={l.url} iconKey={l.icon} size={24} radius={6} fg="var(--muted)" bg="var(--mist)" gradient={false} />
              </div>
            ))}
        </div>
        {dragHandleProps && (
          <div className="app-tile-actions" draggable={false} onClick={e => e.stopPropagation()} onDragStart={e => e.stopPropagation()}>
            <span className="app-tile-grip" title="Drag to reorder">
              <GripVertical size={11} />
            </span>
          </div>
        )}
      </div>
      <span className="app-tile-name">{folder.name}</span>
    </div>
  );
}

// Opens a folder's contents - inline-renamable title, delete (unfolds
// members back to top-level, never deletes the underlying links), and each
// member gets the same reorder/move-out controls as the top-level grid.
function FolderModal({
  folder, memberEntries, itemsById, actionCtx, editable,
  onClose, onRename, onDeleteFolder, onReorderWithin, onMoveOut,
  allFolders, onCreateFolder,
}) {
  const [nameDraft, setNameDraft] = useState(folder.name);
  const [renaming, setRenaming] = useState(false);
  // Own small drag state for reordering within this folder - separate DnD
  // context from the background grid (this is a modal on top of it), so it
  // doesn't share LinksLayoutSection's dragKind/dragId. Composite key
  // (item_type:item_id) since Company and Personal Links share the same
  // autoincrement id space (separate tables).
  const [dragKey, setDragKey] = useState(null);
  const entryKey = (entry) => `${entry.item_type}:${entry.item_id}`;
  const commitRename = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== folder.name) onRename(trimmed);
    setRenaming(false);
  };
  // Drag a member out onto the dimmed backdrop (outside the folder's own
  // content box) to pull it back to the main grid - the drag-and-drop
  // equivalent of the "Remove from folder" option already in the picker,
  // for the "grab it and pull it out" gesture users expect from a phone
  // folder. onDrop/onDragOver on modal-content stop propagation so a drop
  // that lands ON another tile (within-folder reorder) never also bubbles
  // up and gets misread as a drag-to-backdrop.
  const onBackdropDragOver = (e) => { if (dragKey != null) e.preventDefault(); };
  const onBackdropDrop = (e) => {
    e.preventDefault();
    if (dragKey == null) return;
    const entry = memberEntries.find(x => entryKey(x) === dragKey);
    setDragKey(null);
    if (entry) onMoveOut(entry, null);
  };

  return (
    // Same centered popup every other modal in this file uses, just wider -
    // 60% of the screen width (Aug 14), not the usual ~480-520px cap. Kept
    // as an inline override rather than touching the shared .modal-content
    // class every other modal still relies on for its normal size.
    <div className="modal-overlay" onClick={onClose} onDragOver={onBackdropDragOver} onDrop={onBackdropDrop}>
      <div
        className="modal-content" style={{ width: '60vw', maxWidth: '60vw' }}
        onClick={e => e.stopPropagation()} onDragOver={e => e.stopPropagation()} onDrop={e => e.stopPropagation()}
      >
        <div className="modal-header">
          {renaming ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
              <input
                className="form-input" value={nameDraft} onChange={e => setNameDraft(e.target.value)} autoFocus
                maxLength={60}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
              />
              <button className="secondary-btn" onClick={commitRename}><Check size={14} /></button>
            </div>
          ) : editable ? (
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setRenaming(true)} title="Click to rename">
              {folder.name} <Pencil size={13} style={{ color: 'var(--muted)' }} />
            </h3>
          ) : (
            <h3>{folder.name}</h3>
          )}
          <button className="close-btn" onClick={onClose}><X size={16} /></button>
        </div>
        {dragKey && (
          <p style={{ margin: '10px 24px 0', fontSize: 11.5, color: 'var(--wk-brand)', fontWeight: 600, textAlign: 'center' }}>
            Drop outside this box to take it out of the folder
          </p>
        )}
        <div style={{ padding: '20px 24px' }}>
          {memberEntries.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>
              Empty - use "Move to folder" on any app to add it here.
            </p>
          ) : (
            <AppGrid>
              {memberEntries.map((entry) => {
                const a = entryActions(entry, itemsById, actionCtx);
                if (!a) return null;
                return (
                  <AppTile
                    key={entryKey(entry)} link={a.link} color={a.color} sourceType={a.sourceType} vaultLinked={a.vaultLinked}
                    canManage={a.canManage} canDelete={a.canDelete}
                    isFavorite={a.isFavorite} onToggleFavorite={a.onToggleFavorite}
                    onOpen={a.onOpen} onEdit={a.onEdit} onDelete={a.onDelete}
                    dragHandleProps={editable ? {
                      onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; setDragKey(entryKey(entry)); },
                      onDragEnd: () => setDragKey(null),
                    } : undefined}
                    dropProps={editable ? {
                      onDragOver: (e) => { if (dragKey != null) e.preventDefault(); },
                      // Same DOM-ground-truth read as the background grid's
                      // topItemDropProps - the actual element the drop
                      // landed on, not a closure captured when this tile's
                      // dropProps were built.
                      onDrop: (e) => {
                        e.preventDefault();
                        if (dragKey == null) return;
                        const targetKey = `${e.currentTarget.dataset.itemType}:${e.currentTarget.dataset.linkId}`;
                        if (dragKey === targetKey) return;
                        const dragged = memberEntries.find(x => entryKey(x) === dragKey);
                        const entries = memberEntries.filter(x => entryKey(x) !== dragKey);
                        const idx = entries.findIndex(x => entryKey(x) === targetKey);
                        if (!dragged || idx === -1) return;
                        entries.splice(idx, 0, dragged);
                        onReorderWithin(entries);
                        setDragKey(null);
                      },
                    } : undefined}
                    // No "move to folder" picker icon on Personal Links (Aug
                    // 14) - matches the background grid's own gate above.
                    moveControls={(editable && folder.item_type !== 'personal') ? {
                      extra: (
                        <FolderPicker
                          folders={allFolders} currentFolderId={folder.id}
                          onMove={(destId) => onMoveOut(entry, destId)}
                          onCreateNew={() => onCreateFolder(entry)}
                        />
                      ),
                    } : undefined}
                  />
                );
              })}
            </AppGrid>
          )}
        </div>
        <div className="modal-footer">
          {editable && (
            <button className="secondary-btn" style={{ color: 'hsl(var(--color-red))' }} onClick={onDeleteFolder}>
              <Trash2 size={14} /> Delete Folder
            </button>
          )}
          <button className="primary-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// Orchestrates the customized Company Links grid once hasCustomOrder is
// true: folders first (their own position space), then loose top-level apps
// (their own position space) - both in one AppGrid so grid flow stays
// uniform. All mutations funnel through the parent's `mutate` (from
// useLinkLayout), which optimistically applies + auto-saves + rolls back on
// failure - this component never calls the API directly.
// itemsById: {external: Map<id,link>, personal: Map<id,link>} - pre-filtered
// by the parent (department/category/search/type-filter all collapse down
// to "is this id present in these maps or not"), so a Company or Personal
// Link that's currently filtered out simply can't be found here and quietly
// drops out of both the top-level grid and any folder it's placed in -
// no separate filtering logic needed inside this component. actionCtx
// carries the two link types' very different permission/handler sets (see
// entryActions) - a Company Link is admin-gated, a Personal Link is always
// fully owner-editable, and personalization (position/folder/favorite)
// never blurs that line.
// sourceType ('external' | 'personal') scopes every read/write in this
// component to just that tab's slice of the one shared layout document -
// Company Links and Personal Links each get their own instance (Aug 14,
// "add folders to personal links too"). extraAddTile is an optional extra
// tile rendered before "New Folder" (Personal Links' "Add Link", which
// creates a brand-new PersonalLink row rather than organizing existing
// ones - Company Links has no equivalent since new Company Links are only
// ever added from Manage).
function LinksLayoutSection({ sourceType, layout, itemsById, actionCtx, mutate, immediateMutate, allLinks, extraAddTile, editable = false, view = 'tile' }) {
  const [openFolderId, setOpenFolderId] = useState(null);
  // Desktop drag-and-drop state - HTML5 native, mirrors ManageModal's
  // draggable/onDragStart/onDragOver/onDrop/onDragEnd pattern elsewhere in
  // this file (its own "All Links" category reorder). Touch has no
  // equivalent gesture (poor/no support for native HTML5 DnD), so every tile
  // also gets Move Up/Down + a folder picker as the touch-inclusive path -
  // see AppTile's moveControls. dragEntry carries {item_type, item_id} (not
  // just an id) now that a mix of both types can share one grid/folder and
  // their autoincrement ids can collide.
  const [dragKind, setDragKind] = useState(null); // 'item' | 'folder' | null
  const [dragEntry, setDragEntry] = useState(null);
  // dragOverFolderId only drives a CSS highlight (which folder an item would
  // drop into) - safe to update on every dragover since it never touches
  // the DOM order. Reordering itself is computed and applied on DROP ONLY
  // (not live during dragover) - an earlier attempt at a live "iPhone-style"
  // shift preview reordered the actual rendered list on every dragover,
  // which reorders/reinserts the dragged element's own DOM node mid-drag -
  // a well-known way to break a native HTML5 drag session (the browser can
  // lose track of the drag once the element under the cursor moves out from
  // under it), and it did: reordering stopped working entirely. Reverted -
  // the order only changes once, at drop, which is what actually worked.
  const [dragOverFolderId, setDragOverFolderId] = useState(null); // highlights the folder an item would drop into
  const sameEntry = (a, b) => a && b && a.item_type === b.item_type && a.item_id === b.item_id;

  const entryExists = useCallback((entry) => !!resolveEntryLink(itemsById, entry), [itemsById]);
  // Nothing saved yet for THIS tab (brand-new user, or one who's customized
  // the other tab but never touched this one) - render the same default
  // order makeSeededMutate would write on the first real mutation, so drag/
  // folder-drop targets exist to grab from the very first paint, not only
  // after some other action has already triggered a save. Once this tab has
  // any real data, its own items are used even if empty (e.g. every item
  // moved into folders leaves an empty top-level list on purpose).
  const displayItems = hasCustomOrderFor(layout, sourceType)
    ? layout.items : defaultOrderItems(allLinks, sourceType);
  const topItems = useMemo(
    () => displayItems.filter(i => i.item_type === sourceType && i.folder_id === null && entryExists(i)).sort((a, b) => a.position - b.position),
    [displayItems, sourceType, entryExists]
  );
  const folders = useMemo(
    () => layout.folders.filter(f => (f.item_type || 'external') === sourceType).sort((a, b) => a.position - b.position),
    [layout.folders, sourceType]
  );
  const folderMembers = useCallback(
    (folderId) => layout.items.filter(i => i.item_type === sourceType && i.folder_id === folderId && entryExists(i)).sort((a, b) => a.position - b.position),
    [layout.items, sourceType, entryExists]
  );

  const reorderTopLevel = (orderedEntries) => mutate(prev => {
    const rank = new Map(orderedEntries.map((e, i) => [`${e.item_type}:${e.item_id}`, i]));
    return {
      ...prev,
      items: prev.items.map(i => {
        const key = `${i.item_type}:${i.item_id}`;
        return (i.folder_id === null && rank.has(key)) ? { ...i, position: rank.get(key) } : i;
      }),
    };
  });
  const reorderFolders = (orderedIds) => mutate(prev => {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    return { ...prev, folders: prev.folders.map(f => rank.has(f.id) ? { ...f, position: rank.get(f.id) } : f) };
  });
  // Folder-membership mutators all take an explicit mutateFn (defaulting to
  // the dirty-tracked `mutate`) rather than closing over it directly, so
  // the SAME logic can drive both the main-grid drag (gated behind
  // Customize, via `mutate`) and FolderModal's always-live internal
  // organizing (via `immediateMutate`, see the *Now wrappers below and
  // FolderModal's own docstring).
  const reorderWithinFolder = (folderId, orderedEntries, mutateFn = mutate) => mutateFn(prev => {
    const rank = new Map(orderedEntries.map((e, i) => [`${e.item_type}:${e.item_id}`, i]));
    return {
      ...prev,
      items: prev.items.map(i => {
        const key = `${i.item_type}:${i.item_id}`;
        return (i.folder_id === folderId && rank.has(key)) ? { ...i, position: rank.get(key) } : i;
      }),
    };
  });
  const moveToFolder = (entry, folderId, mutateFn = mutate) => mutateFn(prev => {
    const dest = prev.items.filter(i => i.folder_id === folderId && !sameEntry(i, entry));
    const nextPos = dest.length ? Math.max(...dest.map(i => i.position)) + 1 : 0;
    return { ...prev, items: prev.items.map(i => sameEntry(i, entry) ? { ...i, folder_id: folderId, position: nextPos } : i) };
  });
  const foldersOfType = (allFolders) => allFolders.filter(f => (f.item_type || 'external') === sourceType);
  const createFolderWithItem = (entry, mutateFn = mutate) => {
    const id = `f_${Math.random().toString(36).slice(2, 8)}`;
    mutateFn(prev => {
      const own = foldersOfType(prev.folders);
      const position = own.length ? Math.max(...own.map(f => f.position)) + 1 : 0;
      return {
        ...prev,
        folders: [...prev.folders, { id, name: 'New Folder', position, item_type: sourceType }],
        items: prev.items.map(i => sameEntry(i, entry) ? { ...i, folder_id: id, position: 0 } : i),
      };
    });
    setOpenFolderId(id); // straight into the modal so the user can rename it right away
  };
  const createEmptyFolder = () => {
    const id = `f_${Math.random().toString(36).slice(2, 8)}`;
    mutate(prev => {
      const own = foldersOfType(prev.folders);
      const position = own.length ? Math.max(...own.map(f => f.position)) + 1 : 0;
      return { ...prev, folders: [...prev.folders, { id, name: 'New Folder', position, item_type: sourceType }] };
    });
    setOpenFolderId(id);
  };
  const renameFolder = (folderId, name, mutateFn = mutate) => mutateFn(prev => ({ ...prev, folders: prev.folders.map(f => f.id === folderId ? { ...f, name } : f) }));
  const deleteFolder = (folderId, mutateFn = mutate) => mutateFn(prev => {
    const topPositions = prev.items.filter(i => i.folder_id === null).map(i => i.position);
    let nextPos = topPositions.length ? Math.max(...topPositions) + 1 : 0;
    return {
      ...prev,
      folders: prev.folders.filter(f => f.id !== folderId),
      items: prev.items.map(i => i.folder_id === folderId ? { ...i, folder_id: null, position: nextPos++ } : i),
    };
  });
  const itemDragProps = (entry) => ({
    onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; setDragKind('item'); setDragEntry(entry); },
    onDragEnd: () => { setDragKind(null); setDragEntry(null); setDragOverFolderId(null); },
  });
  const folderDragProps = (folderId) => ({
    onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; setDragKind('folder'); setDragEntry(folderId); },
    onDragEnd: () => { setDragKind(null); setDragEntry(null); },
  });
  const topItemDropProps = () => ({
    onDragOver: (e) => {
      if (dragKind !== 'item') return;
      e.preventDefault();
      setDragOverFolderId(null);
    },
    // Reads the actual drop target straight off the DOM node the drop event
    // landed on (e.currentTarget, guaranteed to be exactly the element the
    // browser fired this handler for) instead of trusting a JS closure
    // captured back when this tile's dropProps were built - eliminates any
    // possibility of the target being stale/wrong regardless of cause, which
    // is what "always moves one slot, ignoring where I actually drop it"
    // pointed at. data-item-type/data-link-id are always in sync with what's
    // rendered since they come straight from the same props on every render.
    onDrop: (e) => {
      e.preventDefault();
      if (dragKind !== 'item') return;
      const targetType = e.currentTarget.dataset.itemType;
      const targetId = Number(e.currentTarget.dataset.linkId);
      const targetEntry = topItems.find(i => i.item_type === targetType && i.item_id === targetId);
      if (!targetEntry || sameEntry(dragEntry, targetEntry)) return;
      const entries = topItems.filter(i => !sameEntry(i, dragEntry));
      const idx = entries.findIndex(i => sameEntry(i, targetEntry));
      entries.splice(idx, 0, dragEntry);
      reorderTopLevel(entries);
    },
  });
  const folderDropProps = (targetFolderId) => ({
    onDragOver: (e) => {
      if (!dragKind) return;
      e.preventDefault();
      if (dragKind === 'item') setDragOverFolderId(targetFolderId); // highlight - dropping here adds it to the folder
    },
    onDragLeave: () => { if (dragOverFolderId === targetFolderId) setDragOverFolderId(null); },
    // Ground-truth target read off the DOM node the drop actually landed on
    // (e.currentTarget), same reasoning as topItemDropProps above.
    onDrop: (e) => {
      e.preventDefault();
      setDragOverFolderId(null);
      const actualTargetFolderId = e.currentTarget.dataset.folderId;
      if (dragKind === 'item') { moveToFolder(dragEntry, actualTargetFolderId); return; }
      if (dragKind === 'folder' && dragEntry !== actualTargetFolderId) {
        const ids = folders.map(f => f.id).filter(id => id !== dragEntry);
        const idx = ids.indexOf(actualTargetFolderId);
        if (idx === -1) return;
        ids.splice(idx, 0, dragEntry);
        reorderFolders(ids);
      }
    },
  });

  const openFolder = folders.find(f => f.id === openFolderId) || null;

  // List view (Aug 14) - read-only rows instead of the drag-and-drop icon
  // grid; Customize forces tile view (see the `editing` effect in the
  // parent), so this branch never needs to carry drag handlers at all.
  if (view === 'list') {
    return (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {folders.map((f) => {
            const members = folderMembers(f.id).map(e => resolveEntryLink(itemsById, e)).filter(Boolean);
            return (
              <LinksListRow key={f.id} isFolder
                icon={<FolderOpen size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                name={f.name} sub={members.length > 0 ? `${members.length} apps` : 'Empty'}
                onOpen={() => setOpenFolderId(f.id)} />
            );
          })}
          {topItems.map((entry) => {
            const a = entryActions(entry, itemsById, actionCtx);
            if (!a) return null;
            return (
              <LinksListRow key={`${entry.item_type}:${entry.item_id}`}
                icon={<LinkIcon url={a.link.url} iconKey={a.link.icon} size={26} iconSize={13} radius={7} fg={a.color.fg} bg={a.color.bg} gradient={false} />}
                name={a.link.name} sub={a.link.category} onOpen={a.onOpen} />
            );
          })}
        </div>
        {openFolder && (
          <FolderModal
            folder={openFolder}
            memberEntries={folderMembers(openFolder.id)}
            itemsById={itemsById}
            actionCtx={actionCtx}
            editable={true}
            onClose={() => setOpenFolderId(null)}
            onRename={(name) => renameFolder(openFolder.id, name, immediateMutate)}
            onDeleteFolder={() => {
              if (!window.confirm(`Delete "${openFolder.name}"? Apps inside will move back to the main view.`)) return;
              deleteFolder(openFolder.id, immediateMutate);
              setOpenFolderId(null);
            }}
            onReorderWithin={(orderedEntries) => reorderWithinFolder(openFolder.id, orderedEntries, immediateMutate)}
            onMoveOut={(entry, destId) => moveToFolder(entry, destId, immediateMutate)}
            allFolders={folders}
            onCreateFolder={(entry) => createFolderWithItem(entry, immediateMutate)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <AppGrid>
        {folders.map((f) => (
          <FolderTile
            key={f.id} folder={f}
            memberLinks={folderMembers(f.id).map(e => resolveEntryLink(itemsById, e)).filter(Boolean)}
            onOpen={() => setOpenFolderId(f.id)}
            dragHandleProps={editable ? folderDragProps(f.id) : undefined}
            dropProps={editable ? folderDropProps(f.id) : undefined}
            isDropTarget={dragOverFolderId === f.id}
          />
        ))}
        {topItems.map((entry) => {
          const a = entryActions(entry, itemsById, actionCtx);
          if (!a) return null;
          return (
            <AppTile
              key={`${entry.item_type}:${entry.item_id}`} link={a.link} color={a.color} sourceType={a.sourceType} vaultLinked={a.vaultLinked}
              canManage={a.canManage} canDelete={a.canDelete}
              isFavorite={a.isFavorite} onToggleFavorite={a.onToggleFavorite}
              onOpen={a.onOpen} onEdit={a.onEdit} onDelete={a.onDelete}
              dragHandleProps={editable ? itemDragProps(entry) : undefined}
              dropProps={editable ? topItemDropProps() : undefined}
              // No "move to folder" picker icon on Personal Links (Aug 14) -
              // folders still work by dragging a tile onto one, this just
              // drops the extra hover-row button; Company Links keeps it.
              moveControls={(editable && sourceType !== 'personal') ? {
                extra: (
                  <FolderPicker
                    folders={folders} currentFolderId={null}
                    onMove={(destId) => moveToFolder(entry, destId)}
                    onCreateNew={() => createFolderWithItem(entry)}
                  />
                ),
              } : undefined}
            />
          );
        })}
        {extraAddTile && <AddAppTile label={extraAddTile.label} onClick={extraAddTile.onClick} />}
        {editable && <AddAppTile label="New Folder" onClick={createEmptyFolder} />}
      </AppGrid>

      {openFolder && (
        // Always fully interactive regardless of the outer Customize mode
        // (Aug 14, "when we drag an application from folder it is not
        // responsive... we should have the option to drag the application
        // from folder also and move to any other folder or just keep it on
        // main screen") - organizing an already-open folder is lightweight
        // and expected to just work, same posture as favoriting. Every
        // mutator here goes through `immediateMutate` (saves right away)
        // instead of `mutate` (the dirty-tracked draft that needs an
        // explicit Save while Customizing the main screen).
        <FolderModal
          folder={openFolder}
          memberEntries={folderMembers(openFolder.id)}
          itemsById={itemsById}
          actionCtx={actionCtx}
          editable={true}
          onClose={() => setOpenFolderId(null)}
          onRename={(name) => renameFolder(openFolder.id, name, immediateMutate)}
          onDeleteFolder={() => {
            if (!window.confirm(`Delete "${openFolder.name}"? Apps inside will move back to the main view.`)) return;
            deleteFolder(openFolder.id, immediateMutate);
            setOpenFolderId(null);
          }}
          onReorderWithin={(orderedEntries) => reorderWithinFolder(openFolder.id, orderedEntries, immediateMutate)}
          onMoveOut={(entry, destId) => moveToFolder(entry, destId, immediateMutate)}
          allFolders={folders}
          onCreateFolder={(entry) => createFolderWithItem(entry, immediateMutate)}
        />
      )}
    </>
  );
}

// One row in the view "…" menu - mirrors CustomDashboard.jsx's inline menu
// button markup exactly, pulled out here since Links only has one menu
// (no publish/department sections) rather than CustomDashboard's grouped list.
function ViewMenuItem({ icon: Icon, label, onClick, danger }) {
  return (
    <button onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none', background: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, textAlign: 'left', fontFamily: 'var(--wk-font)', color: danger ? 'hsl(var(--color-red))' : 'var(--ink)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'} onMouseLeave={e => e.currentTarget.style.background = 'none'}>
      <Icon size={14} /> {label}
    </button>
  );
}

// Small, reliable name dialog for saving/renaming/creating a view - mirrors
// CustomDashboard.jsx's own NameModal (replaces window.prompt, which
// wouldn't let the user type / was silently blocked in this app before).
// Auto-focuses; Enter submits, Esc cancels.
function NameModal({ title, label = 'View name', initial = '', cta = 'Save', onSubmit, onClose }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!v.trim() || busy) return;
    setBusy(true);
    try { await onSubmit(v.trim()); onClose(); } catch { setBusy(false); }
  };
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1450, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, width: '100%', maxWidth: 420, boxShadow: '0 24px 70px rgba(17,24,39,0.30)', fontFamily: 'var(--wk-font)' }}>
        <div style={{ padding: '15px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
        </div>
        <div style={{ padding: 18 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>{label}</label>
          <input autoFocus value={v} onChange={e => setV(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
            className="form-input" style={{ width: '100%' }} placeholder="e.g. Finance apps" />
          <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="secondary-btn" onClick={onClose}>Cancel</button>
            <button className="primary-btn" onClick={submit} disabled={!v.trim() || busy}>{busy ? 'Saving…' : cta}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ children, onClick, title, danger, disabled }) {
  return (
    <button
      onClick={onClick} title={title} disabled={disabled}
      style={{
        width: 24, height: 24, borderRadius: 6, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--card)', boxShadow: '0 1px 4px rgba(0,0,0,.15)', cursor: disabled ? 'default' : 'pointer',
        color: danger ? 'hsl(var(--color-red))' : 'var(--muted)', opacity: disabled ? 0.35 : 1,
      }}
    >
      {children}
    </button>
  );
}

function LinkModal({ modal, setModal, save, saving, departments, categories, companies, existingLinks }) {
  const { mode, form } = modal;
  const setForm = (patch) => setModal(m => ({ ...m, form: { ...m.form, ...patch } }));

  // Live duplicate warning as the admin types/pastes a URL - save() below
  // re-checks this at submit time too (the source of truth), this is just
  // faster feedback than waiting for the Save click to bounce.
  const duplicate = useMemo(() => {
    if (!form.url.trim()) return null;
    return existingLinks.find(l => l.id !== modal.id && normalizeUrl(l.url) === normalizeUrl(form.url)) || null;
  }, [form.url, existingLinks, modal.id]);

  // Auto-fill description from the site's own <meta name="description"> once
  // the admin tabs out of the URL field, so Add Link doesn't require copying
  // a blurb by hand for every link. Only ever overwrites a description this
  // same auto-fill put there (autoFilledDescRef tracks that value) or an
  // empty one - never something the admin actually typed. Best-effort and
  // silent: a site with no meta description, or the fetch failing outright,
  // just leaves the field as it was.
  const [fetchingPreview, setFetchingPreview] = useState(false);
  const autoFilledDescRef = useRef('');
  const fetchPreview = async () => {
    const raw = form.url.trim();
    if (!raw || (form.description && form.description !== autoFilledDescRef.current)) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    setFetchingPreview(true);
    try {
      const preview = await api.previewExternalLink(url);
      if (preview?.description) {
        autoFilledDescRef.current = preview.description;
        setForm({ description: preview.description });
      }
    } catch {
      /* best-effort prefill - the field just stays as it was */
    } finally {
      setFetchingPreview(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !saving && setModal(null)}>
      <div className="modal-content" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{mode === 'add' ? 'Add Link' : 'Edit Link'}</h3>
          <button className="close-btn" onClick={() => setModal(null)}><X size={16} /></button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label>Name</label>
            <input className="form-input" value={form.name} onChange={e => setForm({ name: e.target.value })} placeholder="e.g. Sage Intacct" autoFocus />
          </div>
          <div className="form-group">
            <label>URL</label>
            <input className="form-input" value={form.url} onChange={e => setForm({ url: e.target.value })} onBlur={fetchPreview} placeholder="https://..." />
            {duplicate && (
              <p style={{ fontSize: 11.5, color: 'hsl(var(--color-red))', margin: '5px 0 0', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                Already added as "{duplicate.name}"{duplicate.department ? ` (${duplicate.department})` : ''} - pick a different link, or edit that one instead.
              </p>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div className="form-group">
              <label>Category</label>
              <input className="form-input" list="ext-link-categories" value={form.category}
                onChange={e => setForm({ category: e.target.value })} placeholder="e.g. Finance & Accounting" />
              <datalist id="ext-link-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            <div className="form-group">
              <label>Department</label>
              <select className="form-select" value={form.department} onChange={e => setForm({ department: e.target.value })}>
                <option value="">All Departments</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Company</label>
            <select className="form-select" value={form.company} onChange={e => setForm({ company: e.target.value })}>
              <option value="">All Companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>
              Description
              {fetchingPreview && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginLeft: 8 }}>Fetching from site...</span>}
            </label>
            <textarea className="form-input" rows={2} value={form.description}
              onChange={e => setForm({ description: e.target.value })} placeholder="What is this for, in one line - or leave blank, we'll try to pull it from the site" />
          </div>
          <div className="form-group">
            <label>Icon</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 6 }}>
              {ICON_OPTIONS.map(key => {
                const Ico = ICON_MAP[key];
                const active = form.icon === key;
                return (
                  <button key={key} type="button" onClick={() => setForm({ icon: key })} title={key}
                    style={{
                      height: 32, borderRadius: 8, border: active ? '2px solid var(--wk-brand)' : '1px solid var(--wk-line2)',
                      background: active ? 'var(--wk-brand-tint)' : 'var(--card)', color: active ? 'var(--wk-brand)' : 'var(--muted)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    }}>
                    <Ico size={15} />
                  </button>
                );
              })}
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, color: 'var(--ink)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.is_pinned} onChange={e => setForm({ is_pinned: e.target.checked })} />
            Pin to top (featured for everyone)
          </label>
        </div>
        <div className="modal-footer">
          <button className="secondary-btn" onClick={() => setModal(null)} disabled={saving}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={saving || !!duplicate}>{saving ? 'Saving...' : mode === 'add' ? 'Add Link' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  );
}

// URLs shared by more than one row - a placeholder marker or an admin paste
// mistake (e.g. two apps pointed at the same portal by copy/paste error) are
// both "needs attention", not just the ones the seed data happened to flag.
function attentionFor(links) {
  const urlCounts = new Map();
  links.forEach(l => urlCounts.set(l.url, (urlCounts.get(l.url) || 0) + 1));
  const items = [];
  links.forEach(l => {
    if (l.url.includes('TBD.greensglobal.com')) items.push({ link: l, reason: 'Placeholder URL - needs the real link' });
    else if (urlCounts.get(l.url) > 1) items.push({ link: l, reason: `URL shared with ${urlCounts.get(l.url) - 1} other link${urlCounts.get(l.url) > 2 ? 's' : ''}` });
  });
  return items;
}

// Admin hub for the directory: All Links (grouped by category, drag to
// reorder, search, edit/delete) and Needs Attention (placeholder/duplicate
// URLs + departments with nothing in them yet) - plus Add Link and batch
// Import. Not scoped by the tile grid's department/category filter, so
// managing 30+ links doesn't mean hunting through sections first.
function ManageModal({
  links, onClose, onAdd, onAddForDept, onEdit, onDelete, canDelete, onReorder, onImported, companyName,
  onRefreshDescription, onRefreshAllDescriptions,
  taxonomy, onAddTaxonomy, onRenameTaxonomy, onDeleteTaxonomy, departmentNames,
}) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [showImport, setShowImport] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dropCategory, setDropCategory] = useState(null);
  const [deptPick, setDeptPick] = useState('');
  const [refreshingId, setRefreshingId] = useState(null); // per-row spinner
  const [refreshingAll, setRefreshingAll] = useState(false);

  const doRefreshOne = async (link) => {
    setRefreshingId(link.id);
    try { await onRefreshDescription(link); } finally { setRefreshingId(null); }
  };
  const doRefreshAll = async () => {
    if (!window.confirm('Re-fetch and shorten the description for every Company Link? This overwrites current descriptions.')) return;
    setRefreshingAll(true);
    try { await onRefreshAllDescriptions(); } finally { setRefreshingAll(false); }
  };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle
      ? links.filter(l => [l.name, l.category, l.department, l.description].some(v => (v || '').toLowerCase().includes(needle)))
      : links;
  }, [links, q]);

  const grouped = useMemo(() => {
    const map = new Map();
    rows.forEach(l => { const k = l.category || 'Other'; if (!map.has(k)) map.set(k, []); map.get(k).push(l); });
    for (const arr of map.values()) arr.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const attention = useMemo(() => attentionFor(links), [links]);
  const emptyDepartments = useMemo(() => departmentNames.filter(d => !links.some(l => l.department === d)), [links, departmentNames]);
  useEffect(() => {
    if (!emptyDepartments.includes(deptPick)) setDeptPick(emptyDepartments[0] || '');
  }, [emptyDepartments]); // eslint-disable-line react-hooks/exhaustive-deps
  const canReorder = q.trim() === '';

  const dropOnRow = (targetLink) => {
    if (dragId == null || dragId === targetLink.id) return;
    const group = grouped.find(([cat]) => cat === (targetLink.category || 'Other'));
    if (!group) return;
    const dragged = group[1].find(l => l.id === dragId);
    if (!dragged || dragged.category !== targetLink.category) return; // cross-category drag is a no-op
    const ids = group[1].map(l => l.id).filter(id => id !== dragId);
    ids.splice(ids.indexOf(targetLink.id), 0, dragId);
    onReorder(ids);
    setDragId(null);
    setDropCategory(null);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 820 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Manage Links</h3>
          <button className="close-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0' }}>
          <ManageTab active={tab === 'all'} onClick={() => setTab('all')}>All Links</ManageTab>
          <ManageTab active={tab === 'attention'} onClick={() => setTab('attention')}>
            Needs Attention{(attention.length + emptyDepartments.length) > 0 && (
              <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, background: 'hsla(var(--color-orange),0.18)', color: 'hsl(var(--color-orange))', padding: '1px 6px', borderRadius: 10 }}>
                {attention.length + emptyDepartments.length}
              </span>
            )}
          </ManageTab>
          <ManageTab active={tab === 'taxonomy'} onClick={() => setTab('taxonomy')}>Departments &amp; Categories</ManageTab>
        </div>

        {tab !== 'taxonomy' && (
          <div style={{ padding: '14px 24px 0', display: 'flex', gap: 10 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
              <input className="form-input" style={{ paddingLeft: 32 }} placeholder="Search links..." value={q} onChange={e => setQ(e.target.value)} />
            </div>
            <button className="secondary-btn" onClick={doRefreshAll} disabled={refreshingAll} title="Re-fetch and shorten every link's description">
              <RefreshCw size={14} className={refreshingAll ? 'spin' : undefined} /> {refreshingAll ? 'Shortening...' : 'Shorten Descriptions'}
            </button>
            <button className="secondary-btn" onClick={() => setShowImport(true)}><Upload size={14} /> Import</button>
            <button className="primary-btn" onClick={onAdd}><Plus size={15} /> Add Link</button>
          </div>
        )}

        <div style={{ padding: '16px 24px 20px', maxHeight: '60vh', overflowY: 'auto' }}>
          {tab === 'taxonomy' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
              <TaxonomyManager kind="department" label="Departments" items={taxonomy.departments}
                onAdd={onAddTaxonomy} onRename={onRenameTaxonomy} onDelete={onDeleteTaxonomy} />
              <TaxonomyManager kind="category" label="Categories" items={taxonomy.categories}
                onAdd={onAddTaxonomy} onRename={onRenameTaxonomy} onDelete={onDeleteTaxonomy} />
            </div>
          ) : tab === 'all' ? (
            rows.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: '30px 0' }}>No links match "{q}".</p>
            ) : (
              <>
                {!canReorder && (
                  <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10 }}>Clear the search to drag-reorder within a category.</p>
                )}
                {grouped.map(([cat, items]) => (
                  <div key={cat} style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: colorFor(cat).fg, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
                      {cat}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {items.map(l => {
                        const { fg, bg } = colorFor(l.category);
                        return (
                          <div
                            key={l.id}
                            draggable={canReorder}
                            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(l.id); }}
                            onDragOver={(e) => { if (canReorder && dragId != null) { e.preventDefault(); setDropCategory(cat); } }}
                            onDrop={(e) => { e.preventDefault(); dropOnRow(l); }}
                            onDragEnd={() => { setDragId(null); setDropCategory(null); }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8,
                              background: dragId === l.id ? 'var(--wk-brand-tint)' : (dropCategory === cat && dragId != null ? 'var(--mist)' : 'transparent'),
                              border: '1px solid var(--line)',
                            }}
                          >
                            {canReorder && <GripVertical size={13} style={{ color: 'var(--muted)', cursor: 'grab', flexShrink: 0 }} />}
                            <LinkIcon url={l.url} iconKey={l.icon} size={26} iconSize={14} radius={7} fg={fg} bg={bg} gradient={false} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', flexShrink: 0 }}>{l.name}</span>
                            {l.is_pinned && <Star size={11} style={{ color: 'hsl(var(--color-gold))', flexShrink: 0 }} fill="hsl(var(--color-gold))" />}
                            <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {l.department || 'All departments'}{l.company ? ` · ${companyName(l.company)}` : ''}
                            </span>
                            <span style={{ fontSize: 11.5, color: 'var(--muted)', flexShrink: 0 }}>{l.clicks || 0} uses</span>
                            <IconBtn onClick={() => doRefreshOne(l)} title="Re-fetch and shorten this link's description" disabled={refreshingId === l.id}>
                              <RefreshCw size={13} className={refreshingId === l.id ? 'spin' : undefined} />
                            </IconBtn>
                            <IconBtn onClick={() => onEdit(l)} title="Edit link"><Pencil size={13} /></IconBtn>
                            {canDelete && <IconBtn onClick={() => onDelete(l)} title="Delete link" danger><Trash2 size={13} /></IconBtn>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </>
            )
          ) : (
            <div>
              {emptyDepartments.length > 0 && (
                <div style={{ marginBottom: 20, padding: 12, borderRadius: 10, background: 'hsla(var(--color-orange),0.08)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, color: 'hsl(var(--color-orange))', marginBottom: 8 }}>
                    <FolderOpen size={14} /> Departments with no links yet
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select className="form-select" style={{ width: 'auto', minWidth: 180 }} value={deptPick} onChange={e => setDeptPick(e.target.value)}>
                      {emptyDepartments.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <button className="secondary-btn" onClick={() => onAddForDept(deptPick)} disabled={!deptPick}>
                      <Plus size={13} /> Add Link
                    </button>
                  </div>
                </div>
              )}
              {attention.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>No placeholder or duplicate links - nicely done.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {attention.map(({ link: l, reason }) => {
                    const { fg, bg } = colorFor(l.category);
                    return (
                      <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>
                        <AlertTriangle size={14} style={{ color: 'hsl(var(--color-orange))', flexShrink: 0 }} />
                        <LinkIcon url={l.url} iconKey={l.icon} size={26} iconSize={14} radius={7} fg={fg} bg={bg} gradient={false} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{l.name}</div>
                          <div style={{ fontSize: 11.5, color: 'hsl(var(--color-orange))' }}>{reason}</div>
                        </div>
                        <button className="secondary-btn" onClick={() => onEdit(l)} style={{ flexShrink: 0 }}><Pencil size={12} /> Fix</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={onImported} />}
    </div>
  );
}

function ManageTab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      border: 'none', background: 'none', cursor: 'pointer', padding: '6px 12px', fontSize: 12.5, fontWeight: 700,
      color: active ? 'var(--wk-brand)' : 'var(--muted)', borderBottom: active ? '2px solid var(--wk-brand)' : '2px solid transparent',
      display: 'flex', alignItems: 'center',
    }}>
      {children}
    </button>
  );
}

// Manage > Departments & Categories tab (Aug 14, "give the option to add,
// rename and remove any department and categories") - one instance for
// each kind. Renaming bulk-updates every link already using the old name
// server-side (see rename_taxonomy in external_links.py); deleting only
// removes it from this curated picker, existing links keep their string
// (same free-text philosophy Category already had).
function TaxonomyManager({ kind, label, items, onAdd, onRename, onDelete }) {
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const submitAdd = async () => {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true); setError('');
    try { await onAdd(kind, name); setNewName(''); }
    catch (e) { setError(e?.message || 'Could not add.'); }
    finally { setAdding(false); }
  };
  const startEdit = (item) => { setEditingId(item.id); setEditDraft(item.name); setError(''); };
  const commitEdit = async () => {
    const name = editDraft.trim();
    if (!name) { setEditingId(null); return; }
    setBusyId(editingId); setError('');
    try { await onRename(editingId, name); setEditingId(null); }
    catch (e) { setError(e?.message || 'Could not rename.'); }
    finally { setBusyId(null); }
  };
  const remove = async (item) => {
    if (!window.confirm(`Remove "${item.name}" from the ${label.toLowerCase()} list? Links already using it keep it - this only takes it out of the picker.`)) return;
    setBusyId(item.id); setError('');
    try { await onDelete(item.id); }
    catch (e) { setError(e?.message || 'Could not remove.'); }
    finally { setBusyId(null); }
  };

  return (
    <div>
      <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 10px' }}>{label}</h4>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input className="form-input" value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submitAdd(); }}
          placeholder={`Add a ${kind}...`} maxLength={80} />
        <button className="secondary-btn" onClick={submitAdd} disabled={!newName.trim() || adding}><Plus size={13} /></button>
      </div>
      {error && <p style={{ fontSize: 11.5, color: 'hsl(var(--color-red))', margin: '0 0 8px' }}>{error}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.length === 0 ? (
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing added yet.</p>
        ) : items.map(item => (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8, border: '1px solid var(--line)' }}>
            {editingId === item.id ? (
              <>
                <input className="form-input" autoFocus value={editDraft} onChange={e => setEditDraft(e.target.value)}
                  maxLength={80} style={{ flex: 1, padding: '5px 8px' }}
                  onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null); }} />
                <IconBtn onClick={commitEdit} disabled={busyId === item.id} title="Save"><Check size={12} /></IconBtn>
                <IconBtn onClick={() => setEditingId(null)} title="Cancel"><X size={12} /></IconBtn>
              </>
            ) : (
              <>
                <span style={{ flex: 1, fontSize: 13, color: 'var(--ink)' }}>{item.name}</span>
                <IconBtn onClick={() => startEdit(item)} disabled={busyId === item.id} title="Rename"><Pencil size={12} /></IconBtn>
                <IconBtn onClick={() => remove(item)} disabled={busyId === item.id} title="Remove" danger><Trash2 size={12} /></IconBtn>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Minimal CSV parser (no dependency) - handles quoted fields with embedded
// commas. Header row is optional and auto-detected off the first cell.
function parseCSVLine(line) {
  const cells = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}
// Deliberately no category/icon columns (Neil, Aug 12) - icon has to match an
// internal key so it's not fill-in-by-hand, and a missing category gets
// defaulted server-side ("Imported") rather than blocking the row. `company`
// is typed as a name (e.g. "Greens India"), not the raw entity id - resolved
// server-side, same reasoning as icon: not something to fill in from memory.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  const start = parseCSVLine(lines[0])[0]?.toLowerCase() === 'name' ? 1 : 0;
  return lines.slice(start).map(line => {
    const [name = '', url = '', department = '', company = '', description = '', pinned = ''] = parseCSVLine(line);
    return { name, url, department, company, description, is_pinned: /^(true|1|yes)$/i.test(pinned.trim()) };
  });
}

// Downloads a starter CSV with the exact header + a couple of filled-in
// example rows so "what format does Import want" never has to be answered
// in chat - the file that comes back out of Import is already the answer.
function downloadImportTemplate() {
  const csv = [
    'name,url,department,company,description,pinned',
    'ADP,https://adp.com,Accounting,Greens,Payroll processing,false',
    'Slack,https://slack.com,,,Team chat,false',
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'external-links-import-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ImportModal({ onClose, onImported }) {
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null); // { createdCount, errors }
  const fileRef = useRef(null);

  const rows = useMemo(() => parseCSV(text), [text]);
  const validCount = rows.filter(r => r.name && r.url).length;

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ''));
    reader.readAsText(file);
    e.target.value = '';
  };

  const doImport = async () => {
    if (validCount === 0) return;
    setImporting(true);
    try {
      const res = await api.importExternalLinks(rows);
      onImported(res.created || []);
      setResult({ createdCount: (res.created || []).length, errors: res.errors || [] });
    } catch (e) {
      setResult({ createdCount: 0, errors: [{ row: '-', name: '-', reason: e?.message || 'Import failed' }] });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Batch Import Links</h3>
          <button className="close-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!result ? (
            <>
              <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                Paste CSV or upload a file. Columns (in order): <code>name, url, department, company, description, pinned</code> -
                only name/url are required, and a header row is optional. Category and icon aren't part of the
                sheet - imported links land in an "Imported" category you can re-sort from Manage afterward.
                Company is typed by name (e.g. "Greens India"); an unrecognized name is left as all-companies rather than failing the row.
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="secondary-btn" onClick={downloadImportTemplate}><Download size={14} /> Export Template</button>
                <button className="secondary-btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> Upload CSV</button>
                <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={handleFile} />
                {rows.length > 0 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{validCount} of {rows.length} row{rows.length === 1 ? '' : 's'} look valid</span>}
              </div>
              <textarea
                className="form-input" rows={7} value={text} onChange={e => setText(e.target.value)}
                placeholder={'name,url,department,company,description,pinned\nADP,https://adp.com,Accounting,Greens,Payroll processing,false'}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              {rows.length > 0 && (
                <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {['Name', 'URL', 'Department', 'Company', 'Description'].map(h => (
                          <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontWeight: 700, fontSize: 10, textTransform: 'uppercase' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const valid = r.name && r.url;
                        return (
                          <tr key={i} style={{ background: valid ? 'transparent' : 'hsla(var(--color-red),0.06)' }}>
                            <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--line)' }}>{r.name || <em style={{ color: 'hsl(var(--color-red))' }}>missing</em>}</td>
                            <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--line)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url || <em style={{ color: 'hsl(var(--color-red))' }}>missing</em>}</td>
                            <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--line)' }}>{r.department || 'All'}</td>
                            <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--line)' }}>{r.company || 'All'}</td>
                            <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--line)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div>
              <p style={{ fontSize: 13.5, fontWeight: 600, color: 'hsl(var(--color-green))' }}>
                {result.createdCount} link{result.createdCount === 1 ? '' : 's'} imported.
              </p>
              {result.errors.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <p style={{ fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-red))' }}>{result.errors.length} row(s) skipped:</p>
                  <ul style={{ fontSize: 12, color: 'var(--muted)', paddingLeft: 18 }}>
                    {result.errors.map((e, i) => <li key={i}>Row {e.row} ({e.name}): {e.reason}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          {!result ? (
            <>
              <button className="secondary-btn" onClick={onClose} disabled={importing}>Cancel</button>
              <button className="primary-btn" onClick={doImport} disabled={importing || validCount === 0}>
                {importing ? 'Importing...' : `Import ${validCount} Link${validCount === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <button className="primary-btn" onClick={onClose}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}

