import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useMsal } from '@azure/msal-react';
import {
  ArrowRight, ArrowUpRight, BookOpen, CheckSquare, ChevronRight, ListTodo, Package, ShieldCheck, Bell, Clock, StickyNote,
  BarChart3, Layers, Zap, Users, ClipboardCheck, CalendarClock, ExternalLink, Boxes, X,
  Ticket,
  ClipboardList, HandCoins, CalendarDays, Timer, Megaphone, Sun, Briefcase, Hourglass,
  CheckCheck, Trash2, Mail, CalendarPlus, FolderOpen, LayoutGrid,
  Bookmark, Plus, Link2, Lock,
  PenLine, Contact, ShoppingCart, Cake, UserMinus,
  Ticket as TicketIcon, CloudSun, Search, HardHat, Building2,
} from 'lucide-react';
import { formatTime, formatWeekday, formatMonthDay } from '../lib/datetime';
import { api } from '../api';
import { myTasksFootnote, MY_TASKS_RULE } from './myTasksCount';
import { myTicketsFootnote, myTicketsFilter, MY_TICKETS_RULE } from './myTicketsCount';
import { setPendingOpen } from '../lib/pendingOpen';
import { LinkIcon } from '../components/LinkIcon.jsx';
import { useNotifications } from '../contexts/NotificationContext.jsx';
import { useRole } from '../contexts/RoleContext';
import { readIds, pushRecentId } from '../links/shortcutStorage';
import { looksLikeUrl } from '../links/personalLinkModal.jsx';
import { ModalLoading, LoadingState } from '../components/AsyncState';
import { MoreRow } from './listParts.jsx';
import { colorForLinkCategory, PERSONAL_TILE_COLOR, useFavoriteLinks, openFavorite, FavoriteTileGrid } from './favoriteLinks.jsx';

// Heavy panels (ported from the old Overview / Team Analytics screens) load
// lazily so TimeAdmin & the approval flows stay out of the main bundle.
const lazyPanel = (name) => lazy(() => import('./panels.jsx').then(m => ({ default: m[name] })));

// Quick-action composers (Outlook mail/event + the Tasks module's create modal)
// - one lazy chunk, pulled in only when a "do" action is actually clicked.
const QuickActionModal = lazy(() => import('./QuickActionModals.jsx'));
// Weather (Sep 29) loads with the first Weather tile, not with every dashboard.
const WeatherWidget = lazy(() => import('./weatherWidget.jsx'));
// The one-tap Punch tile (Oct 11) brings the whole punch stack (gates, the
// durable queue, geolocation, agent pairing) - loaded only when a board has one.
const PunchTile = lazy(() => import('./essentials/PunchTile.jsx'));
const PunchIcon = lazy(() => import('./essentials/PunchTile.jsx').then(m => ({ default: m.PunchIcon })));

const ApprovalsPanel    = lazyPanel('ApprovalsPanel');
const WhoHasWhatPanel   = lazyPanel('WhoHasWhatPanel');
const TeamTimePanel     = lazyPanel('TeamTimePanel');
const CalendarPanel     = lazyPanel('CalendarPanel');

// Workday tiles (phase 2, Sep 24) - own lazy chunk, same idea as panels.jsx.
const lazyWorkday = (name) => lazy(() => import('./workdayWidgets.jsx').then(m => ({ default: m[name] })));
const TimeClockWidget  = lazyWorkday('TimeClockWidget');
const MyRequestsWidget = lazyWorkday('MyRequestsWidget');
const DueBackWidget    = lazyWorkday('DueBackWidget');
const ComingUpWidget   = lazyWorkday('ComingUpWidget');

// Team tiles (phase 3, Sep 25) - the supervisor/manager gaps, own lazy chunk.
const lazyTeam = (name) => lazy(() => import('./teamWidgets.jsx').then(m => ({ default: m[name] })));
const TicketQueueWidget      = lazyTeam('TicketQueueWidget');
const TimeExceptionsWidget   = lazyTeam('TimeExceptionsWidget');
const OutTodayWidget         = lazyTeam('OutTodayWidget');
const PendingPurchasesWidget = lazyTeam('PendingPurchasesWidget');

// Essentials (Oct 7) - one file per tile so each is its own chunk and loads
// only when that tile is on the board.
const MyDayWidget         = lazy(() => import('./essentials/MyDay.jsx'));
const MyWorkWidget        = lazy(() => import('./essentials/MyWork.jsx'));
const MyTimeWidget        = lazy(() => import('./essentials/MyTime.jsx'));
const AnnouncementsWidget = lazy(() => import('./essentials/Announcements.jsx'));
const MyTeamWidget        = lazy(() => import('./essentials/MyTeam.jsx'));
// Accounting tiles (Oct 1) - the ledger search, for people with the grant.
const lazyAccounting = (name) => lazy(() => import('./accountingWidgets.jsx').then(m => ({ default: m[name] })));
const FindTransactionWidget = lazyAccounting('FindTransactionWidget');

// Fire the app's cross-view navigation event (see CLAUDE.md).
export function navigate(view, sub) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub || null } }));
}

const C = (name) => `hsl(var(--color-${name}))`;

