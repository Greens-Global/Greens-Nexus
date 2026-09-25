import { useState, useEffect, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useMsal } from '@azure/msal-react';
import {
  ArrowRight, ArrowUpRight, BookOpen, CheckSquare, ChevronRight, ListTodo, Package, ShieldCheck, Bell, Clock, StickyNote,
  BarChart3, Layers, Zap, Users, ClipboardCheck, CalendarClock, ExternalLink, Boxes, X,
  ClipboardList, HandCoins, TrendingUp, Building2, FolderKanban, CalendarDays, Timer,
  CheckCheck, Trash2, Mail, CalendarPlus, FolderOpen, LayoutGrid,
  Bookmark, Plus, Link2, Lock,
  PenLine, Contact, ShoppingCart, Cake,
  Ticket as TicketIcon,
} from 'lucide-react';
import { formatTime } from '../lib/datetime';
import { api } from '../api';
import { LinkIcon } from '../components/LinkIcon.jsx';
import { useNotifications } from '../contexts/NotificationContext.jsx';
import { useRole } from '../contexts/RoleContext';
import { readIds, pushRecentId } from '../links/shortcutStorage';
import { looksLikeUrl } from '../links/personalLinkModal.jsx';

// Heavy panels (ported from the old Overview / Team Analytics screens) load
// lazily so TimeAdmin & the approval flows stay out of the main bundle.
const lazyPanel = (name) => lazy(() => import('./panels.jsx').then(m => ({ default: m[name] })));

// Quick-action composers (Outlook mail/event + the Tasks module's create modal)
// - one lazy chunk, pulled in only when a "do" action is actually clicked.
const QuickActionModal = lazy(() => import('./QuickActionModals.jsx'));

const ApprovalsPanel    = lazyPanel('ApprovalsPanel');
const WhoHasWhatPanel   = lazyPanel('WhoHasWhatPanel');
const TeamTimePanel     = lazyPanel('TeamTimePanel');
const OccupancyPanel    = lazyPanel('OccupancyPanel');
const FacilitiesPanel   = lazyPanel('FacilitiesPanel');
const TasksPanel        = lazyPanel('TasksPanel');
const WorkloadPanel     = lazyPanel('WorkloadPanel');
const ProjectsPanel     = lazyPanel('ProjectsPanel');
const TeamCalendarPanel = lazyPanel('TeamCalendarPanel');
const CalendarPanel     = lazyPanel('CalendarPanel');

// Workday tiles (phase 2, Sep 24) - own lazy chunk, same idea as panels.jsx.
const lazyWorkday = (name) => lazy(() => import('./workdayWidgets.jsx').then(m => ({ default: m[name] })));
const TimeClockWidget  = lazyWorkday('TimeClockWidget');
const MyRequestsWidget = lazyWorkday('MyRequestsWidget');
const DueBackWidget    = lazyWorkday('DueBackWidget');
const ComingUpWidget   = lazyWorkday('ComingUpWidget');

// Fire the app's cross-view navigation event (see CLAUDE.md).
export function navigate(view, sub) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub || null } }));
}

const C = (name) => `hsl(var(--color-${name}))`;

// Every KPI the /dashboards/kpis endpoint can return, with how to present it.
export const KPI_CATALOG = {
  open_tasks:           { label: 'Open Tasks',              color: 'blue',   Icon: ListTodo,      hint: 'Across your team',     nav: { view: 'tasks' } },
  my_open_tasks:        { label: 'My Open Tasks',           color: 'blue',   Icon: ListTodo,      hint: 'Assigned to you',      nav: { view: 'tasks' } },
  pending_requisitions: { label: 'Requisitions to Approve', color: 'orange', Icon: ClipboardCheck, hint: 'Awaiting approval',   nav: { view: 'dashboard' } },
  pending_inventory:    { label: 'Inventory Requests',      color: 'orange', Icon: Package,       hint: 'Awaiting approval',    nav: { view: 'dashboard' } },
  open_purchases:       { label: 'Open Purchases',          color: 'purple', Icon: Package,       hint: 'In progress',          nav: { view: 'purchase' } },
  my_checkouts:         { label: 'My Active Checkouts',     color: 'green',  Icon: Boxes,         hint: 'Currently with you',   nav: { view: 'inventory', sub: 'checkouts' } },
  my_assignments:       { label: 'Items Assigned to Me',    color: 'green',  Icon: Package,       hint: 'Your equipment',       nav: { view: 'inventory' } },
  unread_notifications: { label: 'Unread Notifications',    color: 'blue',   Icon: Bell,          hint: 'Tap to review' },
  signatures_needed:    { label: 'Signatures Needed',       color: 'green',  Icon: PenLine,       hint: 'Waiting on you',       nav: { view: 'myhr' } },
  warranties_expiring:  { label: 'Warranties Expiring',     color: 'red',    Icon: ShieldCheck,   hint: 'Within 60 days',       nav: { view: 'property-asset' } },
  open_tickets:         { label: 'Open Tickets',            color: 'red',    Icon: TicketIcon,    hint: 'Across the team',      nav: { view: 'tickets' } },
  // Manager Dashboard folded into the one Dashboard (Sep 3) - these KPI tiles
  // now just go Home, where the underlying Team widgets actually live.
  clocked_in_now:       { label: 'Clocked In Now',          color: 'green',  Icon: Users,         hint: 'On the clock now',     nav: { view: 'dashboard' } },
  time_off_pending:     { label: 'Time Off to Review',      color: 'orange', Icon: CalendarClock, hint: 'Awaiting your review',  nav: { view: 'dashboard' } },
};

