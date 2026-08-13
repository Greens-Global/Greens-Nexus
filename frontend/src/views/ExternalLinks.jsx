import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { PersonalLockGate } from '../credvault/vaultShared';
import { useLinkLayout } from './useLinkLayout';
import {
  Search, Plus, Pencil, Trash2, X, Star,
  Link2, Mail, Calendar, Users2, FolderKanban, Rocket, MessagesSquare, BookOpen,
  HelpCircle, Clock, FileSpreadsheet, Zap, Wifi, Landmark, Wallet, Building2,
  Newspaper, GraduationCap, LineChart, Briefcase, Shield, Globe, Megaphone,
  HardHat, Ruler, CreditCard, PiggyBank, Receipt, ClipboardList, Headphones,
  Video, LayoutGrid, TrendingUp, ArrowUpDown, CheckSquare, Cloud, Presentation,
  Gauge, Bird, Warehouse, Settings2, Bookmark, CornerDownLeft, History, List, Command,
  GripVertical, AlertTriangle, Upload, FolderOpen, Download, Lock, KeyRound, Info,
  ChevronUp, ChevronDown, FolderPlus, Check,
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
// "Development" deliberately excluded per that ask. Fixed list (not derived
// from data) so every department shows in the filter even before it has any
// links yet, and is also what the Add/Edit modal offers to scope a link to -
// the field stays free text so a one-off department name isn't blocked.
const DEPARTMENTS = ['Accounting', 'Administration', 'Construction', 'IT', 'Storage'];

// Fixed category chips (Neil, Aug 13) - shown up front in the filter bar
// regardless of whether a category has any links yet, same reasoning as
// DEPARTMENTS above. Free text everywhere else (Add/Edit modal, CSV import),
// so a one-off category isn't blocked - it just also appears as a chip once
// something is filed under it.
const CATEGORIES = ['Banking', 'Day to Day', 'Finance & Accounting', 'HR & Payroll', 'Productivity', 'Reference & Support'];

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
const ICON_MAP = {
  Link2, Mail, Calendar, Users2, FolderKanban, Rocket, MessagesSquare, BookOpen,
  HelpCircle, Clock, FileSpreadsheet, Zap, Wifi, Landmark, Wallet, Building2,
  Newspaper, GraduationCap, LineChart, Briefcase, Shield, Globe, Megaphone,
  HardHat, Ruler, CreditCard, PiggyBank, Receipt, ClipboardList, Headphones, Video,
  CheckSquare, Cloud, Presentation, Gauge, Bird, Warehouse,
};
const iconFor = (key) => ICON_MAP[key] || Link2;

// "Imported" is the server-side default category for a CSV row that didn't
// specify one (see import_external_links in external_links.py) - it's a
// placeholder to keep the row grouped with its batch until someone re-sorts
// it from Manage, not a real category, so it shouldn't read as one on every
// tile forever. Hide the chip rather than the category itself (Manage still
// needs the real value to filter/re-sort by).
const isPlaceholderCategory = (cat) => (cat || '').trim().toLowerCase() === 'imported';

// Clearbit's free logo API was shut down (logo.clearbit.com no longer
// resolves at all, Aug 2026) - it used to be the first choice here because it
// served the actual brand mark at real resolution. icon.horse is first now:
// it resolves a site's real high-res logo/favicon (up to 180x180, not just
// whatever tiny favicon.ico the site declared) and serves it from its own
// host with no redirect, so it doesn't need a second CSP img-src entry the
// way the old www.google.com/s2/favicons fallback did (that endpoint
// redirects to a *different* host, t1.gstatic.com, which CSP checks against
// instead of the one that was actually requested). Google's faviconV2 stays
// as the second attempt for the handful of domains icon.horse doesn't have -
// `fallback_opts` deliberately omits `TYPE` so a domain with nothing on file
// 404s instead of silently returning Google's generic globe glyph as if it
// were a real logo; the 404 is what lets onError fall through to our own
// (nicer, brand-colored) lucide icon instead of that globe.
function logoSources(url, size) {
  try {
    const hostname = new URL(url).hostname;
    return [
      `https://icon.horse/icon/${hostname}`,
      `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=&url=https://${hostname}&size=${size}`,
    ];
  } catch {
    return [];
  }
}

// Every link tile in this view (grid card, list row, palette result, Manage
// rows) used to render the admin-picked lucide glyph. Real site logos read
// far more recognizable at a glance ("that's the ADP logo") than a generic
// folder/globe icon, so this swaps to the actual brand mark and only falls
// back to the curated lucide glyph once every image source has failed to
// load (network blocked, ad blocker, unrecognized domain, etc - `iconKey`
// stays on the model for that).
function LinkIcon({ url, iconKey, size = 42, iconSize, radius = 12, fg, bg, gradient = true }) {
  const sources = useMemo(() => logoSources(url, Math.max(size * 3, 128)), [url, size]);
  const [attempt, setAttempt] = useState(0);
  const src = attempt < sources.length ? sources[attempt] : null;
  const Fallback = iconFor(iconKey);
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, color: fg, flexShrink: 0, overflow: 'hidden',
      background: gradient ? `linear-gradient(135deg, ${bg}, ${bg} 40%, transparent)` : bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {src ? (
        <img
          key={src} src={src} alt="" width={Math.round(size * 0.68)} height={Math.round(size * 0.68)}
          style={{ objectFit: 'contain' }} onError={() => setAttempt(a => a + 1)}
        />
      ) : (
        <Fallback size={iconSize || Math.round(size * 0.5)} />
      )}
    </div>
  );
}

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

