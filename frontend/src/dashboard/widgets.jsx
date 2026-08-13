import { useState, useEffect, lazy, Suspense } from 'react';
import { useMsal } from '@azure/msal-react';
import {
  ArrowRight, ArrowUpRight, BookOpen, CheckSquare, ChevronRight, ListTodo, Package, ShieldCheck, Bell, Clock, StickyNote,
  BarChart3, Layers, Zap, Users, ClipboardCheck, CalendarClock, ExternalLink, Boxes, X,
  ClipboardList, HandCoins, TrendingUp, Building2, FolderKanban, CalendarDays, Timer,
  CheckCheck, Trash2, Mail, CalendarPlus, FolderOpen,
} from 'lucide-react';
import { formatTime } from '../lib/datetime';
import { api } from '../api';
import { LinkIcon } from '../components/LinkIcon.jsx';

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
const AgendaPanel       = lazyPanel('AgendaPanel');

// Fire the app's cross-view navigation event (see CLAUDE.md).
export function navigate(view, sub) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub || null } }));
}

const C = (name) => `hsl(var(--color-${name}))`;

// Every KPI the /dashboards/kpis endpoint can return, with how to present it.
export const KPI_CATALOG = {
  open_tasks:           { label: 'Open Tasks',              color: 'blue',   Icon: ListTodo,      hint: 'Across your team',     nav: { view: 'tasks' } },
  my_open_tasks:        { label: 'My Open Tasks',           color: 'blue',   Icon: ListTodo,      hint: 'Assigned to you',      nav: { view: 'tasks' } },
  pending_requisitions: { label: 'Requisitions to Approve', color: 'orange', Icon: ClipboardCheck, hint: 'Awaiting approval',   nav: { view: 'manager-dashboard' } },
  pending_inventory:    { label: 'Inventory Requests',      color: 'orange', Icon: Package,       hint: 'Awaiting approval',    nav: { view: 'manager-dashboard' } },
  open_purchases:       { label: 'Open Purchases',          color: 'purple', Icon: Package,       hint: 'In progress',          nav: { view: 'purchase' } },
  my_checkouts:         { label: 'My Active Checkouts',     color: 'green',  Icon: Boxes,         hint: 'Currently with you',   nav: { view: 'inventory', sub: 'checkouts' } },
  my_assignments:       { label: 'Items Assigned to Me',    color: 'green',  Icon: Package,       hint: 'Your equipment',       nav: { view: 'inventory' } },
  unread_notifications: { label: 'Unread Notifications',    color: 'blue',   Icon: Bell,          hint: 'Tap to review' },
  warranties_expiring:  { label: 'Warranties Expiring',     color: 'red',    Icon: ShieldCheck,   hint: 'Within 60 days',       nav: { view: 'property-asset' } },
  clocked_in_now:       { label: 'Clocked In Now',          color: 'green',  Icon: Users,         hint: 'On the clock now',     nav: { view: 'manager-dashboard' } },
  time_off_pending:     { label: 'Time Off to Review',      color: 'orange', Icon: CalendarClock, hint: 'Awaiting your review',  nav: { view: 'manager-dashboard' } },
};

// Curated shortcut destinations for the picker (module + optional sub-screen).
export const SHORTCUT_TARGETS = [
  { view: 'timeclock',        label: 'Time Clock' },
  { view: 'myhr',             label: 'My HR' },
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
  { view: 'manager-dashboard', label: 'Manager Dashboard' },
  { view: 'external-links',   label: 'External Links' },
  { view: 'support',          label: 'Support' },
];

const labelFor = (t) => SHORTCUT_TARGETS.find(s => s.view === t.view && (s.sub || '') === (t.sub || ''))?.label
  || t.label || t.view;