// Every KPI the /dashboards/kpis endpoint can return, with how to present it.
export const KPI_CATALOG = {
  open_tasks:           { label: 'Open Tasks',              color: 'blue',   Icon: ListTodo,      hint: 'Across your team',     nav: { view: 'tasks' } },
  my_open_tasks:        { label: 'My Open Tasks',           color: 'blue',   Icon: ListTodo,      hint: 'Due soon or in progress', nav: { view: 'tasks' } },
  // The ticket twin of My Open Tasks (Oct 26 2026) - myTicketsCount.js.
  my_open_tickets:      { label: 'My Open Tickets',         color: 'red',    Icon: TicketIcon,    hint: 'Assigned to you',      nav: { view: 'tickets' } },
  pending_requisitions: { label: 'Requisitions to Approve', color: 'orange', Icon: ClipboardCheck, hint: 'Awaiting approval',   nav: { view: 'myhr', sub: 'purchase' } },
  pending_inventory:    { label: 'Inventory Requests',      color: 'orange', Icon: Package,       hint: 'Awaiting approval',    nav: { view: 'inventory', sub: 'checkouts' } },
  open_purchases:       { label: 'Open Purchases',          color: 'purple', Icon: Package,       hint: 'In progress',          nav: { view: 'myhr', sub: 'purchase' } },
  my_checkouts:         { label: 'My Active Checkouts',     color: 'green',  Icon: Boxes,         hint: 'Currently with you',   nav: { view: 'inventory', sub: 'checkouts' } },
  my_assignments:       { label: 'Items Assigned to Me',    color: 'green',  Icon: Package,       hint: 'Your equipment',       nav: { view: 'inventory' } },
  unread_notifications: { label: 'Unread Notifications',    color: 'blue',   Icon: Bell,          hint: 'Tap to review' },
  signatures_needed:    { label: 'Signatures Needed',       color: 'green',  Icon: PenLine,       hint: 'Waiting on you',       nav: { view: 'myhr' } },
  warranties_expiring:  { label: 'Warranties Expiring',     color: 'red',    Icon: ShieldCheck,   hint: 'Within 60 days',       nav: { view: 'property-asset' } },
  open_tickets:         { label: 'Open Tickets',            color: 'red',    Icon: TicketIcon,    hint: 'Across the team',      nav: { view: 'tickets' } },
  // Manager Dashboard folded into the one Dashboard (Sep 3) - these KPI tiles
  // used to go Home (a no-op from the dashboard); they now open the screen where the work happens.
  clocked_in_now:       { label: 'Clocked In Now',          color: 'green',  Icon: Users,         hint: 'On the clock now',     nav: { view: 'shifts', sub: 'schedule' } },
  time_off_pending:     { label: 'Time Off to Review',      color: 'orange', Icon: CalendarClock, hint: 'Awaiting your review',  nav: { view: 'hr', sub: 'hr-time-off' } },
};

// Curated shortcut destinations for the picker (module + optional sub-screen).
// Each carries its module's icon (Oct 11) so a row of Shortcut tiles reads
// like a row of app icons instead of fifteen identical stacks of layers.
export const SHORTCUT_TARGETS = [
  { view: 'timeclock',        label: 'Time Clock',        Icon: Clock,        color: 'green' },
  { view: 'myhr',             label: 'Workday',           Icon: Briefcase,    color: 'brand' },
  { view: 'tasks',            label: 'Tasks',             Icon: CheckSquare,  color: 'blue' },
  { view: 'inventory',        label: 'Item Management',   Icon: Package,      color: 'orange' },
  { view: 'inventory', sub: 'catalog',   label: 'Item Management · Browse Catalog', Icon: Boxes,     color: 'orange' },
  { view: 'inventory', sub: 'checkouts', label: 'Item Management · Checkouts',      Icon: HandCoins, color: 'orange' },
  { view: 'myhr', sub: 'purchase', label: 'Workday · Purchase Requests', Icon: ShoppingCart, color: 'purple' },
  { view: 'property-asset',   label: 'Asset Management',  Icon: Building2,    color: 'brand' },
  { view: 'sop',              label: 'Knowledge Base',    Icon: BookOpen,     color: 'brand' },
  { view: 'hr',               label: 'HR',                Icon: Users,        color: 'green' },
  { view: 'accounting',       label: 'Accounting',        Icon: BarChart3,    color: 'purple' },
  { view: 'operations',       label: 'Operations',        Icon: ClipboardList, color: 'blue' },
  { view: 'ops',              label: 'Construction',      Icon: HardHat,      color: 'orange' },
  { view: 'external-links',   label: 'Links',             Icon: ExternalLink, color: 'blue' },
  { view: 'support',          label: 'Help Center',           Icon: TicketIcon,   color: 'red' },
];

const targetFor = (t) => SHORTCUT_TARGETS.find(s => s.view === t.view && (s.sub || '') === (t.sub || ''));
const labelFor = (t) => targetFor(t)?.label || t.label || t.view;