// Curated shortcut destinations for the picker (module + optional sub-screen).
export const SHORTCUT_TARGETS = [
  { view: 'timeclock',        label: 'Time Clock' },
  { view: 'myhr',             label: 'Workday' },
  { view: 'tasks',            label: 'Tasks' },
  { view: 'inventory',        label: 'Item Management' },
  { view: 'inventory', sub: 'catalog',   label: 'Item Management · Browse catalog' },
  { view: 'inventory', sub: 'checkouts', label: 'Item Management · Checkouts' },
  { view: 'purchase',         label: 'Purchase Requests' },
  { view: 'property-asset',   label: 'Asset Management' },
  { view: 'sop',              label: 'Knowledge Base' },
  { view: 'hr',               label: 'HR' },
  { view: 'accounting',       label: 'Accounting' },
  { view: 'operations',       label: 'Operations' },
  { view: 'development',      label: 'Development' },
  { view: 'ops',              label: 'Construction' },
  { view: 'external-links',   label: 'Links' },
  { view: 'support',          label: 'Support' },
];

const labelFor = (t) => SHORTCUT_TARGETS.find(s => s.view === t.view && (s.sub || '') === (t.sub || ''))?.label
  || t.label || t.view;

// ── Native card shells (match the Overview screen exactly) ────────────────────
export function DashCard({ title, sub, action, children, onClick, style }) {
  return (
    <div className="dash-card" onClick={onClick}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', cursor: onClick ? 'pointer' : 'default', ...style }}>
      {(title || action) && (
        <div className="dash-card-head" style={{ marginBottom: 12 }}>
          <div>
            {title && <div className="dash-card-title">{title}</div>}
            {sub && <div className="dash-card-sub">{sub}</div>}
          </div>
          {action}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
    </div>
  );
}

// Stat tile - the DeskHome dk-stat anatomy (tinted icon chip top-left, hover
// arrow top-right, big tabular numeral) so Home and the custom grid read as
// ONE design world. The old corner watercolor blob is gone on purpose.
function StatCard({ label, value, color, Icon, nav, hint, hero, onClick }) {
  const go = onClick || (() => nav && navigate(nav.view, nav.sub));
  const clickable = !!(onClick || nav);
  const I = Icon || BarChart3;
  return (
    <div className={`dk-stat${hero ? ' dk-stat--hero' : ''}`} onClick={clickable ? go : undefined} role={clickable ? 'button' : undefined}
      style={{ height: '100%', boxSizing: 'border-box', cursor: clickable ? 'pointer' : 'default', justifyContent: 'center' }}>
      <span className="dk-stat-top">
        <span className={`dk-chip dk-chip--${color}`}><I /></span>
        {clickable && <ArrowUpRight size={15} className="dk-stat-arrow" />}
      </span>
      <span className="dk-stat-num">{value}</span>
      <span className="dk-stat-label">{label}</span>
      {hint && <span className="dk-stat-sub">{hint}</span>}
    </div>
  );
}

// ── Widgets ───────────────────────────────────────────────────────────────────
function KpiWidget({ config, kpis }) {
  const { openPanel } = useNotifications();
  const meta = KPI_CATALOG[config?.metric] || { label: 'Metric', color: 'blue', Icon: BarChart3 };
  const onClick = config?.metric === 'unread_notifications' ? openPanel : undefined;
  return <StatCard label={meta.label} value={kpis?.[config?.metric] ?? 0} color={meta.color} Icon={meta.Icon} nav={meta.nav} hint={meta.hint} hero={!!config?.hero} onClick={onClick} />;
}

function TeamStatWidget({ config, kpis }) {
  const { openPanel } = useNotifications();
  const meta = KPI_CATALOG[config?.metric] || { label: config?.metric, color: 'green', Icon: Users };
  const onClick = config?.metric === 'unread_notifications' ? openPanel : undefined;
  return <StatCard label={meta.label} value={kpis?.[config?.metric] ?? 0} color={meta.color} Icon={meta.Icon} nav={meta.nav} hint={meta.hint} onClick={onClick} />;
}

function KpiBarWidget({ config, kpis }) {
  const { openPanel } = useNotifications();
  const metrics = config?.metrics?.length ? config.metrics
    : ['open_tasks', 'pending_requisitions', 'my_checkouts', 'warranties_expiring'];
  const rows = metrics.map(m => ({ m, v: kpis?.[m] ?? 0, meta: KPI_CATALOG[m] || { label: m, color: 'blue' } }));
  const max = Math.max(1, ...rows.map(r => r.v));
  const clickFor = (r) => r.m === 'unread_notifications' ? openPanel : (r.meta.nav && (() => navigate(r.meta.nav.view, r.meta.nav.sub)));
  return (
    <DashCard title="At a Glance">
      {/* Top-aligned, natural height - height:100% + justify center inside the
          card's scroll container CLIPPED the first rows whenever content ran
          taller than the card (flexbox centers overflow off the top, where
          scrolling can't reach). Same fix in Quick Actions. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map(r => {
          const onClick = clickFor(r);
          return (
          <div key={r.m} onClick={onClick || undefined} style={{ cursor: onClick ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
              <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{r.meta.label}</span>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{r.v}</strong>
            </div>
            <div style={{ height: 7, background: 'var(--mist)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ width: `${(r.v / max) * 100}%`, height: '100%', background: C(r.meta.color), borderRadius: 99 }} />
            </div>
          </div>
          );
        })}
      </div>
    </DashCard>
  );
}

function ShortcutWidget({ config }) {
  const t = config || SHORTCUT_TARGETS[0];
  const color = t.color || 'blue';
  return (
    <div className="dash-card" onClick={() => navigate(t.view, t.sub)}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 9, textAlign: 'center', cursor: 'pointer' }}>
      <span className={`dk-chip dk-chip--${color}`} style={{ width: 44, height: 44, borderRadius: 12 }}>
        <Layers size={20} />
      </span>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--wk-ink)' }}>{labelFor(t)}</div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--wk-brand)', fontSize: 12.5, fontWeight: 600 }}>Open <ArrowRight size={12} /></div>
    </div>
  );
}

function LinkRow({ t, onClick }) {
  return (
    <button onClick={onClick} className="dash-link-row"
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 8px', border: 'none', background: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontSize: 13.5, color: 'var(--ink)', fontFamily: 'var(--wk-font)', width: '100%' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
      <ArrowRight size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} /> {labelFor(t)}
    </button>
  );
}

function LinksWidget({ config }) {
  const items = config?.items?.length ? config.items : SHORTCUT_TARGETS.slice(0, 6);
  return (
    <DashCard title={config?.title || 'Quick Links'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {items.map((t, i) => <LinkRow key={i} t={t} onClick={() => navigate(t.view, t.sub)} />)}
      </div>
    </DashCard>
  );
}

// Same accent-color scheme External Links uses (colorFor/PERSONAL_COLOR in
// ExternalLinks.jsx) - not shared as an import since it's three lines of
// pure hashing, cheaper to duplicate than to couple this file to that
// view's module. Company gets a stable per-category tone; Personal gets one
// flat purple, matching that view's own Personal badge color exactly.
const LINK_TILE_PALETTE = ['blue', 'green', 'orange', 'purple', 'red', 'gold'];
function hashLinkStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function colorForLinkCategory(category) {
  const tone = LINK_TILE_PALETTE[hashLinkStr(category || '') % LINK_TILE_PALETTE.length];
  return { fg: `hsl(var(--color-${tone}))`, bg: `hsla(var(--color-${tone}),0.12)` };
}
const PERSONAL_TILE_COLOR = { fg: 'hsl(var(--color-purple))', bg: 'hsla(var(--color-purple),0.12)' };

// Reuses External Links' own .app-grid/.app-tile CSS and real-favicon
// LinkIcon (Aug 14, "i want the same folder style in dashboard as we have
// in external links") rather than a plain text list, so a folder looks
// identical whether it's opened from External Links or from this widget -
// just the hover actions (favorite/drag/move-to-folder) are left out, since
// none of those make sense on a small fixed dashboard tile.
function LinksFolderTile({ link, color, onOpen, style }) {
  return (
    <div
      className="app-tile" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title={link.name} style={style}
    >
      <div className="app-tile-icon-wrap">
        <LinkIcon url={link.url} iconKey={link.icon} size={48} radius={13} fg={color.fg} bg={color.bg} />
      </div>
      <span className="app-tile-name">{link.name}</span>
    </div>
  );
}

// Shows the live contents of one of the user's own External Links folders
// (Company or Personal - see PersonalLinksSection/LinksLayoutSection in
// ExternalLinks.jsx, Aug 14 - "add a option external links where i can see
// all my folders... so i can directly add as a customization in my
// dashboard"). Fetches independently on mount rather than sharing state
// with the External Links view - a dashboard widget has no guarantee that
// view has ever been opened this session. Folder membership always comes
// from the live layout document, never frozen into config, so renaming/
// reordering/deleting apps in the folder from External Links shows up here
// without re-configuring the widget - only which folder is shown is fixed
// config, not its contents.
// Every app in the folder, opened from the "All Apps" tile (Aug 14 -
// "when we add widget in dashboard, i need to have all apps icon so when i
// click on all apps it opens me all the apps in that folder") - same
// modal-overlay/modal-content chrome the rest of the app uses, reusing
// LinksFolderTile so it's visually identical to the widget's own preview
// tiles and to External Links' own folder popup. 60vw width + a single
// horizontally-scrolling row instead of a wrapping grid (Aug 15 - "opening
// the folder... it should open horizontally, and the popup should use 60%
// of screen"), matching every other popup's width convention in this app.
// Portaled straight to document.body (Aug 15, "when i click on the folder
// present on dashboard, my screen starts flickering") - this modal was
// mounted deep inside the widget's own DashCard, which scrolls its own
// content (`overflow: auto`, see DashCard below); a `position: fixed`
// overlay born that deep in a scrolling ancestor tree would render at the
// wrong size/position for a frame before the browser settled it to the
// real viewport, which is what read as a flicker/jump on open. Portaling
// makes it a direct child of body, same as it should have been the whole
// session - no other modal in this app is nested this deep, which is why
// this is the only one that showed it.
function LinksFolderAllModal({ title, links, itemType, colorFor, onOpen, onClose }) {
  return createPortal((
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '60vw', maxWidth: '60vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="close-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <div className="scroll-tabs" style={{ display: 'flex', flexWrap: 'nowrap', gap: 14, overflowX: 'auto', paddingBottom: 4 }}>
            {links.map(l => (
              <div key={l._uid || l.id} style={{ flexShrink: 0 }}>
                <LinksFolderTile link={l} onOpen={() => onOpen(l)}
                  color={colorFor ? colorFor(l) : itemType === 'personal' ? PERSONAL_TILE_COLOR : colorForLinkCategory(l.category)} />
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="primary-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  ), document.body);
}

// Only a handful of tiles preview in the widget itself (Aug 14 - replaces
// the old scroll-arrows grid, which cramped a tiny scrollbar into a
// dashboard tile) - "All Apps" opens the full list in LinksFolderAllModal
// above instead. PREVIEW_COUNT leaves room for the All Apps tile itself in
// a typical 3-4 column widget width.
const LINKS_FOLDER_PREVIEW_COUNT = 3;

function LinksFolderWidget({ config }) {
  const [state, setState] = useState({ loading: true, folder: null, links: [] });
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!config?.folderId) { setState({ loading: false, folder: null, links: [] }); return undefined; }
    const itemType = config.itemType === 'personal' ? 'personal' : 'external';
    Promise.all([
      api.getLinkLayout(),
      itemType === 'personal' ? api.getPersonalLinks() : api.getExternalLinks(),
    ]).then(([layout, allLinks]) => {
      if (!alive) return;
      const folder = (layout?.folders || []).find(f => f.id === config.folderId) || null;
      const byId = new Map((allLinks || []).map(l => [l.id, l]));
      const links = (layout?.items || [])
        .filter(i => i.folder_id === config.folderId && i.item_type === itemType)
        .sort((a, b) => a.position - b.position)
        .map(i => byId.get(i.item_id))
        .filter(Boolean);
      setState({ loading: false, folder, links });
    }).catch(() => { if (alive) setState({ loading: false, folder: null, links: [] }); });
    return () => { alive = false; };
  }, [config?.folderId, config?.itemType]);

  const open = (link) => {
    window.open(link.url, '_blank', 'noopener,noreferrer');
    (config.itemType === 'personal' ? api.clickPersonalLink : api.clickExternalLink)(link.id).catch(() => {});
  };

  if (!config?.folderId) {
    return (
      <DashCard title="Links Folder">
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '24px 8px', textAlign: 'center', lineHeight: 1.5 }}>
          No folder picked yet - use the pencil to edit this tile and choose one.
        </div>
      </DashCard>
    );
  }

  const title = state.folder?.name || config.folderName || 'Links Folder';
  return (
    <DashCard title={title} sub={config.itemType === 'personal' ? 'Personal' : 'Company'}
      action={<FolderOpen size={15} style={{ color: 'var(--muted)' }} />}>
      {state.loading ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '24px 4px', textAlign: 'center' }}>Loading…</div>
      ) : !state.folder ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '24px 8px', textAlign: 'center', lineHeight: 1.5 }}>
          This folder no longer exists - edit this tile to pick a different one.
        </div>
      ) : state.links.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '24px 4px', textAlign: 'center' }}>This folder is empty.</div>
      ) : (
        // Grid (not the shared .app-grid flex-wrap) so a handful of tiles
        // stretch to fill the card's full width instead of hugging the left
        // edge and leaving the rest of the tile blank (Aug 18 - "it is not
        // using in full folder area"). .app-tile's fixed 86px width is
        // overridden per-tile below so each one grows to its grid cell.
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: '14px 10px' }}>
          {state.links.slice(0, LINKS_FOLDER_PREVIEW_COUNT).map(l => (
            <LinksFolderTile key={l.id} link={l} onOpen={() => open(l)} style={{ width: '100%' }}
              color={config.itemType === 'personal' ? PERSONAL_TILE_COLOR : colorForLinkCategory(l.category)} />
          ))}
          <div className="app-tile" onClick={() => setShowAll(true)} role="button" tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAll(true); } }}
            title={`See all ${state.links.length} apps in ${title}`} style={{ width: '100%' }}>
            <div className="app-tile-icon-wrap">
              <div style={{
                width: 48, height: 48, borderRadius: 13, background: 'var(--mist)', color: 'var(--muted)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <LayoutGrid size={20} />
              </div>
            </div>
            <span className="app-tile-name">All Apps</span>
          </div>
        </div>
      )}
      {showAll && (
        <LinksFolderAllModal title={title} links={state.links} itemType={config.itemType}
          onOpen={open} onClose={() => setShowAll(false)} />
      )}
    </DashCard>
  );
}

// ── Favorites / My Personal Links widgets (Sep 24) ───────────────────────────
// Both reuse the Links Folder tile and its "All" popup above, so a link looks
// the same whether it's opened from the Links tab or from the dashboard.

const noteStyle = { fontSize: 12.5, color: 'var(--muted)', padding: '24px 8px', textAlign: 'center', lineHeight: 1.5 };
const tileGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: '14px 10px' };

// Open a link in a new tab and record the click the same way the Links tab
// does: the per-type click counter on the server and, for Company Links, the
// per-browser Recently Used trail - so the dashboard and Links stay in step.
function openLinkTile(link, type, myEmail) {
  window.open(link.url, '_blank', 'noopener,noreferrer');
  if (type === 'personal') { api.clickPersonalLink(link.id).catch(() => {}); return; }
  api.clickExternalLink(link.id).catch(() => {});
  pushRecentId(myEmail, link.id);
}

// A few preview tiles, then one "All" tile when the list doesn't fit - same
// rule as the Links Folder widget, except a list that is only one tile over
// the preview count shows everything (an "All" tile hiding a single link is
// silly). `trailing` is an extra tile (the Add tile) rendered after the list.
function LinkTileGrid({ links, colorFor, onOpen, onShowAll, allLabel, trailing }) {
  const overflow = links.length > LINKS_FOLDER_PREVIEW_COUNT + 1;
  const shown = overflow ? links.slice(0, LINKS_FOLDER_PREVIEW_COUNT) : links;
  return (
    <div style={tileGridStyle}>
      {shown.map(l => (
        <LinksFolderTile key={l._uid || l.id} link={l} onOpen={() => onOpen(l)} style={{ width: '100%' }} color={colorFor(l)} />
      ))}
      {overflow && (
        <div className="app-tile" onClick={onShowAll} role="button" tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShowAll(); } }}
          title={`See all ${links.length}`} style={{ width: '100%' }}>
          <div className="app-tile-icon-wrap">
            <div style={{ width: 48, height: 48, borderRadius: 13, background: 'var(--mist)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <LayoutGrid size={20} />
            </div>
          </div>
          <span className="app-tile-name">{allLabel}</span>
        </div>
      )}
      {trailing}
    </div>
  );
}

// Flat text tabs with a thin rule under the active one (no pill chips).
const tabStyle = (on) => ({
  border: 'none', background: 'none', padding: '0 0 3px', cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 12, fontWeight: 600, color: on ? 'var(--ink)' : 'var(--muted)',
  borderBottom: `2px solid ${on ? 'var(--wk-brand)' : 'transparent'}`,
});

// The Links tab's bookmarks, live from the saved Link View (backend-persisted,
// so they follow the account), with a Recently Used tab reading the same
// per-browser trail the Links tab keeps (shortcutStorage.js). The tab choice
// is session-local on purpose: persisting it through updateConfig would mark
// the saved layout dirty and trip the "discard layout changes?" confirm on
// the next view switch (see confirmDiscard in CustomDashboard) for what is
// only a way of looking, not an arrangement.
function FavoritesWidget() {
  const { myEmail } = useRole();
  const [mode, setMode] = useState('favorites'); // 'favorites' | 'recents'
  const [state, setState] = useState({ loading: true, favorites: [], company: [] });
  const [recentIds, setRecentIds] = useState(() => readIds(myEmail, 'recents'));
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([api.getLinkLayout(), api.getExternalLinks(), api.getPersonalLinks().catch(() => [])])
      .then(([layout, company, personal]) => {
        if (!alive) return;
        // A favorite can be a Company or a Personal Link - resolve against
        // whichever list matches its item_type; _uid keeps render keys
        // unique since the two tables' ids can collide.
        const favorites = (layout?.favorites || []).map(f => {
          const link = (f.item_type === 'personal' ? (personal || []) : (company || [])).find(l => l.id === f.item_id);
          return link ? { ...link, _uid: `${f.item_type}-${link.id}`, _favType: f.item_type } : null;
        }).filter(Boolean);
        setState({ loading: false, favorites, company: company || [] });
      })
      .catch(() => { if (alive) setState({ loading: false, favorites: [], company: [] }); });
    return () => { alive = false; };
  }, []);

  const recents = recentIds.map(id => state.company.find(l => l.id === id)).filter(Boolean);
  const links = mode === 'recents' ? recents : state.favorites;
  const colorFor = (l) => l._favType === 'personal' ? PERSONAL_TILE_COLOR : colorForLinkCategory(l.category);
  const open = (l) => {
    const type = l._favType === 'personal' ? 'personal' : 'external';
    openLinkTile(l, type, myEmail);
    if (type === 'external') setRecentIds(readIds(myEmail, 'recents'));
  };
  const title = mode === 'recents' ? 'Recently Used' : 'Favorites';
  const tabs = (
    <div style={{ display: 'inline-flex', gap: 12 }} role="tablist" aria-label="Show">
      <button type="button" role="tab" aria-selected={mode === 'favorites'} style={tabStyle(mode === 'favorites')} onClick={() => setMode('favorites')}>Favorites</button>
      <button type="button" role="tab" aria-selected={mode === 'recents'} style={tabStyle(mode === 'recents')} onClick={() => setMode('recents')}>Recent</button>
    </div>
  );
  return (
    <DashCard title={title} sub={mode === 'recents' ? 'Company links opened in this browser' : undefined} action={tabs}>
      {state.loading ? (
        <div style={noteStyle}>Loading…</div>
      ) : links.length === 0 ? (
        mode === 'recents' ? (
          <div style={noteStyle}>Nothing opened yet in this browser. Company links you open show up here.</div>
        ) : (
          <div style={noteStyle}>
            No favorites yet. Bookmark an app in Links and it shows up here.
            <div style={{ marginTop: 10 }}>
              <button type="button" className="secondary-btn" onClick={() => navigate('external-links')}>Open Links</button>
            </div>
          </div>
        )
      ) : (
        <LinkTileGrid links={links} colorFor={colorFor} onOpen={open} onShowAll={() => setShowAll(true)}
          allLabel={mode === 'recents' ? 'All Recent' : 'All Favorites'} />
      )}
      {showAll && (
        <LinksFolderAllModal title={title} links={links} colorFor={colorFor} onOpen={open} onClose={() => setShowAll(false)} />
      )}
    </DashCard>
  );
}

const sortPersonalLinks = (rows) => [...rows].sort((a, b) =>
  ((a.sort_order ?? 0) - (b.sort_order ?? 0)) || (a.name || '').localeCompare(b.name || ''));

// Every one of the user's own Personal Links, flat (no folders - that is what
// the Links Folder widget is for), plus an Add tile. Adding goes through the
// same PersonalLinkComposer the Quick Actions tile uses (one form, one dupe
// check - src/links/personalLinkModal.jsx), reached via the lazy
// QuickActionModal chunk so the dashboard bundle doesn't grow. Ctrl+V with a
// URL anywhere on the tile opens the composer prefilled - the same paste
// shortcut every upload widget in Nexus offers (CLAUDE.md).
function PersonalLinksWidget() {
  const { myEmail } = useRole();
  const [state, setState] = useState({ loading: true, links: [] });
  const [showAll, setShowAll] = useState(false);
  const [composer, setComposer] = useState(null); // { initialUrl }
  const [note, setNote] = useState('');
  useEffect(() => {
    let alive = true;
    api.getPersonalLinks()
      .then(p => { if (alive) setState({ loading: false, links: sortPersonalLinks(p || []) }); })
      .catch(() => { if (alive) setState({ loading: false, links: [] }); });
    return () => { alive = false; };
  }, []);
  const closeComposer = (res) => {
    setComposer(null);
    if (res?.created) setState(s => ({ ...s, links: sortPersonalLinks([...s.links, res.created]) }));
    if (res?.toast) { setNote(res.toast); setTimeout(() => setNote(''), 4000); }
  };
  const onPaste = (e) => {
    if (composer) return;
    const text = e.clipboardData?.getData('text') || '';
    if (looksLikeUrl(text)) { e.preventDefault(); setComposer({ initialUrl: text.trim() }); }
  };
  const open = (l) => openLinkTile(l, 'personal', myEmail);
  const addTile = (
    <button type="button" className="app-tile app-tile-add" style={{ width: '100%' }}
      onClick={() => setComposer({ initialUrl: '' })} title="Add a personal link - or press Ctrl+V with a URL">
      <div className="app-tile-add-icon"><Plus size={22} /></div>
      <span className="app-tile-name">Add Link</span>
    </button>
  );
  return (
    <div tabIndex={-1} onPaste={onPaste} style={{ height: '100%', outline: 'none' }}>
      <DashCard title="My Personal Links" sub={note || 'Only visible to you'}
        action={<Lock size={15} style={{ color: 'var(--muted)' }} />}>
        {state.loading ? (
          <div style={noteStyle}>Loading…</div>
        ) : (
          <>
            <LinkTileGrid links={state.links} colorFor={() => PERSONAL_TILE_COLOR} onOpen={open}
              onShowAll={() => setShowAll(true)} allLabel="All Links" trailing={addTile} />
            <div style={{ fontSize: 11, color: 'var(--wk-faint)', marginTop: 12 }}>
              {state.links.length === 0 ? 'Your own day-to-day shortcuts - add one, or press Ctrl+V with a URL.' : 'Or press Ctrl+V with a URL to add it here.'}
            </div>
          </>
        )}
        {showAll && (
          <LinksFolderAllModal title="My Personal Links" links={state.links} itemType="personal" onOpen={open} onClose={() => setShowAll(false)} />
        )}
        {composer && (
          <Suspense fallback={null}>
            <QuickActionModal kind="personal-link" initialUrl={composer.initialUrl} onClose={closeComposer} />
          </Suspense>
        )}
      </DashCard>
    </div>
  );
}

// Every quick action a tile can offer. `act` opens a composer that creates
// the thing in place (an Outlook mail/event via Graph, the Tasks module's own
// create modal, or the shared Personal Link form); `view` navigates to a
// screen the way this widget always has. Order here is the display order.
// A tile's config (`actions`: array of keys, picked in the gallery / pencil
// checklist - Sep 24, configurable like the KPI tile) chooses which ones it
// shows; tiles saved before that carry no config and keep the original six
// (DEFAULT_QUICK_ACTIONS), so nothing already placed changes.
export const QUICK_ACTIONS = [
  { key: 'task',          label: 'New Task',          act: 'task',          color: 'blue',   Icon: CheckSquare },
  { key: 'event',         label: 'New Event',         act: 'event',         color: 'purple', Icon: CalendarPlus },
  { key: 'email',         label: 'New Email',         act: 'email',         color: 'brand',  Icon: Mail },
  { key: 'personal-link', label: 'Add Personal Link', act: 'personal-link', color: 'purple', Icon: Link2 },
  { key: 'request-item',  label: 'Request an Item',   view: 'inventory', sub: 'catalog', color: 'orange', Icon: Package },
  { key: 'time-off',      label: 'Request Time Off',  view: 'timeclock', sub: 'timeoff',   color: 'orange', Icon: CalendarClock },
  { key: 'punch-fix',     label: 'Punch Correction',  view: 'timeclock', sub: 'timesheet', color: 'green',  Icon: Timer },
  { key: 'ask-hr',        label: 'Ask HR',            view: 'myhr',                        color: 'blue',   Icon: Contact },
  { key: 'purchase',      label: 'New Purchase Request', view: 'purchase',                 color: 'purple', Icon: ShoppingCart },
  { key: 'timeclock',     label: 'Time Clock',        view: 'timeclock',    color: 'green',  Icon: Clock },
  { key: 'kb',            label: 'Knowledge Base',    view: 'sop',          color: 'brand',  Icon: BookOpen },
];
export const DEFAULT_QUICK_ACTIONS = ['task', 'event', 'email', 'request-item', 'timeclock', 'kb'];
export function resolveQuickActions(config) {
  const keys = Array.isArray(config?.actions) && config.actions.length ? config.actions : DEFAULT_QUICK_ACTIONS;
  const picked = new Set(keys);
  return QUICK_ACTIONS.filter(a => picked.has(a.key));
}
function QuickActionsWidget({ config }) {
  const [modal, setModal] = useState(null);
  const [note, setNote] = useState('');
  // Composers report whether Graph sent it or Outlook took over, so the card
  // can say which actually happened instead of a blanket "Done".
  const close = (res) => {
    setModal(null);
    if (res?.toast) { setNote(res.toast); setTimeout(() => setNote(''), 4000); }
  };
  const actions = resolveQuickActions(config);
  // Same row anatomy as DeskHome's quick actions - icon chip, label, chevron.
  return (
    <DashCard title="Quick Actions" sub={note || undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {actions.map(a => (
          <button key={a.key} className="dk-key"
            onClick={() => a.act ? setModal(a.act) : navigate(a.view, a.sub)}>
            <span className={`dk-chip dk-chip--${a.color}`}><a.Icon /></span> {a.label}
            <ChevronRight size={14} className="dk-key-arrow" />
          </button>
        ))}
      </div>
      {modal && <Suspense fallback={null}><QuickActionModal kind={modal} onClose={close} /></Suspense>}
    </DashCard>
  );
}

// Rough importance ranking by notification type - mirrors the color coding
// used elsewhere (red = needs attention now, orange = action needed, blue =
// informational, green = resolved/FYI). Unknown types default to "informational"
// rather than sinking to the bottom, since new types show up before this map does.
const NOTIF_IMPORTANCE = {
  overdue: 3, kb_course_overdue: 3, rejected: 3, cancelled: 3, extension_declined: 3, req_rejected: 3, custom_alert: 3,
  inv_request: 2, req_pending: 2, checkout_pending: 2, allocate_request: 2, extension_pending: 2, req_fulfill: 2,
  kb_review_request: 2, perm_return: 2, kb_changes_requested: 2, kb_course_recert: 2,
  perm_assign: 1, kb_comment: 1, kb_course_assigned: 1, req_update: 1,
  approved: 0, allocated: 0, item_returned: 0, extension_resolved: 0, extension_approved: 0,
  req_approved: 0, perm_update: 0, kb_approved: 0,
};
const importanceOf = (n) => NOTIF_IMPORTANCE[n.type] ?? 1;

function NotificationsWidget({ notifications, markRead, markAllRead, dismiss, clearAll }) {
  // Unread first, then most-important type, then most recent - so the thing
  // that most needs your attention is always at the top of the list.
  const sorted = [...(notifications || [])].sort((a, b) => {
    if (!!a.read !== !!b.read) return a.read ? 1 : -1;
    const diff = importanceOf(b) - importanceOf(a);
    if (diff) return diff;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });
  const list = sorted.slice(0, 12);
  const unread = (notifications || []).filter(n => !n.read).length;
  return (
    <DashCard title="Notifications" sub={unread ? `${unread} unread` : 'All caught up'}
      action={list.length > 0 ? (
        <span style={{ display: 'inline-flex', gap: 12 }}>
          {unread > 0 && markAllRead && (
            <button onClick={markAllRead} className="link-btn" style={{ marginTop: 0 }}>
              <CheckCheck size={13} /> Mark All Read
            </button>
          )}
          {clearAll && (
            <button onClick={clearAll} className="link-btn" style={{ marginTop: 0, color: 'hsl(var(--color-red))' }}>
              <Trash2 size={13} /> Clear All
            </button>
          )}
        </span>
      ) : <Bell size={15} style={{ color: 'var(--muted)' }} />}>
      {list.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '24px 4px', textAlign: 'center' }}>You're all caught up.</div>
      ) : (
        <div>
          {list.map((n, i) => {
            const act = n.action || {};
            return (
              <div key={n.id || i} className="task-row"
                onClick={() => { if (!n.read && markRead) markRead(n.id); if (act.view) navigate(act.view, act.sub); }}
                style={{ cursor: 'pointer', alignItems: 'flex-start', gap: 8 }}>
                {/* unread dot */}
                <span style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 6, flexShrink: 0,
                  background: n.read ? 'transparent' : C('blue') }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="task-title" style={{ fontWeight: n.read ? 500 : 600, color: n.read ? 'var(--muted)' : 'var(--ink)' }}>{n.title || 'Notification'}</div>
                  {n.body && <div className="task-dept" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.body}</div>}
                </div>
                {dismiss && (
                  <button onClick={(e) => { e.stopPropagation(); dismiss(n.id); }} title="Clear"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 2, flexShrink: 0 }}>
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </DashCard>
  );
}