// ── Native card shells (match the Overview screen exactly) ────────────────────
function DashCard({ title, sub, action, children, onClick, style }) {
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
function StatCard({ label, value, color, Icon, nav, hint, hero }) {
  const go = () => nav && navigate(nav.view, nav.sub);
  const I = Icon || BarChart3;
  return (
    <div className={`dk-stat${hero ? ' dk-stat--hero' : ''}`} onClick={nav ? go : undefined} role={nav ? 'button' : undefined}
      style={{ height: '100%', boxSizing: 'border-box', cursor: nav ? 'pointer' : 'default', justifyContent: 'center' }}>
      <span className="dk-stat-top">
        <span className={`dk-chip dk-chip--${color}`}><I /></span>
        {nav && <ArrowUpRight size={15} className="dk-stat-arrow" />}
      </span>
      <span className="dk-stat-num">{value}</span>
      <span className="dk-stat-label">{label}</span>
      {hint && <span className="dk-stat-sub">{hint}</span>}
    </div>
  );
}

// ── Widgets ───────────────────────────────────────────────────────────────────
function KpiWidget({ config, kpis }) {
  const meta = KPI_CATALOG[config?.metric] || { label: 'Metric', color: 'blue', Icon: BarChart3 };
  return <StatCard label={meta.label} value={kpis?.[config?.metric] ?? 0} color={meta.color} Icon={meta.Icon} nav={meta.nav} hint={meta.hint} hero={!!config?.hero} />;
}

function TeamStatWidget({ config, kpis }) {
  const meta = KPI_CATALOG[config?.metric] || { label: config?.metric, color: 'green', Icon: Users };
  return <StatCard label={meta.label} value={kpis?.[config?.metric] ?? 0} color={meta.color} Icon={meta.Icon} nav={meta.nav} hint={meta.hint} />;
}

function KpiBarWidget({ config, kpis }) {
  const metrics = config?.metrics?.length ? config.metrics
    : ['open_tasks', 'pending_requisitions', 'my_checkouts', 'warranties_expiring'];
  const rows = metrics.map(m => ({ m, v: kpis?.[m] ?? 0, meta: KPI_CATALOG[m] || { label: m, color: 'blue' } }));
  const max = Math.max(1, ...rows.map(r => r.v));
  return (
    <DashCard title="At a Glance">
      {/* Top-aligned, natural height - height:100% + justify center inside the
          card's scroll container CLIPPED the first rows whenever content ran
          taller than the card (flexbox centers overflow off the top, where
          scrolling can't reach). Same fix in Quick Actions. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map(r => (
          <div key={r.m} onClick={() => r.meta.nav && navigate(r.meta.nav.view, r.meta.nav.sub)} style={{ cursor: r.meta.nav ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
              <span style={{ color: 'var(--muted)', fontWeight: 600 }}>{r.meta.label}</span>
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{r.v}</strong>
            </div>
            <div style={{ height: 7, background: 'var(--mist)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ width: `${(r.v / max) * 100}%`, height: '100%', background: C(r.meta.color), borderRadius: 99 }} />
            </div>
          </div>
        ))}
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
function LinksFolderTile({ link, color, onOpen }) {
  return (
    <div
      className="app-tile" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title={link.name}
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
function LinksFolderWidget({ config }) {
  const [state, setState] = useState({ loading: true, folder: null, links: [] });
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
        <div className="app-grid" style={{ gap: '14px 10px' }}>
          {state.links.map(l => (
            <LinksFolderTile key={l.id} link={l} onOpen={() => open(l)}
              color={config.itemType === 'personal' ? PERSONAL_TILE_COLOR : colorForLinkCategory(l.category)} />
          ))}
        </div>
      )}
    </DashCard>
  );
}

// Two kinds of action: `act` opens a composer that creates the thing in place
// (an Outlook mail/event via Graph, or the Tasks module's own create modal),
// everything else navigates to a screen the way this widget always has.
const ACTIONS = [
  { label: 'New Task',        act: 'task',                       color: 'blue',   Icon: CheckSquare },
  { label: 'New Event',       act: 'event',                      color: 'purple', Icon: CalendarPlus },
  { label: 'New Email',       act: 'email',                      color: 'brand',  Icon: Mail },
  { label: 'Request an Item', view: 'inventory', sub: 'catalog', color: 'orange', Icon: Package },
  { label: 'Time Clock',      view: 'timeclock',                 color: 'green',  Icon: Clock },
  { label: 'Knowledge Base',  view: 'sop',                       color: 'brand',  Icon: BookOpen },
];
function QuickActionsWidget() {
  const [modal, setModal] = useState(null);
  const [note, setNote] = useState('');
  // Composers report whether Graph sent it or Outlook took over, so the card
  // can say which actually happened instead of a blanket "Done".
  const close = (res) => {
    setModal(null);
    if (res?.toast) { setNote(res.toast); setTimeout(() => setNote(''), 4000); }
  };
  // Same row anatomy as DeskHome's quick actions - icon chip, label, chevron.
  return (
    <DashCard title="Quick Actions" sub={note || undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {ACTIONS.map(a => (
          <button key={a.label} className="dk-key"
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
// target: undefined = both dashboards; minRole gates the gallery.
// limits bound how far each widget can be resized - enforced during drag AND
// re-applied to saved layouts on load, so a stat tile can never balloon.
const STAT_LIMITS = { minW: 2, minH: 2, maxW: 4, maxH: 3 };
export const WIDGETS = {
  kpi:           { title: 'KPI Stat',        cat: 'Metrics',   icon: BarChart3,    size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: KpiWidget,          configurable: 'kpi' },
  'kpi-bar':     { title: 'KPI Bar Chart',   cat: 'Metrics',   icon: BarChart3,    size: { w: 4, h: 3 }, limits: { minW: 3, minH: 3, maxW: 6, maxH: 5 }, render: KpiBarWidget },
  shortcut:      { title: 'Shortcut Tile',   cat: 'Navigation', icon: Layers,      size: { w: 3, h: 2 }, limits: STAT_LIMITS, render: ShortcutWidget,     configurable: 'shortcut' },
  links:         { title: 'Quick Links',     cat: 'Navigation', icon: ExternalLink, size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 4, maxH: 6 }, render: LinksWidget },
  'links-folder': { title: 'Links Folder',   cat: 'Navigation', icon: FolderOpen,  size: { w: 3, h: 4 }, limits: { minW: 2, minH: 3, maxW: 4, maxH: 6 }, render: LinksFolderWidget, configurable: 'links-folder' },
  'quick-actions': { title: 'Quick Actions', cat: 'Navigation', icon: Zap,         size: { w: 3, h: 4 }, limits: { minW: 3, minH: 2, maxW: 6, maxH: 6 }, render: QuickActionsWidget },
  notifications: { title: 'Notifications',   cat: 'Live',      icon: Bell,         size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 6 }, render: NotificationsWidget },
  agenda:        { title: 'My Agenda',       cat: 'Live',      icon: CalendarDays, size: { w: 4, h: 4 }, limits: { minW: 3, minH: 3, maxW: 8, maxH: 7 }, render: AgendaPanel },
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
