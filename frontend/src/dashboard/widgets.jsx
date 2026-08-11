import { useState, useEffect, lazy, Suspense } from 'react';
import { useMsal } from '@azure/msal-react';
import {
  ArrowRight, ArrowUpRight, BookOpen, CheckSquare, ChevronRight, ListTodo, Package, ShieldCheck, Bell, Clock, StickyNote,
  BarChart3, Layers, Zap, Users, ClipboardCheck, CalendarClock, ExternalLink, Boxes, X,
  ClipboardList, HandCoins, TrendingUp, Building2, FolderKanban, CalendarDays, Timer,
  CheckCheck, Trash2, Mail, CalendarPlus,
} from 'lucide-react';
import { formatTime } from '../lib/datetime';

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
const CA = (name, a = 0.12) => `hsla(var(--color-${name}),${a})`;

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
function StatCard({ label, value, color, Icon, nav, hint }) {
  const go = () => nav && navigate(nav.view, nav.sub);
  const I = Icon || BarChart3;
  return (
    <div className="dk-stat" onClick={nav ? go : undefined} role={nav ? 'button' : undefined}
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
  return <StatCard label={meta.label} value={kpis?.[config?.metric] ?? 0} color={meta.color} Icon={meta.Icon} nav={meta.nav} hint={meta.hint} />;
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', justifyContent: 'center' }}>
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
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, textAlign: 'center', cursor: 'pointer' }}>
      <div style={{ width: 46, height: 46, borderRadius: 13, background: CA(color), color: C(color), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Layers size={22} />
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)' }}>{labelFor(t)}</div>
      <div className="kpi-delta" style={{ color: C(color), fontWeight: 600 }}>Open <ArrowRight size={12} /></div>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%', justifyContent: 'center' }}>
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
  return (
    <div className="dash-card" onClick={() => navigate('timeclock')}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, cursor: 'pointer' }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>{greet}</div>
      <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-.02em', color: 'var(--ink)' }}>
        {formatTime(now)}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div className="kpi-delta" style={{ color: 'var(--wk-brand)', fontWeight: 600, marginTop: 8 }}><Clock size={12} /> Open Time Clock <ArrowRight size={12} /></div>
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
  'quick-actions': { title: 'Quick Actions', cat: 'Navigation', icon: Zap,         size: { w: 3, h: 4 }, limits: { minW: 3, minH: 2, maxW: 6, maxH: 5 }, render: QuickActionsWidget },
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