function NotesWidget({ config, updateConfig }) {
  const [text, setText] = useState(config?.text || '');
  useEffect(() => { setText(config?.text || ''); }, [config?.text]);
  return (
    <DashCard title="Notes" action={<StickyNote size={15} style={{ color: C('orange') }} />}>
      <textarea value={text} onChange={e => setText(e.target.value)} onBlur={() => updateConfig({ text })}
        placeholder="Jot something down…"
        style={{ width: '100%', height: '100%', minHeight: 60, resize: 'none', border: 'none', background: 'transparent', outline: 'none', fontFamily: 'var(--wk-font)', fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.6 }} />
    </DashCard>
  );
}

function ClockWidget() {
  const { accounts } = useMsal();
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000 * 20); return () => clearInterval(t); }, []);
  const hh = now.getHours();
  const greetWord = hh < 12 ? 'Good Morning' : hh < 17 ? 'Good Afternoon' : 'Good Evening';
  const displayName = accounts[0]?.name ?? accounts[0]?.username ?? '';
  const firstName = displayName.split(' ')[0];
  const greet = firstName ? `${greetWord}, ${firstName}` : greetWord;
  // The DeskHome greeting anatomy - name line, big tabular numeral, quiet date,
  // green session-language link - so this card reads as Home's hero in the grid.
  return (
    <div className="dash-card" onClick={() => navigate('timeclock')}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, cursor: 'pointer' }}>
      <div style={{ fontSize: 13.5, color: 'var(--wk-dim)', fontWeight: 600 }}>{greet}</div>
      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1.1, color: 'var(--wk-ink)', fontVariantNumeric: 'tabular-nums' }}>
        {formatTime(now)}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--wk-faint)' }}>{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--wk-green)', fontSize: 12.5, fontWeight: 600, marginTop: 9 }}>
        <Clock size={13} /> Open Time Clock <ArrowRight size={12} />
      </div>
    </div>
  );
}