const SORTS = [
  { id: 'category', label: 'By Category' },
  { id: 'popular',  label: 'Most Used' },
  { id: 'az',       label: 'A-Z' },
  { id: 'new',      label: 'Recently Added' },
];

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
  const [sortBy, setSortBy] = useState('category');
  const [view, setView] = useState(() => localStorage.getItem('nexus:extlinks:view') || 'grid');

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
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  // Copy-and-go: a Personal Link can be paired with one of the owner's own
  // Credential Vault personal credentials (Aug 13). Opening it reveals +
  // copies the password to the clipboard first, then opens the site - no
  // in-page autofill (a website can't reach into another origin's login
  // form; that needs a browser extension, which this is not). vaultCreds is
  // fetched best-effort: an employee without the "credvault" module grant
  // just never sees the picker, same silent-degrade as the Company filter
  // dropdown above when getPeopleDirectory has nothing.
  const [vaultCreds, setVaultCreds] = useState([]);
  useEffect(() => { api.cvPersonal().then(setVaultCreds).catch(() => setVaultCreds([])); }, []);
  const [pendingVaultOpen, setPendingVaultOpen] = useState(null); // link waiting on Personal Vault unlock
  const [showVaultLockGate, setShowVaultLockGate] = useState(false);

  // Personalization (Aug 13) - app ordering, folders, and favorites are now
  // backend-persisted per account (see useLinkLayout.js), not localStorage,
  // so they follow the signed-in user across devices/browsers. Recent stays
  // localStorage-only on purpose - it's an auto-derived, ephemeral trail
  // (last 8 clicked), not something deliberately arranged, and the task
  // this shipped for didn't name it among what must be user-specific.
  const { layout, loading: layoutLoading, saveError, clearSaveError, mutate } = useLinkLayout();
  useEffect(() => {
    if (saveError) { setBanner({ kind: 'err', text: saveError }); clearSaveError(); }
  }, [saveError, clearSaveError]);

  // Favorites can reference either a Company Link or a Personal Link (their
  // ids are both plain autoincrement ints on separate tables, hence the
  // item_type tag) - derive the plain-id arrays each call site already
  // expects (favorites.includes(l.id)) so LinkList/AppTile don't need to
  // know about the type distinction, and a toggleFavorite bound to the
  // right type per section.
  const favoriteExternalIds = useMemo(() => layout.favorites.filter(f => f.item_type === 'external').map(f => f.item_id), [layout.favorites]);
  const favoritePersonalIds = useMemo(() => layout.favorites.filter(f => f.item_type === 'personal').map(f => f.item_id), [layout.favorites]);
  const makeToggleFavorite = useCallback((itemType) => (itemId) => {
    mutate(prev => {
      const exists = prev.favorites.some(f => f.item_type === itemType && f.item_id === itemId);
      const favorites = exists
        ? prev.favorites.filter(f => !(f.item_type === itemType && f.item_id === itemId))
        : [...prev.favorites, { item_type: itemType, item_id: itemId }];
      return { ...prev, favorites };
    });
  }, [mutate]);
  const toggleFavorite = useMemo(() => makeToggleFavorite('external'), [makeToggleFavorite]);
  const togglePersonalFavorite = useMemo(() => makeToggleFavorite('personal'), [makeToggleFavorite]);

  const [recents, setRecents] = useState(() => readIds(myEmail, 'recents'));
  useEffect(() => { setRecents(readIds(myEmail, 'recents')); }, [myEmail]);

  const pushRecent = useCallback((id) => {
    setRecents(prev => {
      const next = [id, ...prev.filter(x => x !== id)].slice(0, 8);
      writeIds(myEmail, 'recents', next);
      return next;
    });
  }, [myEmail]);

  // Cmd/Ctrl+K opens the command palette from anywhere on the page - the
  // Okta/Linear/Raycast "just start typing" pattern for a fast app launch
  // without touching the department/category filters below.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    const extra = categoriesInUse.filter(c => !CATEGORIES.includes(c)).sort();
    return [...CATEGORIES, ...extra];
  }, [categoriesInUse]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return deptFiltered.filter(l => {
      if (category && l.category !== category) return false;
      if (!needle) return true;
      return [l.name, l.description, l.category, l.department].some(v => (v || '').toLowerCase().includes(needle));
    });
  }, [deptFiltered, category, q]);

  // My Layout (personalization) - gated on whether ordering/folders have
  // actually been customized, NOT the hook's isCustomized flag alone: that
  // flag just means "a layout row exists," which happens the moment someone
  // favorites a single link (favorites live in the same document) - using it
  // directly would dump a user into an otherwise-empty "My Layout" the first
  // time they favorite anything, before they ever touched ordering. This
  // only switches once there's real ordering/folder data to show.
  const hasCustomOrder = layout.items.length > 0 || layout.folders.length > 0;
  const filteredById = useMemo(() => new Map(filtered.map(l => [l.id, l])), [filtered]);
  const beginCustomizing = () => {
    mutate(prev => {
      const ordered = [...all].sort((a, b) =>
        (Number(b.is_pinned) - Number(a.is_pinned)) || (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
      return { ...prev, items: ordered.map((l, i) => ({ item_type: 'external', item_id: l.id, folder_id: null, position: i })) };
    });
  };

  const pinned = useMemo(() => filtered.filter(l => l.is_pinned), [filtered]);
  const rest = useMemo(() => filtered.filter(l => !l.is_pinned), [filtered]);

  const grouped = useMemo(() => {
    if (sortBy !== 'category') return null;
    const map = new Map();
    rest.forEach(l => {
      const key = l.category || 'Other';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(l);
    });
    for (const arr of map.values()) arr.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rest, sortBy]);

  const flatSorted = useMemo(() => {
    if (sortBy === 'category') return null;
    const arr = [...rest];
    if (sortBy === 'popular') arr.sort((a, b) => (b.clicks || 0) - (a.clicks || 0));
    else if (sortBy === 'az') arr.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'new') arr.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id - a.id);
    return arr;
  }, [rest, sortBy]);

  const openLink = (link) => {
    window.open(link.url, '_blank', 'noopener,noreferrer');
    pushRecent(link.id);
    api.clickExternalLink(link.id).then(updated => {
      setLinks(prev => (prev || []).map(l => (l.id === link.id ? updated : l)));
    }).catch(() => {});
  };

  const setViewMode = (mode) => { setView(mode); try { localStorage.setItem('nexus:extlinks:view', mode); } catch { /* ignore */ } };

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

  const openAddPersonal = () => setPersonalModal({ mode: 'add', id: null, form: { name: '', url: '', description: '', icon: 'Link2', vault_cred_id: '' } });
  const openEditPersonal = (link) => setPersonalModal({
    mode: 'edit', id: link.id,
    form: { name: link.name, url: link.url, description: link.description || '', icon: link.icon || 'Link2', vault_cred_id: link.vault_cred_id || '' },
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
        <div style={{ display: 'flex', gap: 8 }}>
          {section === 'company' && !hasCustomOrder && !isLoading && (
            <button className="secondary-btn" onClick={beginCustomizing} title="Arrange these into your own order and folders - only you will see the change">
              <LayoutGrid size={14} /> Customize My Layout
            </button>
          )}
          {section === 'company' && (
            <button className="secondary-btn" onClick={() => setPaletteOpen(true)}>
              <Command size={14} /> Quick Search
              <kbd style={{ fontSize: 10, fontWeight: 700, opacity: .7, marginLeft: 2 }}>{navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
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

      {section === 'personal' && (
        <PersonalLinksSection
          links={personalLinks} onOpen={openPersonalLink} onAdd={openAddPersonal}
          onEdit={openEditPersonal} onDelete={removePersonal}
          favorites={favoritePersonalIds} onToggleFavorite={togglePersonalFavorite}
        />
      )}

      {section === 'company' && (<>
        {/* Personal shortcuts - client-local, not scoped by the filters below */}
        {favoriteLinks.length > 0 && (
          <PersonalStrip title="My Favorites" icon={Bookmark} iconColor="hsl(var(--color-blue))" links={favoriteLinks}
            onOpen={(l) => (l._favType === 'personal' ? openPersonalLink(l) : openLink(l))} />
        )}
        {recentLinks.length > 0 && (
          <PersonalStrip title="Recently Used" icon={History} iconColor="var(--muted)" links={recentLinks}
            onOpen={openLink} />
        )}

        {/* Filter bar */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'center' }}>
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
            {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          {companies.length > 0 && (
            <select className="form-select" style={{ width: 'auto', minWidth: 170 }} value={companyFilter}
              onChange={e => { setCompanyFilter(e.target.value); setCategory(''); }}>
              <option value="">All Companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
            <ArrowUpDown size={14} style={{ color: 'var(--muted)' }} />
            <select className="form-select" style={{ width: 'auto', minWidth: 150 }} value={sortBy} onChange={e => setSortBy(e.target.value)}>
              {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', background: 'var(--mist)', borderRadius: 8, padding: 2 }}>
            <ViewToggleBtn active={view === 'grid'} onClick={() => setViewMode('grid')} title="Grid view"><LayoutGrid size={14} /></ViewToggleBtn>
            <ViewToggleBtn active={view === 'list'} onClick={() => setViewMode('list')} title="List view"><List size={14} /></ViewToggleBtn>
          </div>
        </div>

        {/* Category chips */}
        {categoriesAvailable.length > 0 && (
          <div className="scroll-tabs" style={{ display: 'flex', gap: 8, marginBottom: 20, overflowX: 'auto', paddingBottom: 4 }}>
            <Chip active={!category} label="All Categories" onClick={() => setCategory('')} />
            {categoriesAvailable.map(c => (
              <Chip key={c} active={category === c} label={c} color={colorFor(c)} onClick={() => setCategory(category === c ? '' : c)} />
            ))}
          </div>
        )}

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
          {hasCustomOrder ? (
            <Section title="My Layout" icon={LayoutGrid}>
              <MyLayoutSection
                layout={layout} itemsById={filteredById}
                canManage={canManage} canDelete={canDelete}
                favorites={favoriteExternalIds} onToggleFavorite={toggleFavorite}
                onOpen={openLink} onEdit={openEdit} onDelete={remove}
                mutate={mutate}
              />
            </Section>
          ) : (<>
            {pinned.length > 0 && (
              <Section title="Pinned" icon={Star}>
                <LinkList view={view} items={pinned} canManage={canManage} canDelete={canDelete}
                  favorites={favoriteExternalIds} onToggleFavorite={toggleFavorite}
                  onOpen={openLink} onEdit={openEdit} onDelete={remove} />
              </Section>
            )}

            {sortBy === 'category' && grouped && grouped.map(([cat, items]) => (
              <Section key={cat} title={cat} color={colorFor(cat)}>
                <LinkList view={view} items={items} canManage={canManage} canDelete={canDelete}
                  favorites={favoriteExternalIds} onToggleFavorite={toggleFavorite}
                  onOpen={openLink} onEdit={openEdit} onDelete={remove} />
              </Section>
            ))}

            {sortBy !== 'category' && flatSorted && (
              <Section title={SORTS.find(s => s.id === sortBy)?.label} icon={sortBy === 'popular' ? TrendingUp : undefined}>
                <LinkList view={view} items={flatSorted} canManage={canManage} canDelete={canDelete}
                  favorites={favoriteExternalIds} onToggleFavorite={toggleFavorite}
                  onOpen={openLink} onEdit={openEdit} onDelete={remove} />
              </Section>
            )}
          </>)}
        </AsyncSection>
      </>)}

      {showManage && (
        <ManageModal
          links={all} onClose={() => setShowManage(false)}
          onAdd={openAdd} onAddForDept={openAddForDept} onEdit={openEdit} onDelete={remove}
          canDelete={canDelete} onReorder={reorderCategory} onImported={onImported}
          companyName={companyName}
        />
      )}

      {modal && (
        <LinkModal
          modal={modal} setModal={setModal} save={save} saving={saving}
          departments={[...new Set([...DEPARTMENTS, ...meta.departments])].sort()}
          categories={[...new Set([...CATEGORIES, ...meta.categories])].sort()} companies={companies}
          existingLinks={all}
        />
      )}

      {paletteOpen && (
        <CommandPalette links={all} onOpen={openLink} onClose={() => setPaletteOpen(false)} />
      )}

      {personalModal && (
        <PersonalLinkModal modal={personalModal} setModal={setPersonalModal} save={savePersonal} saving={personalSaving} vaultCreds={vaultCreds} existingLinks={personalLinks || []} />
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
    </div>
  );
}

function Chip({ active, label, onClick, color }) {
  return (
    <button
      onClick={onClick}
      style={{
        flexShrink: 0, border: 'none', borderRadius: 20, padding: '7px 14px', fontSize: 12.5, fontWeight: 600,
        cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background .15s, color .15s',
        background: active ? (color?.fg || 'var(--pine)') : (color?.bg || 'var(--mist)'),
        color: active ? '#fff' : (color?.fg || 'var(--muted)'),
      }}
    >
      {label}
    </button>
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
function PersonalLinksSection({ links, onOpen, onAdd, onEdit, onDelete, favorites, onToggleFavorite }) {
  const items = links || [];
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
      <AppGrid>
        {items.map(l => (
          <AppTile key={l.id} link={l} color={PERSONAL_COLOR} vaultLinked={!!l.vault_cred_id}
            canManage canDelete onEdit={() => onEdit(l)} onDelete={() => onDelete(l)} onOpen={() => onOpen(l)}
            isFavorite={favorites.includes(l.id)} onToggleFavorite={() => onToggleFavorite(l.id)} />
        ))}
        <AddAppTile label="Add Link" onClick={onAdd} />
      </AppGrid>
    </div>
  );
}

function PersonalLinkModal({ modal, setModal, save, saving, vaultCreds, existingLinks }) {
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
          <div className="form-group">
            <label>Password (optional)</label>
            {vaultCreds.length > 0 ? (
              <select className="form-select" value={form.vault_cred_id || ''} onChange={e => setForm({ vault_cred_id: e.target.value })}>
                <option value="">None - just open the link</option>
                {vaultCreds.map(c => <option key={c.id} value={c.id}>{c.name}{c.username && c.username !== '-' ? ` (${c.username})` : ''}</option>)}
              </select>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                No saved passwords yet - add one in Credential Vault's Personal Vault, then come back here to attach it.
              </p>
            )}
            <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '4px 0 0', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
              <KeyRound size={12} style={{ flexShrink: 0, marginTop: 1 }} />
              Attaching a password copies it to your clipboard right before the site opens, so you just paste it in - Nexus can't fill it in for you automatically (the site's own login page is a different website).
            </p>
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

function ViewToggleBtn({ active, onClick, title, children }) {
  return (
    <button onClick={onClick} title={title} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 26, border: 'none',
      borderRadius: 6, cursor: 'pointer', background: active ? 'var(--card)' : 'transparent',
      color: active ? 'var(--ink)' : 'var(--muted)', boxShadow: active ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
      transition: 'background .12s, color .12s',
    }}>
      {children}
    </button>
  );
}

// Horizontal shortcut row (Favorites / Recently Used) - compact pill-tiles,
// distinct from the full card grid below so personal shortcuts read as a
// quick-launch strip rather than another section to scan top to bottom.
function PersonalStrip({ title, icon: Icon, iconColor, links, onOpen }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <Icon size={14} style={{ color: iconColor }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' }}>{title}</span>
      </div>
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
  iconSize = 60, iconGradient = true, vaultLinked = false,
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

  return (
    <div
      className="app-tile" onClick={onOpen} data-link-id={link.id}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title={!description ? link.name : undefined}
      aria-describedby={tooltipId}
      {...dropProps}
    >
      <div className="app-tile-icon-wrap">
        <LinkIcon url={link.url} iconKey={link.icon} size={iconSize} radius={Math.round(iconSize * 0.28)} fg={color.fg} bg={color.bg} gradient={iconGradient} />
        {link.is_pinned && <span className="app-tile-pin"><Star size={9} fill="currentColor" /></span>}
        {isFavorite && <span className="app-tile-fav-badge"><Bookmark size={9} fill="currentColor" /></span>}
        {vaultLinked && <span className="app-tile-key-badge" title="Copies its saved password when opened"><KeyRound size={9} /></span>}
        {hasActions && (
          <div className="app-tile-actions" onClick={e => e.stopPropagation()}>
            {dragHandleProps && (
              <span className="app-tile-grip" draggable {...dragHandleProps} title="Drag to reorder">
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
            {moveControls && (
              <>
                <IconBtn onClick={moveControls.onMoveUp} title="Move up" disabled={!moveControls.canMoveUp}><ChevronUp size={12} /></IconBtn>
                <IconBtn onClick={moveControls.onMoveDown} title="Move down" disabled={!moveControls.canMoveDown}><ChevronDown size={12} /></IconBtn>
                {moveControls.extra}
              </>
            )}
          </div>
        )}
        {description && (
          <>
            <div id={tooltipId} role="tooltip" className={`app-tile-tooltip${showTip ? ' show' : ''}`}>{description}</div>
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

function FolderTile({ folder, memberLinks, onOpen, dragHandleProps, dropProps, moveControls }) {
  const preview = memberLinks.slice(0, 4);
  return (
    <div
      className="app-tile" onClick={onOpen} data-folder-id={folder.id}
      role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title={folder.name}
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
        {(dragHandleProps || moveControls) && (
          <div className="app-tile-actions" onClick={e => e.stopPropagation()}>
            {dragHandleProps && (
              <span className="app-tile-grip" draggable {...dragHandleProps} title="Drag to reorder">
                <GripVertical size={11} />
              </span>
            )}
            {moveControls && (
              <>
                <IconBtn onClick={moveControls.onMoveUp} title="Move up" disabled={!moveControls.canMoveUp}><ChevronUp size={12} /></IconBtn>
                <IconBtn onClick={moveControls.onMoveDown} title="Move down" disabled={!moveControls.canMoveDown}><ChevronDown size={12} /></IconBtn>
              </>
            )}
          </div>
        )}
      </div>
      <span className="app-tile-name">{folder.name}{memberLinks.length > 0 ? ` (${memberLinks.length})` : ''}</span>
    </div>
  );
}

// Opens a folder's contents - inline-renamable title, delete (unfolds
// members back to top-level, never deletes the underlying links), and each
// member gets the same reorder/move-out controls as the top-level grid.
function FolderModal({
  folder, memberEntries, itemsById, canManage, canDelete, favorites, onToggleFavorite,
  onOpen, onEdit, onDelete, onClose, onRename, onDeleteFolder, onReorderWithin, onMoveOut,
  allFolders, onCreateFolder,
}) {
  const [nameDraft, setNameDraft] = useState(folder.name);
  const [renaming, setRenaming] = useState(false);
  // Own small drag state for reordering within this folder - separate DnD
  // context from the background grid (this is a modal on top of it), so it
  // doesn't share MyLayoutSection's dragKind/dragId.
  const [dragItemId, setDragItemId] = useState(null);
  const commitRename = () => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== folder.name) onRename(trimmed);
    setRenaming(false);
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
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
          ) : (
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setRenaming(true)} title="Click to rename">
              {folder.name} <Pencil size={13} style={{ color: 'var(--muted)' }} />
            </h3>
          )}
          <button className="close-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ padding: '20px 24px' }}>
          {memberEntries.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>
              Empty - use "Move to folder" on any app to add it here.
            </p>
          ) : (
            <AppGrid>
              {memberEntries.map((entry, i) => {
                const link = itemsById.get(entry.item_id);
                if (!link) return null;
                return (
                  <AppTile
                    key={entry.item_id} link={link} color={colorFor(link.category)}
                    canManage={canManage} canDelete={canDelete}
                    isFavorite={favorites.includes(link.id)} onToggleFavorite={() => onToggleFavorite(link.id)}
                    onOpen={() => onOpen(link)} onEdit={() => onEdit(link)} onDelete={() => onDelete(link)}
                    dragHandleProps={{
                      onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; setDragItemId(entry.item_id); },
                      onDragEnd: () => setDragItemId(null),
                    }}
                    dropProps={{
                      onDragOver: (e) => { if (dragItemId != null) e.preventDefault(); },
                      onDrop: (e) => {
                        e.preventDefault();
                        if (dragItemId == null || dragItemId === entry.item_id) return;
                        const fromIdx = memberEntries.findIndex(x => x.item_id === dragItemId);
                        if (fromIdx === -1) return;
                        onReorderWithin(fromIdx, i);
                        setDragItemId(null);
                      },
                    }}
                    moveControls={{
                      canMoveUp: i > 0, canMoveDown: i < memberEntries.length - 1,
                      onMoveUp: () => onReorderWithin(i, i - 1), onMoveDown: () => onReorderWithin(i, i + 1),
                      extra: (
                        <FolderPicker
                          folders={allFolders} currentFolderId={folder.id}
                          onMove={(destId) => onMoveOut(entry.item_id, destId)}
                          onCreateNew={() => onCreateFolder(entry.item_id)}
                        />
                      ),
                    }}
                  />
                );
              })}
            </AppGrid>
          )}
        </div>
        <div className="modal-footer">
          <button className="secondary-btn" style={{ color: 'hsl(var(--color-red))' }} onClick={onDeleteFolder}>
            <Trash2 size={14} /> Delete Folder
          </button>
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
function MyLayoutSection({ layout, itemsById, canManage, canDelete, favorites, onToggleFavorite, onOpen, onEdit, onDelete, mutate }) {
  const [openFolderId, setOpenFolderId] = useState(null);
  // Desktop drag-and-drop state - HTML5 native, mirrors ManageModal's
  // draggable/onDragStart/onDragOver/onDrop/onDragEnd pattern elsewhere in
  // this file (its own "All Links" category reorder). Touch has no
  // equivalent gesture (poor/no support for native HTML5 DnD), so every tile
  // also gets Move Up/Down + a folder picker as the touch-inclusive path -
  // see AppTile's moveControls.
  const [dragKind, setDragKind] = useState(null); // 'item' | 'folder' | null
  const [dragId, setDragId] = useState(null);

  const topItems = useMemo(
    () => layout.items.filter(i => i.folder_id === null && itemsById.has(i.item_id)).sort((a, b) => a.position - b.position),
    [layout.items, itemsById]
  );
  const folders = useMemo(() => [...layout.folders].sort((a, b) => a.position - b.position), [layout.folders]);
  const folderMembers = useCallback(
    (folderId) => layout.items.filter(i => i.folder_id === folderId && itemsById.has(i.item_id)).sort((a, b) => a.position - b.position),
    [layout.items, itemsById]
  );

  const reorderTopLevel = (orderedIds) => mutate(prev => {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    return { ...prev, items: prev.items.map(i => (i.folder_id === null && rank.has(i.item_id)) ? { ...i, position: rank.get(i.item_id) } : i) };
  });
  const reorderFolders = (orderedIds) => mutate(prev => {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    return { ...prev, folders: prev.folders.map(f => rank.has(f.id) ? { ...f, position: rank.get(f.id) } : f) };
  });
  const reorderWithinFolder = (folderId, orderedIds) => mutate(prev => {
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    return { ...prev, items: prev.items.map(i => (i.folder_id === folderId && rank.has(i.item_id)) ? { ...i, position: rank.get(i.item_id) } : i) };
  });
  const moveToFolder = (itemId, folderId) => mutate(prev => {
    const dest = prev.items.filter(i => i.folder_id === folderId && i.item_id !== itemId);
    const nextPos = dest.length ? Math.max(...dest.map(i => i.position)) + 1 : 0;
    return { ...prev, items: prev.items.map(i => i.item_id === itemId ? { ...i, folder_id: folderId, position: nextPos } : i) };
  });
  const createFolderWithItem = (itemId) => {
    const id = `f_${Math.random().toString(36).slice(2, 8)}`;
    mutate(prev => {
      const position = prev.folders.length ? Math.max(...prev.folders.map(f => f.position)) + 1 : 0;
      return {
        ...prev,
        folders: [...prev.folders, { id, name: 'New Folder', position }],
        items: prev.items.map(i => i.item_id === itemId ? { ...i, folder_id: id, position: 0 } : i),
      };
    });
    setOpenFolderId(id); // straight into the modal so the user can rename it right away
  };
  const createEmptyFolder = () => {
    const id = `f_${Math.random().toString(36).slice(2, 8)}`;
    mutate(prev => {
      const position = prev.folders.length ? Math.max(...prev.folders.map(f => f.position)) + 1 : 0;
      return { ...prev, folders: [...prev.folders, { id, name: 'New Folder', position }] };
    });
    setOpenFolderId(id);
  };
  const renameFolder = (folderId, name) => mutate(prev => ({ ...prev, folders: prev.folders.map(f => f.id === folderId ? { ...f, name } : f) }));
  const deleteFolder = (folderId) => mutate(prev => {
    const topPositions = prev.items.filter(i => i.folder_id === null).map(i => i.position);
    let nextPos = topPositions.length ? Math.max(...topPositions) + 1 : 0;
    return {
      ...prev,
      folders: prev.folders.filter(f => f.id !== folderId),
      items: prev.items.map(i => i.folder_id === folderId ? { ...i, folder_id: null, position: nextPos++ } : i),
    };
  });
  const moveItemUpDown = (itemId, folderId, dir) => mutate(prev => {
    const siblings = prev.items.filter(i => i.folder_id === folderId).sort((a, b) => a.position - b.position);
    const idx = siblings.findIndex(i => i.item_id === itemId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return prev;
    const a = siblings[idx], b = siblings[swapIdx];
    return {
      ...prev,
      items: prev.items.map(i => {
        if (i.item_id === a.item_id && i.folder_id === folderId) return { ...i, position: b.position };
        if (i.item_id === b.item_id && i.folder_id === folderId) return { ...i, position: a.position };
        return i;
      }),
    };
  });
  const moveFolderUpDown = (folderId, dir) => mutate(prev => {
    const sorted = [...prev.folders].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex(f => f.id === folderId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return prev;
    const a = sorted[idx], b = sorted[swapIdx];
    return {
      ...prev,
      folders: prev.folders.map(f => {
        if (f.id === a.id) return { ...f, position: b.position };
        if (f.id === b.id) return { ...f, position: a.position };
        return f;
      }),
    };
  });

  const itemDragProps = (itemId) => ({
    onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; setDragKind('item'); setDragId(itemId); },
    onDragEnd: () => { setDragKind(null); setDragId(null); },
  });
  const folderDragProps = (folderId) => ({
    onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; setDragKind('folder'); setDragId(folderId); },
    onDragEnd: () => { setDragKind(null); setDragId(null); },
  });
  const topItemDropProps = (targetItemId) => ({
    onDragOver: (e) => { if (dragKind === 'item') e.preventDefault(); },
    onDrop: (e) => {
      e.preventDefault();
      if (dragKind !== 'item' || dragId === targetItemId) return;
      const ids = topItems.map(i => i.item_id).filter(id => id !== dragId);
      const idx = ids.indexOf(targetItemId);
      ids.splice(idx, 0, dragId);
      reorderTopLevel(ids);
    },
  });
  const folderDropProps = (targetFolderId) => ({
    onDragOver: (e) => { if (dragKind) e.preventDefault(); },
    onDrop: (e) => {
      e.preventDefault();
      if (dragKind === 'item') { moveToFolder(dragId, targetFolderId); return; }
      if (dragKind === 'folder' && dragId !== targetFolderId) {
        const ids = folders.map(f => f.id).filter(id => id !== dragId);
        const idx = ids.indexOf(targetFolderId);
        ids.splice(idx, 0, dragId);
        reorderFolders(ids);
      }
    },
  });

  const openFolder = folders.find(f => f.id === openFolderId) || null;

  return (
    <>
      <AppGrid>
        {folders.map((f, i) => (
          <FolderTile
            key={f.id} folder={f}
            memberLinks={folderMembers(f.id).map(e => itemsById.get(e.item_id)).filter(Boolean)}
            onOpen={() => setOpenFolderId(f.id)}
            dragHandleProps={folderDragProps(f.id)}
            dropProps={folderDropProps(f.id)}
            moveControls={{
              canMoveUp: i > 0, canMoveDown: i < folders.length - 1,
              onMoveUp: () => moveFolderUpDown(f.id, -1), onMoveDown: () => moveFolderUpDown(f.id, 1),
            }}
          />
        ))}
        {topItems.map((entry, i) => {
          const link = itemsById.get(entry.item_id);
          return (
            <AppTile
              key={entry.item_id} link={link} color={colorFor(link.category)}
              canManage={canManage} canDelete={canDelete}
              isFavorite={favorites.includes(link.id)} onToggleFavorite={() => onToggleFavorite(link.id)}
              onOpen={() => onOpen(link)} onEdit={() => onEdit(link)} onDelete={() => onDelete(link)}
              dragHandleProps={itemDragProps(entry.item_id)}
              dropProps={topItemDropProps(entry.item_id)}
              moveControls={{
                canMoveUp: i > 0, canMoveDown: i < topItems.length - 1,
                onMoveUp: () => moveItemUpDown(entry.item_id, null, -1), onMoveDown: () => moveItemUpDown(entry.item_id, null, 1),
                extra: (
                  <FolderPicker
                    folders={folders} currentFolderId={null}
                    onMove={(destId) => moveToFolder(entry.item_id, destId)}
                    onCreateNew={() => createFolderWithItem(entry.item_id)}
                  />
                ),
              }}
            />
          );
        })}
        <AddAppTile label="New Folder" onClick={createEmptyFolder} />
      </AppGrid>

      {openFolder && (
        <FolderModal
          folder={openFolder}
          memberEntries={folderMembers(openFolder.id)}
          itemsById={itemsById}
          canManage={canManage} canDelete={canDelete}
          favorites={favorites} onToggleFavorite={onToggleFavorite}
          onOpen={onOpen} onEdit={onEdit} onDelete={onDelete}
          onClose={() => setOpenFolderId(null)}
          onRename={(name) => renameFolder(openFolder.id, name)}
          onDeleteFolder={() => {
            if (!window.confirm(`Delete "${openFolder.name}"? Apps inside will move back to the main view.`)) return;
            deleteFolder(openFolder.id);
            setOpenFolderId(null);
          }}
          onReorderWithin={(fromIdx, toIdx) => {
            const members = folderMembers(openFolder.id);
            if (toIdx < 0 || toIdx >= members.length) return;
            const ids = members.map(e => e.item_id);
            const [moved] = ids.splice(fromIdx, 1);
            ids.splice(toIdx, 0, moved);
            reorderWithinFolder(openFolder.id, ids);
          }}
          onMoveOut={(itemId, destId) => moveToFolder(itemId, destId)}
          allFolders={folders}
          onCreateFolder={(itemId) => createFolderWithItem(itemId)}
        />
      )}
    </>
  );
}

function LinkList({ view, items, canManage, canDelete, favorites, onToggleFavorite, onOpen, onEdit, onDelete }) {
  if (view === 'list') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(l => (
          <LinkListRow key={l.id} link={l} canManage={canManage} canDelete={canDelete}
            isFavorite={favorites.includes(l.id)} onToggleFavorite={() => onToggleFavorite(l.id)}
            onOpen={() => onOpen(l)} onEdit={() => onEdit(l)} onDelete={() => onDelete(l)} />
        ))}
      </div>
    );
  }
  return (
    <AppGrid>
      {items.map(l => (
        <AppTile key={l.id} link={l} color={colorFor(l.category)} canManage={canManage} canDelete={canDelete}
          isFavorite={favorites.includes(l.id)} onToggleFavorite={() => onToggleFavorite(l.id)}
          onOpen={() => onOpen(l)} onEdit={() => onEdit(l)} onDelete={() => onDelete(l)} />
      ))}
    </AppGrid>
  );
}

function LinkListRow({ link, canManage, canDelete, isFavorite, onToggleFavorite, onOpen, onEdit, onDelete }) {
  const { fg, bg } = colorFor(link.category);
  return (
    <div
      className="card" onClick={onOpen} title={link.description || undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer',
        boxShadow: 'none', border: '1px solid var(--wk-line2)', borderRadius: 10,
      }}
    >
      <LinkIcon url={link.url} iconKey={link.icon} size={32} iconSize={16} radius={8} fg={fg} bg={bg} gradient={false} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link.name}</span>
        {link.is_pinned && <Star size={11} style={{ color: 'hsl(var(--color-gold))', flexShrink: 0 }} fill="hsl(var(--color-gold))" />}
      </div>
      {!isPlaceholderCategory(link.category) && (
        <span style={{ fontSize: 10.5, fontWeight: 600, color: fg, background: bg, padding: '2px 8px', borderRadius: 20, flexShrink: 0 }}>{link.category}</span>
      )}
      <span style={{ fontSize: 11.5, color: 'var(--muted)', width: 60, flexShrink: 0, textAlign: 'right' }}>{link.clicks || 0} uses</span>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
        <IconBtn onClick={onToggleFavorite} title={isFavorite ? 'Remove from My Favorites' : 'Add to My Favorites'}>
          <Bookmark size={13} fill={isFavorite ? 'hsl(var(--color-blue))' : 'none'} style={{ color: isFavorite ? 'hsl(var(--color-blue))' : 'var(--muted)' }} />
        </IconBtn>
        {canManage && <IconBtn onClick={onEdit} title="Edit link"><Pencil size={13} /></IconBtn>}
        {canManage && canDelete && <IconBtn onClick={onDelete} title="Delete link" danger><Trash2 size={13} /></IconBtn>}
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
function ManageModal({ links, onClose, onAdd, onAddForDept, onEdit, onDelete, canDelete, onReorder, onImported, companyName }) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [showImport, setShowImport] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dropCategory, setDropCategory] = useState(null);
  const [deptPick, setDeptPick] = useState('');

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
  const emptyDepartments = useMemo(() => DEPARTMENTS.filter(d => !links.some(l => l.department === d)), [links]);
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
        </div>

        <div style={{ padding: '14px 24px 0', display: 'flex', gap: 10 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input className="form-input" style={{ paddingLeft: 32 }} placeholder="Search links..." value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <button className="secondary-btn" onClick={() => setShowImport(true)}><Upload size={14} /> Import</button>
          <button className="primary-btn" onClick={onAdd}><Plus size={15} /> Add Link</button>
        </div>

        <div style={{ padding: '16px 24px 20px', maxHeight: '60vh', overflowY: 'auto' }}>
          {tab === 'all' ? (
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

// Cmd/Ctrl+K spotlight - fuzzy-ish search across every link (ignores the
// department/category/search filters on the page) with arrow-key navigation
// and Enter-to-launch, the pattern from Okta's dashboard search, Linear, and
// Raycast. Opens on the most-used links when the query is empty so it also
// works as a "what do I usually reach for" jump list.
function CommandPalette({ links, onOpen, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle
      ? links.filter(l => [l.name, l.category, l.department, l.description].some(v => (v || '').toLowerCase().includes(needle)))
      : [...links].sort((a, b) => (b.clicks || 0) - (a.clicks || 0));
    return pool.slice(0, 8);
  }, [links, query]);

  useEffect(() => { setActive(0); }, [query]);

  const launch = (link) => { onOpen(link); onClose(); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) launch(results[active]); }
    else if (e.key === 'Escape') { onClose(); }
  };

  return (
    <div className="modal-overlay" style={{ alignItems: 'flex-start', paddingTop: '12vh' }} onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <Search size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          <input
            autoFocus value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Jump to an app, tool, or bank..."
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 15, color: 'var(--ink)' }}
          />
          <kbd style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--mist)', padding: '2px 6px', borderRadius: 5 }}>ESC</kbd>
        </div>
        {!query.trim() && (
          <div style={{ padding: '8px 18px 0', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            Most Used
          </div>
        )}
        <div style={{ maxHeight: '50vh', overflowY: 'auto', padding: 6 }}>
          {results.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: '24px 0' }}>No matches for "{query}".</p>
          ) : results.map((l, i) => {
            const { fg, bg } = colorFor(l.category);
            return (
              <div
                key={l.id} onMouseEnter={() => setActive(i)} onClick={() => launch(l)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 9, cursor: 'pointer',
                  background: i === active ? 'var(--wk-brand-tint)' : 'transparent',
                }}
              >
                <LinkIcon url={l.url} iconKey={l.icon} size={30} iconSize={15} radius={8} fg={fg} bg={bg} gradient={false} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{l.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{l.category}{l.department ? ` · ${l.department}` : ''}</div>
                </div>
                {i === active && <CornerDownLeft size={13} style={{ color: 'var(--wk-brand)', flexShrink: 0 }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