// ── Native card shells (match the Overview screen exactly) ────────────────────
export function DashCard({ title, sub, action, children, onClick, style }) {
  return (
    <div className="dash-card" onClick={onClick}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', cursor: onClick ? 'pointer' : 'default', ...style }}>
      {(title || action) && (
        <div className="dash-card-head" style={{ marginBottom: 12, gap: 8, minWidth: 0 }}>
          {/* minWidth 0 + ellipsis: at two columns the actions used to
              squeeze the title into one word per line. */}
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            {title && <div className="dash-card-title" title={typeof title === 'string' ? title : undefined} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>}
            {sub && <div className="dash-card-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
          </div>
          {action && <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>{action}</div>}
        </div>
      )}
      <div className="dash-scroll" style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}

// Stat tile - the DeskHome dk-stat anatomy (tinted icon chip top-left, hover
// arrow top-right, big tabular numeral) so Home and the custom grid read as
// ONE design world. The old corner watercolor blob is gone on purpose.
function StatCard({ label, value, color, Icon, nav, hint, hintShort, hero, onClick, tip, noted }) {
  const go = onClick || (() => nav && navigate(nav.view, nav.sub));
  const clickable = !!(onClick || nav);
  const I = Icon || BarChart3;
  return (
    // dk-stat--tile: the grid's fixed-height cell (style.css) - the label
    // keeps to one line and the hint drops out when the tile is too short
    // for it, instead of the chip and hint spilling past the card's edges.
    <div className={`dk-stat dk-stat--tile${hero ? ' dk-stat--hero' : ''}${noted ? ' dk-stat--noted' : ''}`} onClick={clickable ? go : undefined} role={clickable ? 'button' : undefined} title={tip || (hint ? `${label} - ${hint}` : label)}
      style={{ height: '100%', boxSizing: 'border-box', cursor: clickable ? 'pointer' : 'default', justifyContent: 'center' }}>
      <span className="dk-stat-top">
        <span className={`dk-chip dk-chip--${color}`}><I /></span>
        {clickable && <ArrowUpRight size={15} className="dk-stat-arrow" />}
      </span>
      <span className="dk-stat-num">{value}</span>
      <span className="dk-stat-label">{label}</span>
      {hint && <span className="dk-stat-sub">{hintShort
        ? <><span className="dk-sub-long">{hint}</span><span className="dk-sub-short">{hintShort}</span></>
        : hint}</span>}
    </div>
  );
}


// ── Widgets ───────────────────────────────────────────────────────────────────
// The two "mine" counts name what they left out under the number (the
// footnote), and say their rule in the tooltip.
const FOOTNOTES = {
  my_open_tasks: { note: myTasksFootnote, rule: MY_TASKS_RULE },
  my_open_tickets: { note: myTicketsFootnote, rule: MY_TICKETS_RULE },
};

// My Open Tickets lands on the desk's own list - Assigned to Me, or
// Unassigned when that is all there is (TicketsView's nexus:ticket-filter).
function openMyTickets(kpis) {
  const filter = myTicketsFilter(kpis);
  setPendingOpen('ticketFilter', filter);
  navigate('tickets');
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:ticket-filter', { detail: { filter } })), 0);
}

function KpiWidget({ config, kpis }) {
  const { openPanel } = useNotifications();
  const metric = config?.metric;
  const meta = KPI_CATALOG[metric] || { label: 'Metric', color: 'blue', Icon: BarChart3 };
  const onClick = metric === 'unread_notifications' ? openPanel
    : metric === 'my_open_tickets' ? () => openMyTickets(kpis) : undefined;
  const foot = FOOTNOTES[metric];
  const note = foot ? foot.note(kpis) : null;
  return <StatCard label={meta.label} value={kpis?.[metric] ?? 0} color={meta.color} Icon={meta.Icon} nav={meta.nav} hint={note || meta.hint} hintShort={note ? foot.note(kpis, true) : undefined} hero={!!config?.hero} onClick={onClick}
    tip={foot ? `${meta.label} - ${foot.rule}${note ? `. ${note}` : ''}` : undefined} noted={!!note} />;
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {rows.map(r => {
          const onClick = clickFor(r);
          return (
          <div key={r.m} onClick={onClick || undefined} style={{ cursor: onClick ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, marginBottom: 3 }}>
              <span style={{ color: 'var(--muted)', fontWeight: 600, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.meta.label}>{r.meta.label}</span>
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
  // Saved configs carry only { view, sub, label } - the icon and color come
  // from the catalog entry they point at; an unknown target keeps the old look.
  const known = targetFor(t);
  const color = t.color || known?.color || 'blue';
  const Icon = known?.Icon || Layers;
  return (
    // sc-tile (style.css): a short cell drops the "Open" line and shrinks the
    // chip, and the name keeps to two lines, so a long target ("Item
    // Management · Browse Catalog") never spills out of a half-width tile.
    <div className="dash-card sc-tile" onClick={() => navigate(t.view, t.sub)} title={labelFor(t)}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', cursor: 'pointer', overflow: 'hidden' }}>
      <span className={`dk-chip dk-chip--${color} sc-tile-chip`}>
        <Icon size={20} />
      </span>
      <div className="sc-tile-name">{labelFor(t)}</div>
      <div className="sc-tile-open">Open <ArrowRight size={12} /></div>
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

// Link tile colors: dashboard/favoriteLinks.jsx (the same scheme External Links uses).

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
      <div className="modal-content nx-popup" onClick={e => e.stopPropagation()}>
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
          No folder picked yet - Customize, then use the gear on this tile to choose one.
        </div>
      </DashCard>
    );
  }

  const title = state.folder?.name || config.folderName || 'Links Folder';
  return (
    <DashCard title={title} sub={config.itemType === 'personal' ? 'Personal' : 'Company'}
      action={<FolderOpen size={15} style={{ color: 'var(--muted)' }} />}>
      {state.loading ? (
        <LoadingState />
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

// The Links tab's bookmarks - EVERY one (Neil, Oct 28 2026: "a widget that
// has all the favorite links in it"), in an even grid that scrolls inside the
// card (dashboard/favoriteLinks.jsx, shared with the home's Favorites card) -
// with a Recently Used tab reading the same per-browser trail the Links tab
// keeps (shortcutStorage.js). The tab choice is session-local on purpose:
// persisting it through updateConfig would mark the saved layout dirty and
// trip the "discard layout changes?" confirm on the next view switch (see
// confirmDiscard in CustomDashboard) for what is only a way of looking, not
// an arrangement.
function FavoritesWidget() {
  const { myEmail } = useRole();
  const [mode, setMode] = useState('favorites'); // 'favorites' | 'recents'
  const state = useFavoriteLinks();
  const [recentIds, setRecentIds] = useState(() => readIds(myEmail, 'recents'));

  const recents = recentIds.map(id => state.company.find(l => l.id === id)).filter(Boolean);
  const links = mode === 'recents' ? recents : state.favorites;
  const open = (l) => {
    openFavorite(l, myEmail);
    if (l._favType !== 'personal') setRecentIds(readIds(myEmail, 'recents'));
  };
  const tabs = (
    <div style={{ display: 'inline-flex', gap: 12 }} role="tablist" aria-label="Show">
      <button type="button" role="tab" aria-selected={mode === 'favorites'} style={tabStyle(mode === 'favorites')} onClick={() => setMode('favorites')}>Favorites</button>
      <button type="button" role="tab" aria-selected={mode === 'recents'} style={tabStyle(mode === 'recents')} onClick={() => setMode('recents')}>Recent</button>
    </div>
  );
  const sub = mode === 'recents' ? 'Company links opened in this browser'
    : state.favorites.length ? `${state.favorites.length} from Links` : undefined;
  return (
    <DashCard title={mode === 'recents' ? 'Recently Used' : 'Favorites'} sub={sub} action={tabs}>
      {state.loading ? (
        <LoadingState compact />
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
        <FavoriteTileGrid links={links} onOpen={open} label={mode === 'recents' ? 'Recently used links' : 'Favorite links'} />
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
    <div tabIndex={-1} onPaste={onPaste} style={{ height: '100%' }}>
      <DashCard title="My Personal Links" sub={note || 'Only visible to you'}
        action={<Lock size={15} style={{ color: 'var(--muted)' }} />}>
        {state.loading ? (
          <LoadingState compact />
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
          <Suspense fallback={<ModalLoading />}>
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
// shows; tiles saved before that carry no config and show the default set
// (DEFAULT_QUICK_ACTIONS).
export const QUICK_ACTIONS = [
  { key: 'task',          label: 'New Task',          act: 'task',          color: 'blue',   Icon: CheckSquare },
  { key: 'event',         label: 'New Event',         act: 'event',         color: 'purple', Icon: CalendarPlus },
  { key: 'email',         label: 'New Email',         act: 'email',         color: 'brand',  Icon: Mail },
  // The Ticket module's own create form, in place (Neil, 10/08: "Add + Ticket").
  { key: 'ticket',        label: 'New Ticket',        act: 'ticket',        color: 'red',    Icon: Ticket },
  { key: 'personal-link', label: 'Add Personal Link', act: 'personal-link', color: 'purple', Icon: Link2 },
  { key: 'request-item',  label: 'Request an Item',   view: 'inventory', sub: 'catalog', color: 'orange', Icon: Package },
  { key: 'time-off',      label: 'Request Time Off',  view: 'timeclock', sub: 'timeoff',   color: 'orange', Icon: CalendarClock },
  { key: 'punch-fix',     label: 'Punch Correction',  view: 'timeclock', sub: 'timesheet', color: 'green',  Icon: Timer },
  { key: 'ask-hr',        label: 'Ask HR',            view: 'myhr',                        color: 'blue',   Icon: Contact },
  { key: 'purchase',      label: 'New Purchase Request', view: 'myhr', sub: 'purchase:new', color: 'purple', Icon: ShoppingCart },
  { key: 'timeclock',     label: 'Time Clock',        view: 'timeclock',    color: 'green',  Icon: Clock },
  { key: 'kb',            label: 'Knowledge Base',    view: 'sop',          color: 'brand',  Icon: BookOpen },
  // More places to reach in one tap (Neil, 10/13). `module` names the Access
  // Group grant the screen needs (same rule as a module-gated widget); a
  // person without it never sees the action offered or placed.
  { key: 'find-person',   label: 'Find a Person',     view: 'directory',                      color: 'blue',   Icon: Users },
  { key: 'checkout-item', label: 'Check Out an Item', view: 'inventory', sub: 'checkouts',    color: 'orange', Icon: HandCoins },
  { key: 'my-shifts',     label: 'My Shifts',         view: 'myhr', sub: 'shifts',            color: 'green',  Icon: CalendarDays },
  { key: 'briefing',      label: 'My Briefing',       view: 'briefing',                       color: 'brand',  Icon: Sun },
  { key: 'credvault',     label: 'Credentials',       view: 'credvault', module: 'credvault', color: 'purple', Icon: ShieldCheck },
];
// Time Clock and Knowledge Base left the default set for New Ticket (Neil,
// 10/08); both stay in the catalog for a tile that picks them.
export const DEFAULT_QUICK_ACTIONS = ['task', 'event', 'email', 'request-item', 'ticket'];
// The tile's config `actions` is an ORDERED list of keys (the picker reorders
// it, Oct 13) over the Action Tile's catalog, so the punch is a quick action
// too. Keys the catalog no longer carries are skipped, never crash.
export function resolveQuickActions(config) {
  const keys = Array.isArray(config?.actions) && config.actions.length ? config.actions : DEFAULT_QUICK_ACTIONS;
  return keys.map(actionChoice).filter(Boolean);
}
// May this person use an action? The punch is nothing to a time-tracking-
// exempt person; a `module` action needs that grant (administrators bypass,
// a Viewer-level grant is enough) - the same tests widgetAllowed applies.
export function actionAllowed(a, role) {
  if (!a) return false;
  if (a.timeTracked && role?.timeTrackingExempt === true) return false;
  if (a.module && !role?.canAccessModule?.(a.module, 'administrator', 'viewer')) return false;
  return true;
}
// How a Quick Actions tile draws (Neil, 10/13): bare icons on the board, one
// per grid cell, is the default for a new tile; a tile saved before styles
// existed carries no `style` and keeps the list it was sized for.
export const QUICK_STYLES = [
  { key: 'icons', label: 'Icons Only',   hint: 'Bare icons on the board, one per cell - a dock you can drop anywhere' },
  { key: 'tiles', label: 'Icons + Names', hint: 'App-style tiles with the name under each icon' },
  { key: 'list',  label: 'List',         hint: 'One row per action with its name and an arrow' },
];
export const DEFAULT_QUICK_STYLE = 'icons';
export const quickStyleOf = (config) => (QUICK_STYLES.some(st => st.key === config?.style) ? config.style : 'list');
// Size rules per style: a dock goes down to one row (2x1 = two icons), the
// named tiles need two rows for an icon and a name, the list keeps its old
// bounds. Read through `limitsWhen` so the resize handle follows the style.
export const QUICK_LIMITS = {
  icons: { minW: 2, minH: 1, maxW: 12, maxH: 4 },
  tiles: { minW: 2, minH: 2, maxW: 12, maxH: 6 },
  list:  { minW: 3, minH: 2, maxW: 6,  maxH: 6 },
};
export const QUICK_SIZE = { icons: { w: 3, h: 2 }, tiles: { w: 4, h: 2 }, list: { w: 3, h: 4 } };
// Which composer is open and the one-line note it left behind, shared by the
// Quick Actions card and the Action Tile. Composers report whether Graph sent
// it or Outlook took over, so the card can say which actually happened
// instead of a blanket "Done". The note's timer is held in a ref and cleared
// on unmount (a removed tile used to set state after it was gone) and on
// every new note (the first note's timer used to wipe the second one early).
function useComposer() {
  const [modal, setModal] = useState(null);
  const [note, setNote] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = (res) => {
    setModal(null);
    if (res?.toast) {
      setNote(res.toast);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setNote(''), 4000);
    }
  };
  return { modal, setModal, note, close };
}

// One icon of a dock or a tile grid. The punch is live (its icon is the next
// punch, it turns green while clocked in) and lazy, like the Punch tile; any
// other action is a plain chip that composes or navigates.
function QuickIcon({ a, className, onRun, onNote }) {
  if (a.key === 'punch') {
    return (
      <Suspense fallback={<button type="button" className={`${className} dk-chip--green`} aria-label="Punch Clock" title="Punch Clock" disabled><Clock /></button>}>
        <PunchIcon className={className} onNote={onNote} />
      </Suspense>
    );
  }
  return (
    <button type="button" className={`${className} dk-chip--${a.color}`} title={a.label} aria-label={a.label} onClick={() => onRun(a)}>
      <a.Icon />
    </button>
  );
}

// The list rows - the List style and the dock's overflow sheet draw the
// same rows (icon chip, label, chevron: DeskHome's quick-action anatomy).
// The punch row is the live punch icon with its name beside it.
function QuickActionRows({ actions, onRun, onNote }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {actions.map(a => (
        a.key === 'punch'
          ? <div key={a.key} className="dk-key qa-list-punch"><QuickIcon a={a} className="dk-chip qa-list-punch-chip" onRun={onRun} onNote={onNote} /> {a.label}</div>
          : (
            <button key={a.key} className="dk-key" onClick={() => onRun(a)}>
              <span className={`dk-chip dk-chip--${a.color}`}><a.Icon /></span> {a.label}
              <ChevronRight size={14} className="dk-key-arrow" />
            </button>
          )
      ))}
    </div>
  );
}

// The actions a dock could not fit, as the list rows, in a sheet.
function QuickActionsSheet({ actions, onRun, onNote, onClose }) {
  return createPortal((
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content nx-popup" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Quick Actions</h3>
          <button className="close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div style={{ padding: '10px 14px 16px' }}>
          <QuickActionRows actions={actions} onRun={onRun} onNote={onNote} />
        </div>
      </div>
    </div>
  ), document.body);
}

// Icons Only (Neil, 10/13): no card - the icons sit on the board, one per
// grid cell, so a w x h tile is exactly w x h icons and a 3x1 is a dock.
// More actions than cells: the last cell is "+N" and opens the rest as a
// sheet, so a row is never half drawn. On a phone the board stacks to one
// column and the tile is one row tall (phoneRowsWhen), so the dock is a
// single strip: the icons spread across it, and scroll sideways when there
// are more than fit. The composer's one-line result floats over the strip
// for a moment since there is no card header to carry it.
// `phone` is the grid's own stacking decision (DashboardGrid hands it to
// every widget), so the dock is a strip exactly when its cell is one row.
function QuickActionDock({ actions, size, phone, note, onRun, onNote }) {
  const [more, setMore] = useState(false);
  const w = Math.max(1, size?.w || 3), h = Math.max(1, size?.h || 1);
  const cap = phone ? actions.length : w * h;
  const shown = actions.length > cap ? actions.slice(0, Math.max(0, cap - 1)) : actions;
  const rest = actions.slice(shown.length);
  return (
    <div className={`qa-dock${phone ? ' qa-dock--row' : ''}`} role="group" aria-label="Quick actions"
      style={phone ? undefined : { gridTemplateColumns: `repeat(${w}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${h}, minmax(0, 1fr))` }}>
      {actions.length === 0 && <span className="qa-empty">No quick actions apply to you - configure this tile</span>}
      {shown.map(a => <QuickIcon key={a.key} a={a} className="qa-icon" onRun={onRun} onNote={onNote} />)}
      {rest.length > 0 && (
        <button type="button" className="qa-icon qa-icon--more" onClick={() => setMore(true)}
          title={`${rest.length} more`} aria-label={`${rest.length} more quick actions`}>+{rest.length}</button>
      )}
      {note && <span role="status" className="qa-note">{note}</span>}
      {more && <QuickActionsSheet actions={rest} onNote={onNote} onClose={() => setMore(false)} onRun={(a) => { setMore(false); onRun(a); }} />}
    </div>
  );
}

function QuickActionsWidget({ config, size, phone }) {
  const { modal, setModal, note, close } = useComposer();
  const role = useRole();
  const style = quickStyleOf(config);
  const actions = resolveQuickActions(config).filter(a => actionAllowed(a, role));
  const run = (a) => (a.act ? setModal(a.act) : navigate(a.view, a.sub));
  // Stable: PunchIcon pushes its note through this once per note, not once
  // per render of this widget.
  const onNote = useCallback((t) => close({ toast: t }), [close]);
  const composer = modal && <Suspense fallback={<ModalLoading />}><QuickActionModal kind={modal} onClose={close} /></Suspense>;
  if (style === 'icons') {
    return (
      <>
        <QuickActionDock actions={actions} size={size} phone={phone} note={note} onRun={run} onNote={onNote} />
        {composer}
      </>
    );
  }
  if (style === 'tiles') {
    // App-icon tiles with the name under each, no header (the icons say what
    // the card is); the grid wraps to the width and scrolls past the height.
    return (
      <div className="dash-card qa-tiles-card">
        {actions.length === 0 && <div className="qa-empty">No quick actions apply to you - configure this tile.</div>}
        <div className="qa-tiles" role="group" aria-label="Quick actions">
          {actions.map(a => (
            a.key === 'punch'
              ? <div key={a.key} className="qa-tile qa-tile--static"><QuickIcon a={a} className="qa-icon qa-tile-chip" onRun={run} onNote={onNote} /><span className="qa-tile-name">{a.label}</span></div>
              : (
                <button key={a.key} type="button" className="qa-tile" onClick={() => run(a)} title={a.label}>
                  <span className={`qa-icon qa-tile-chip dk-chip--${a.color}`} aria-hidden="true"><a.Icon /></span>
                  <span className="qa-tile-name">{a.label}</span>
                </button>
              )
          ))}
        </div>
        {note && <div className="qa-tiles-note" role="status">{note}</div>}
        {composer}
      </div>
    );
  }
  // List - the original.
  return (
    <DashCard title="Quick Actions" sub={note || undefined}>
      {actions.length === 0
        ? <div className="qa-empty" style={{ padding: '10px 0' }}>No quick actions apply to you - configure this tile.</div>
        : <QuickActionRows actions={actions} onRun={run} onNote={onNote} />}
      {composer}
    </DashCard>
  );
}

// ── Single-action tiles (Oct 11) ──────────────────────────────────────────────
// Neil: "smaller tiles that do single actions... can make it feel like iOS".
// One tile = one thing: a composer (task, event, email, ticket, link), a
// screen (request an item, time off...), or the next punch on the clock. The
// face is an app icon with its name under it; at one row tall it turns into a
// pill with the icon beside the name. The whole tile is the button.
// `subRole` ('status' | 'alert') announces the caption: the live region sits
// OUTSIDE the button (a button's children are presentational, so a role on
// them may never be read out). `busy` keeps the button focusable - a
// disabled button drops keyboard focus to <body> mid-punch - and marks it
// aria-disabled with the click ignored; `disabled` is for a tile that cannot
// act at all yet (loading).
export function ActionFace({ Icon, color = 'blue', label, sub, tone, subRole, row, disabled, busy, onClick }) {
  const inert = !!busy && !disabled;
  return (
    <>
      <button type="button" className={`dk-stat dk-action${row ? ' dk-action--row' : ''}`} onClick={inert ? undefined : onClick}
        disabled={disabled} aria-disabled={inert || undefined} aria-busy={busy || undefined} title={sub ? `${label} - ${sub}` : label}
        style={{ height: '100%', width: '100%', boxSizing: 'border-box' }}>
        <span className={`dk-chip dk-chip--${color} dk-action-chip`}><Icon /></span>
        <span className="dk-action-text">
          <span className="dk-action-label">{label}</span>
          {sub && <span className={`dk-action-sub${tone ? ` dk-action-sub--${tone}` : ''}`}>{sub}</span>}
        </span>
      </button>
      <span role={subRole === 'alert' ? 'alert' : 'status'} className="dk-sr-only">{subRole ? sub : ''}</span>
    </>
  );
}

// What an Action Tile can be. The punch comes first - the one most people
// tap every day - then every quick action, each a tile of its own.
// `timeTracked`: not for a time-tracking-exempt person (see widgetHidden).
export const ACTION_CHOICES = [
  { key: 'punch', label: 'Punch In / Out', color: 'green', Icon: Clock, timeTracked: true, hint: 'Whichever punch is next, in one tap' },
  ...QUICK_ACTIONS,
];
export const DEFAULT_ACTION = 'task';
export const actionChoice = (key) => ACTION_CHOICES.find(a => a.key === key);

function ActionTile({ config, size }) {
  const { modal, setModal, note, close } = useComposer();
  // One row tall = the pill layout; anything taller = the app-icon layout.
  const row = (size?.h ?? 2) <= 1;
  const a = actionChoice(config?.action) || actionChoice(DEFAULT_ACTION);
  if (a.key === 'punch') {
    return (
      <Suspense fallback={<ActionFace row={row} Icon={Clock} color="green" label="Punch Clock" sub="Loading…" disabled />}>
        <PunchTile row={row} />
      </Suspense>
    );
  }
  return (
    <>
      <ActionFace row={row} Icon={a.Icon} color={a.color} label={a.label} sub={note || undefined} tone={note ? 'ok' : undefined}
        onClick={() => a.act ? setModal(a.act) : navigate(a.view, a.sub)} />
      {modal && <Suspense fallback={<ModalLoading />}><QuickActionModal kind={modal} onClose={close} /></Suspense>}
    </>
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

function NotificationsWidget({ notifications, markRead, markAllRead, dismiss, clearAll, phone }) {
  const { openPanel } = useNotifications();
  // Unread first, then most-important type, then most recent - so the thing
  // that most needs your attention is always at the top of the list.
  // Closed ones live in the bell's Closed list, not here.
  const sorted = (notifications || []).filter(n => !n.closed).sort((a, b) => {
    if (!!a.read !== !!b.read) return a.read ? 1 : -1;
    const diff = importanceOf(b) - importanceOf(a);
    if (diff) return diff;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });
  const NOTIF_LIMIT = 12;
  const list = sorted.slice(0, NOTIF_LIMIT);
  const unread = sorted.filter(n => !n.read).length;
  // Header links are 16px-tall text on desktop; a phone gets 36px targets.
  const headBtn = { marginTop: 0, ...(phone ? { minHeight: 36, padding: '0 4px' } : null) };
  return (
    <DashCard title="Notifications" sub={unread ? `${unread} unread` : 'All caught up'}
      action={list.length > 0 ? (
        <span style={{ display: 'inline-flex', gap: 12 }}>
          {unread > 0 && markAllRead && (
            <button onClick={markAllRead} className="link-btn" style={headBtn}>
              <CheckCheck size={13} /> Mark All Read
            </button>
          )}
          {clearAll && (
            <button onClick={clearAll} className="link-btn" style={{ ...headBtn, color: 'hsl(var(--color-red))' }}>
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
                  <button onClick={(e) => { e.stopPropagation(); dismiss(n.id); }} title="Clear" aria-label="Clear Notification"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0,
                      width: phone ? 36 : 24, height: phone ? 36 : 24, margin: phone ? '-8px -8px -8px 0' : '-4px -4px -4px 0', borderRadius: 6 }}>
                    <X size={phone ? 16 : 13} />
                  </button>
                )}
              </div>
            );
          })}
          <MoreRow count={sorted.length - list.length} noun="more in the bell" onClick={openPanel} />
        </div>
      )}
    </DashCard>
  );
}

// The Notes tile is the Notes module's (notes/NotesWidget.jsx, Oct 29 2026):
// a capture line into today's scratchpad and the pinned notes. It used to
// keep its own text in the view's config; that text moves into a note.
const NotesWidget = lazy(() => import('../notes/NotesWidget.jsx'));

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
    // clock-tile (style.css): the numeral scales with the tile's width - at
    // two columns a 30px "12:45 PM" was wider than the card.
    <div className="dash-card clock-tile" onClick={() => navigate('timeclock')}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, cursor: 'pointer', overflow: 'hidden' }}>
      <div className="clock-tile-line" style={{ fontSize: 13.5, color: 'var(--wk-dim)', fontWeight: 600 }}>{greet}</div>
      <div className="clock-tile-time">{formatTime(now)}</div>
      <div className="clock-tile-line" style={{ fontSize: 12.5, color: 'var(--wk-faint)' }}>{formatWeekday(now)}, {formatMonthDay(now)}</div>
      <div className="clock-tile-line clock-tile-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--wk-green)', fontSize: 12.5, fontWeight: 600, marginTop: 9 }}>
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
const CALENDAR_PHONE_ROWS = 9;
export const WIDGETS = {
  kpi:           { title: 'KPI Stat',        cat: 'Metrics',   icon: BarChart3,    size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: KpiWidget,          configurable: 'kpi', compact: true },
  // At a Glance, retired (Neil, Oct 13 2026: "nobody cares that there's 1,925
  // open tasks across the whole company"). Gone from every board and the
  // gallery via widgetHidden; kept here so saved layouts that carry it load
  // cleanly instead of showing "no longer available".
  'kpi-bar':     { title: 'KPI Bar Chart',   cat: 'Metrics',   icon: BarChart3,    size: { w: 4, h: 3 }, limits: { minW: 3, minH: 3, maxW: 6, maxH: 5 }, render: KpiBarWidget, hidden: true, retired: true },
  // A two-row stat tile since Sep 29 (was 3x3 with its own header + button):
  // maxH 2 so every saved board shrinks with it on load, minW 3 so today
  // and the week fit on one baseline.
  'time-clock':  { title: 'Time Clock',      cat: 'Workday',   icon: Clock,        size: { w: 3, h: 2 }, limits: { minW: 3, minH: 2, maxW: 4, maxH: 2 }, render: TimeClockWidget, timeTracked: true },
  'my-requests': { title: 'My Requests',     cat: 'Workday',   icon: ClipboardList, size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: MyRequestsWidget },
  'due-back':    { title: 'Due Back Soon',   cat: 'Workday',   icon: Boxes,        size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: DueBackWidget },
  'coming-up':   { title: 'Coming Up',       cat: 'Workday',   icon: Cake,         size: { w: 3, h: 3 }, limits: { minW: 2, minH: 2, maxW: 4, maxH: 5 }, render: ComingUpWidget },
  // Action Tile (Oct 11): one action per tile, app-icon face, down to one
  // row tall (a pill) - the smallest tile on the board. `compact`: on a
  // phone two of these sit side by side instead of each taking a full row.
  action:        { title: 'Action Tile',     cat: 'Actions',   icon: Zap,          size: { w: 2, h: 2 }, limits: { minW: 2, minH: 1, maxW: 4, maxH: 2 }, render: ActionTile, configurable: 'action', compact: true,
                   timeTrackedWhen: (config) => (config?.action || DEFAULT_ACTION) === 'punch' },
  shortcut:      { title: 'Shortcut Tile',   cat: 'Navigation', icon: Layers,      size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: ShortcutWidget,     configurable: 'shortcut', compact: true },
  links:         { title: 'Quick Links',     cat: 'Links',     icon: ExternalLink, size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 4, maxH: 6 }, render: LinksWidget },
  'links-folder': { title: 'Links Folder',   cat: 'Links',     icon: FolderOpen,   size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 4, maxH: 6 }, render: LinksFolderWidget, configurable: 'links-folder' },
  favorites:     { title: 'Favorites',       cat: 'Links',     icon: Bookmark,     size: { w: 4, h: 5 }, limits: { minW: 2, minH: 3, maxW: 6, maxH: 6 }, render: FavoritesWidget },
  'personal-links': { title: 'My Personal Links', cat: 'Links', icon: Link2,       size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 6, maxH: 6 }, render: PersonalLinksWidget },
  // Quick Actions (styles Oct 13): the size, the resize bounds and the phone
  // height all follow the style in the tile's config - a bare icon dock is
  // one row on a phone, the list keeps what it had.
  'quick-actions': { title: 'Quick Actions', cat: 'Actions',   icon: ListTodo,         size: QUICK_SIZE.icons, limits: QUICK_LIMITS.list, render: QuickActionsWidget, configurable: 'quick-actions',
                     sizeWhen: (config) => QUICK_SIZE[quickStyleOf(config)], limitsWhen: (config) => QUICK_LIMITS[quickStyleOf(config)],
                     phoneRowsWhen: (config) => (quickStyleOf(config) === 'icons' ? 1 : undefined) },
  notifications: { title: 'Notifications',   cat: 'Live',      icon: Bell,         size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: NotificationsWidget },
  // 'agenda' is the pre-merge widget type (My Agenda, list-only) - kept as a
  // hidden alias so dashboards that already have one keep working, but it now
  // renders the merged Calendar+Agenda panel instead of the old list-only
  // view (Pranshu, Sep 4: "both the widget gets merged in single... My Agenda
  // should be synchronized with calendar"). `hidden` pulls it out of the Add
  // Widget gallery so new placements only ever go through 'calendar'.
  // Same bounds as Calendar (Oct 14): at three columns the merged panel's
  // month grid left the agenda a sliver.
  agenda:        { title: 'My Agenda',       cat: 'Live',      icon: CalendarDays, size: { w: 8, h: 5 }, limits: { minW: 5, minH: 4, maxW: 12, maxH: 8 }, render: CalendarPanel, hidden: true, phoneRowsWhen: () => CALENDAR_PHONE_ROWS },
  weather:       { title: 'Weather',         cat: 'Live',      icon: CloudSun,     size: { w: 4, h: 6 }, limits: { minW: 2, minH: 2, maxW: 8, maxH: 7 }, render: WeatherWidget, configurable: 'weather' },
  // Phone: the month grid runs full width with the agenda under it, so the
  // stacked tile is taller than its board height (Oct 14 - at five rows the
  // grid filled the tile and the agenda never showed).
  calendar:      { title: 'Calendar',        cat: 'Live',      icon: CalendarDays, size: { w: 8, h: 5 }, limits: { minW: 5, minH: 4, maxW: 12, maxH: 8 }, render: CalendarPanel, phoneRowsWhen: () => CALENDAR_PHONE_ROWS },
  clock:         { title: 'Clock & Greeting', cat: 'Utility',  icon: Clock,        size: { w: 3, h: 3 }, limits: { minW: 2, minH: 2, maxW: 4, maxH: 4 }, render: ClockWidget },
  notes:         { title: 'Notes',           cat: 'Utility',   icon: StickyNote,   size: { w: 3, h: 3 }, limits: { minW: 2, minH: 2, maxW: 6, maxH: 6 }, render: NotesWidget },
  'team-attendance': { title: 'Team Clocked-In', cat: 'Team',  icon: Users,        size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: (p) => <TeamStatWidget {...p} config={{ metric: 'clocked_in_now' }} />, minRole: 'supervisor', compact: true },
  'team-approvals':  { title: 'Team Approvals',  cat: 'Team',  icon: ClipboardCheck, size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: (p) => <TeamStatWidget {...p} config={{ metric: 'pending_requisitions' }} />, minRole: 'manager', compact: true },
  'time-off':        { title: 'Time Off to Review', cat: 'Team', icon: CalendarClock, size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: (p) => <TeamStatWidget {...p} config={{ metric: 'time_off_pending' }} />, minRole: 'manager', compact: true },

  // ── Panels ported from the old Overview / Team Analytics screens ──
  approvals:       { title: 'Pending Approvals',  cat: 'Team',      icon: ClipboardList, size: { w: 8, h: 5 }, limits: { minW: 6, minH: 4, maxW: 12, maxH: 8 }, render: ApprovalsPanel,    minRole: 'manager' },
  'who-has-what':  { title: 'Who Has What',       cat: 'Team',      icon: HandCoins,     size: { w: 8, h: 5 }, limits: { minW: 5, minH: 4, maxW: 12, maxH: 8 }, render: WhoHasWhatPanel,   minRole: 'supervisor' },
  // Phone: the whole Time Admin lives in this tile, so it gets a real
  // screen's height in the stack instead of its board rows (Oct 14).
  'team-time':     { title: 'Team Time',          cat: 'Team',      icon: Timer,         size: { w: 12, h: 6 }, limits: { minW: 8, minH: 5, maxW: 12, maxH: 8 }, render: TeamTimePanel,     minRole: 'manager', phoneRowsWhen: () => 10 },
  // Phase 3 (Sep 25). Tickets is a supervisor module; the time-off list,
  // punch exceptions and purchases are manager-level on the server.
  // My Open Tickets (Neil, Oct 26 2026): the ticket desk's twin of the My
  // Open Tasks tile - a KPI tile with its metric fixed, for whoever can open
  // Tickets (administrators, or the tickets grant - the module is
  // grant-driven). The KPI Stat tile can pick the same metric.
  'my-tickets':        { title: 'My Open Tickets',   cat: 'Team', icon: TicketIcon,   size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: (p) => <KpiWidget {...p} config={{ ...(p.config || {}), metric: 'my_open_tickets' }} />, module: 'tickets', moduleLabel: 'Tickets', compact: true },
  'ticket-queue':      { title: 'My Ticket Queue',   cat: 'Team', icon: TicketIcon,   size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: TicketQueueWidget,      minRole: 'supervisor' },
  'time-exceptions':   { title: 'Time Exceptions',   cat: 'Team', icon: Timer,        size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: TimeExceptionsWidget,   minRole: 'manager' },
  'out-today':         { title: 'Out Today',         cat: 'Team', icon: UserMinus,    size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: OutTodayWidget,         minRole: 'manager' },
  'pending-purchases': { title: 'Pending Purchases', cat: 'Team', icon: ShoppingCart, size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: PendingPurchasesWidget, minRole: 'manager' },
  // Essentials (Oct 7): the five tiles the dashboard plan calls the daily
  // core. Not in DEFAULT_PERSONAL / ROLE_EXTRAS - people add them from the
  // gallery. The sample-data Portfolio widgets (Occupancy Trend, Facilities,
  // Tasks Overview) and the mocked Team analytics (Workload by Employee,
  // Project-Wise Tasks, Team Calendar) were removed the same day; a saved
  // layout that still carries one of those keys renders CustomDashboard's
  // "Unknown widget" card, never a crash.
  // Shown as "Action Required" since Oct 23 2026 (Neil): Tasks has its own
  // My Day list now. The key stays 'my-day' - saved boards point at it.
  'my-day':        { title: 'Action Required', aka: ['My Day'], cat: 'Workday', icon: Sun,        size: { w: 4, h: 5 }, limits: { minW: 3, minH: 4, maxW: 8, maxH: 8 },  render: MyDayWidget },
  'my-work':       { title: 'My Work',       cat: 'Workday', icon: Briefcase,  size: { w: 4, h: 5 }, limits: { minW: 3, minH: 4, maxW: 8, maxH: 8 },  render: MyWorkWidget },
  // My Time (Oct 8, Neil): the simple punch tile - status, Punch In / Out /
  // Start Break / End Break, today's hours; the card opens Workday for the
  // rest. `timeTracked`: only for people who are time-tracked - a salaried
  // (exempt) person never sees it placed or offered (see widgetHidden).
  'my-time':       { title: 'My Time',       cat: 'Workday', icon: Hourglass,  size: { w: 3, h: 3 }, limits: { minW: 3, minH: 3, maxW: 4, maxH: 4 },  render: MyTimeWidget, timeTracked: true },
  announcements:   { title: 'Announcements', cat: 'Live',    icon: Megaphone,  size: { w: 4, h: 5 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 8 },  render: AnnouncementsWidget },
  'my-team':       { title: 'My Team',       cat: 'Team',    icon: Users,      size: { w: 6, h: 5 }, limits: { minW: 4, minH: 4, maxW: 12, maxH: 8 }, render: MyTeamWidget, minRole: 'supervisor' },
  // Oct 1: a module-gated tile - `module` names the Access Group grant that
  // opens it (administrators bypass, same rule as the Accounting screen and
  // the backend's require_module_grant). No minRole: a Viewer-level grant is enough.
  'find-transaction': { title: 'Find a Transaction', cat: 'Accounting', icon: Search, size: { w: 4, h: 3 }, limits: { minW: 3, minH: 3, maxW: 6, maxH: 5 }, render: FindTransactionWidget, module: 'accounting', moduleLabel: 'Accounting' },
};

// May this person see (render, or pick from the gallery) a widget? Role level
// (can(minRole)) OR the 'manager-dashboard' grant for role-tiered tiles; a
// `module` tile asks the module grant instead (`moduleLevel`, default viewer).
// CustomDashboard.jsx reads this for both the grid and the Add Widget gallery.
export function widgetAllowed(def, { can, myGrantedModules, canAccessModule }) {
  if (def.module && !canAccessModule?.(def.module, 'administrator', def.moduleLevel || 'viewer')) return false;
  return !def.minRole || can(def.minRole) || !!myGrantedModules?.has('manager-dashboard');
}

// Is this widget simply not for this person - not a matter of access, but of
// relevance? A `timeTracked` tile (the punch clock) is nothing to a salaried,
// time-tracking-exempt person (Neil, Oct 8): it is left out of their grid
// (kept in the saved layout, so a shared view still carries it for the
// hourly people) and out of the gallery. Unknown (null) counts as tracked.
// `timeTrackedWhen(config)` is the same call for a tile whose relevance
// depends on how it is set up (an Action Tile set to the punch); without a
// config (the gallery asking about the type itself) it is never hidden.
// A `retired` tile is hidden from everyone, the same way: out of every grid
// and the gallery, never deleted from a saved layout.
export function widgetHidden(def, { timeTrackingExempt }, config) {
  if (def?.retired) return true;
  if (timeTrackingExempt !== true) return false;
  return !!def?.timeTracked || (!!config && !!def?.timeTrackedWhen?.(config));
}

// The gallery's size word for a tile's default footprint - the iOS widget
// vocabulary (Small / Medium / Large / Wide), not a w×h nobody can picture.
export function sizeLabel({ w, h } = {}) {
  if (w >= 8) return 'Wide';
  if (w <= 3 && h <= 2) return 'Small';
  if (w <= 4 && h <= 4) return 'Medium';
  return 'Large';
}

// Clamp a layout item to its widget's limits (also keeps it inside the 12-col grid).
// A widget's size bounds, with the config's say (a Quick Actions style
// changes them) - the one place the grid, the clamp and the config update
// ask. `limitsFor` in CustomDashboard and updateWidgetConfig read this too.
export function limitsOf(type, config) {
  const def = WIDGETS[type];
  return def?.limitsWhen?.(config) || def?.limits || {};
}
export function clampToLimits(it) {
  const lim = limitsOf(it.type, it.config);
  const w = Math.min(Math.max(it.w, lim.minW ?? 2), lim.maxW ?? 12);
  const h = Math.min(Math.max(it.h, lim.minH ?? 2), lim.maxH ?? 8);
  const x = Math.min(Math.max(0, it.x), 12 - w);
  const y = Math.max(0, it.y);
  return (w === it.w && h === it.h && x === it.x && y === it.y) ? it : { ...it, w, h, x, y };
}