// ── Registry ──────────────────────────────────────────────────────────────────
// One dashboard, every widget in one catalog - `minRole` is what's manager-only
// vs. everyone (Sep 3: Manager Dashboard used to be a second, fully separate
// board; Neil: "Dashboard is based on role... managers should get access to
// manager widgets," not a second board). CustomDashboard.jsx's canSeeWidget()
// gates both rendering an already-placed widget and offering it in the Add
// Widget gallery: role level OR the 'manager-dashboard' Access Group grant
// (supervisor+ widgets need `minRole: 'supervisor'`, stricter ones need
// `minRole: 'manager'` - the "Team" category below is the current manager-only
// set). limits bound how far each widget can be resized - enforced during drag
// AND re-applied to saved layouts on load, so a stat tile can never balloon.
const STAT_LIMITS = { minW: 2, minH: 2, maxW: 4, maxH: 3 };
export const WIDGETS = {
  kpi:           { title: 'KPI Stat',        cat: 'Metrics',   icon: BarChart3,    size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: KpiWidget,          configurable: 'kpi' },
  'kpi-bar':     { title: 'KPI Bar Chart',   cat: 'Metrics',   icon: BarChart3,    size: { w: 4, h: 3 }, limits: { minW: 3, minH: 3, maxW: 6, maxH: 5 }, render: KpiBarWidget },
  'time-clock':  { title: 'Time Clock',      cat: 'Workday',   icon: Clock,        size: { w: 3, h: 3 }, limits: { minW: 2, minH: 3, maxW: 4, maxH: 4 }, render: TimeClockWidget },
  'my-requests': { title: 'My Requests',     cat: 'Workday',   icon: ClipboardList, size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: MyRequestsWidget },
  'due-back':    { title: 'Due Back Soon',   cat: 'Workday',   icon: Boxes,        size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: DueBackWidget },
  'coming-up':   { title: 'Coming Up',       cat: 'Workday',   icon: Cake,         size: { w: 3, h: 3 }, limits: { minW: 2, minH: 2, maxW: 4, maxH: 5 }, render: ComingUpWidget },
  shortcut:      { title: 'Shortcut Tile',   cat: 'Navigation', icon: Layers,      size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: ShortcutWidget,     configurable: 'shortcut' },
  links:         { title: 'Quick Links',     cat: 'Links',     icon: ExternalLink, size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 4, maxH: 6 }, render: LinksWidget },
  'links-folder': { title: 'Links Folder',   cat: 'Links',     icon: FolderOpen,   size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 4, maxH: 6 }, render: LinksFolderWidget, configurable: 'links-folder' },
  favorites:     { title: 'Favorites',       cat: 'Links',     icon: Bookmark,     size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 6, maxH: 6 }, render: FavoritesWidget },
  'personal-links': { title: 'My Personal Links', cat: 'Links', icon: Link2,       size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 6, maxH: 6 }, render: PersonalLinksWidget },
  'quick-actions': { title: 'Quick Actions', cat: 'Navigation', icon: Zap,         size: { w: 3, h: 4 }, limits: { minW: 3, minH: 2, maxW: 6, maxH: 6 }, render: QuickActionsWidget, configurable: 'quick-actions' },
  notifications: { title: 'Notifications',   cat: 'Live',      icon: Bell,         size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: NotificationsWidget },
  // 'agenda' is the pre-merge widget type (My Agenda, list-only) - kept as a
  // hidden alias so dashboards that already have one keep working, but it now
  // renders the merged Calendar+Agenda panel instead of the old list-only
  // view (Pranshu, Sep 4: "both the widget gets merged in single... My Agenda
  // should be synchronized with calendar"). `hidden` pulls it out of the Add
  // Widget gallery so new placements only ever go through 'calendar'.
  agenda:        { title: 'My Agenda',       cat: 'Live',      icon: CalendarDays, size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 12, maxH: 8 }, render: CalendarPanel, hidden: true },
  calendar:      { title: 'Calendar',        cat: 'Live',      icon: CalendarDays, size: { w: 8, h: 5 }, limits: { minW: 5, minH: 4, maxW: 12, maxH: 8 }, render: CalendarPanel },
  clock:         { title: 'Clock & Greeting', cat: 'Utility',  icon: Clock,        size: { w: 3, h: 3 }, limits: { minW: 2, minH: 2, maxW: 4, maxH: 4 }, render: ClockWidget },
  notes:         { title: 'Notes',           cat: 'Utility',   icon: StickyNote,   size: { w: 3, h: 3 }, limits: { minW: 2, minH: 2, maxW: 6, maxH: 6 }, render: NotesWidget },
  'team-attendance': { title: 'Team Clocked-In', cat: 'Team',  icon: Users,        size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: (p) => <TeamStatWidget {...p} config={{ metric: 'clocked_in_now' }} />, minRole: 'supervisor' },
  'team-approvals':  { title: 'Team Approvals',  cat: 'Team',  icon: ClipboardCheck, size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: (p) => <TeamStatWidget {...p} config={{ metric: 'pending_requisitions' }} />, minRole: 'manager' },
  'time-off':        { title: 'Time Off to Review', cat: 'Team', icon: CalendarClock, size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: (p) => <TeamStatWidget {...p} config={{ metric: 'time_off_pending' }} />, minRole: 'manager' },

  // ── Panels ported from the old Overview / Team Analytics screens ──
  approvals:       { title: 'Pending Approvals',  cat: 'Team',      icon: ClipboardList, size: { w: 8, h: 5 }, limits: { minW: 6, minH: 4, maxW: 12, maxH: 8 }, render: ApprovalsPanel,    minRole: 'manager' },
  'who-has-what':  { title: 'Who Has What',       cat: 'Team',      icon: HandCoins,     size: { w: 8, h: 5 }, limits: { minW: 5, minH: 4, maxW: 12, maxH: 8 }, render: WhoHasWhatPanel,   minRole: 'supervisor' },
  'team-time':     { title: 'Team Time',          cat: 'Team',      icon: Timer,         size: { w: 12, h: 6 }, limits: { minW: 8, minH: 5, maxW: 12, maxH: 8 }, render: TeamTimePanel,     minRole: 'manager' },
  'team-workload': { title: 'Workload by Employee', cat: 'Team',    icon: Users,         size: { w: 6, h: 5 }, limits: { minW: 4, minH: 4, maxW: 8, maxH: 8 },  render: WorkloadPanel,     minRole: 'supervisor' },
  'team-projects': { title: 'Project-Wise Tasks', cat: 'Team',      icon: FolderKanban,  size: { w: 6, h: 4 }, limits: { minW: 4, minH: 3, maxW: 8, maxH: 7 },  render: ProjectsPanel,     minRole: 'supervisor' },
  'team-calendar': { title: 'Team Calendar',      cat: 'Team',      icon: CalendarDays,  size: { w: 6, h: 3 }, limits: { minW: 4, minH: 3, maxW: 12, maxH: 5 }, render: TeamCalendarPanel, minRole: 'supervisor' },
  occupancy:       { title: 'Occupancy Trend',    cat: 'Portfolio', icon: TrendingUp,    size: { w: 6, h: 4 }, limits: { minW: 4, minH: 3, maxW: 9, maxH: 6 },  render: OccupancyPanel },
  facilities:      { title: 'Facilities',         cat: 'Portfolio', icon: Building2,     size: { w: 6, h: 4 }, limits: { minW: 4, minH: 3, maxW: 12, maxH: 7 }, render: FacilitiesPanel },
  'tasks-list':    { title: 'Tasks Overview',     cat: 'Portfolio', icon: ListTodo,      size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 6, maxH: 6 },  render: TasksPanel },
};

// Clamp a layout item to its widget's limits (also keeps it inside the 12-col grid).
export function clampToLimits(it) {
  const lim = WIDGETS[it.type]?.limits || {};
  const w = Math.min(Math.max(it.w, lim.minW ?? 2), lim.maxW ?? 12);
  const h = Math.min(Math.max(it.h, lim.minH ?? 2), lim.maxH ?? 8);
  const x = Math.min(Math.max(0, it.x), 12 - w);
  const y = Math.max(0, it.y);
  return (w === it.w && h === it.h && x === it.x && y === it.y) ? it : { ...it, w, h, x, y };
}
