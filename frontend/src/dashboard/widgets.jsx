import { useState, useEffect } from 'react';
import {
  ArrowRight, ListTodo, Package, ShieldCheck, Bell, Clock, StickyNote,
  BarChart3, Layers, Zap, Users, ClipboardCheck, CalendarClock, ExternalLink, Boxes,
} from 'lucide-react';

// Fire the app's cross-view navigation event (see CLAUDE.md).
export function navigate(view, sub) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub || null } }));
}

const C = (name) => `hsl(var(--color-${name}))`;
const CA = (name, a = 0.12) => `hsla(var(--color-${name}),${a})`;

// Every KPI the /dashboards/kpis endpoint can return, with how to present it.
export const KPI_CATALOG = {
  open_tasks:           { label: 'Open tasks',              color: 'blue',   Icon: ListTodo,      hint: 'Across your team',     nav: { view: 'tasks' } },
  my_open_tasks:        { label: 'My open tasks',           color: 'blue',   Icon: ListTodo,      hint: 'Assigned to you',      nav: { view: 'tasks' } },
  pending_requisitions: { label: 'Requisitions to approve', color: 'orange', Icon: ClipboardCheck, hint: 'Awaiting approval',   nav: { view: 'manager-dashboard', sub: 'actions' } },
  pending_inventory:    { label: 'Inventory requests',      color: 'orange', Icon: Package,       hint: 'Awaiting approval',    nav: { view: 'manager-dashboard', sub: 'actions' } },
  open_purchases:       { label: 'Open purchases',          color: 'purple', Icon: Package,       hint: 'In progress',          nav: { view: 'purchase' } },
  my_checkouts:         { label: 'My active checkouts',     color: 'green',  Icon: Boxes,         hint: 'Currently with you',   nav: { view: 'inventory', sub: 'checkouts' } },
  my_assignments:       { label: 'Items assigned to me',    color: 'green',  Icon: Package,       hint: 'Your equipment',       nav: { view: 'inventory' } },
  unread_notifications: { label: 'Unread notifications',    color: 'blue',   Icon: Bell,          hint: 'Tap to review' },
  warranties_expiring:  { label: 'Warranties expiring',     color: 'red',    Icon: ShieldCheck,   hint: 'Within 60 days',       nav: { view: 'property-asset' } },
  clocked_in_now:       { label: 'Clocked in now',          color: 'green',  Icon: Users,         hint: 'On the clock now',     nav: { view: 'manager-dashboard', sub: 'team-time' } },
  time_off_pending:     { label: 'Time off to review',      color: 'orange', Icon: CalendarClock, hint: 'Awaiting your review',  nav: { view: 'manager-dashboard', sub: 'team-time' } },
};

// Curated shortcut destinations for the picker (module + optional sub-screen).
export const SHORTCUT_TARGETS = [
  { view: 'timeclock',        label: 'Time Clock' },
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

function StatCard({ label, value, color, Icon, nav, hint }) {
  const go = () => nav && navigate(nav.view, nav.sub);
  const I = Icon || BarChart3;
  return (
    <div className="kpi-card kpi-hover" onClick={nav ? go : undefined}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', cursor: nav ? 'pointer' : 'default', position: 'relative', overflow: 'hidden' }}>
      {/* soft corner accent for depth */}
      <div style={{ position: 'absolute', top: -34, right: -34, width: 120, height: 120, borderRadius: '50%', background: CA(color, 0.09), pointerEvents: 'none' }} />
      <div className="kpi-card-header" style={{ marginBottom: 0, position: 'relative' }}>
        <span className="kpi-label">{label}</span>
        <div className="kpi-icon-container" style={{ width: 38, height: 38, borderRadius: 11, background: CA(color, 0.15), color: C(color) }}><I size={18} /></div>
      </div>
      <div className="kpi-value" style={{ fontSize: 36, lineHeight: 1, margin: '16px 0 6px', position: 'relative' }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, position: 'relative' }}>
        {hint && <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>{hint}</span>}
        {nav && <span style={{ fontSize: 12, color: C(color), fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>Open <ArrowRight size={12} /></span>}
      </div>
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
    <DashCard title="At a glance">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', justifyContent: 'center' }}>
        {rows.map(r => (
          <div key={r.m} onClick={() => r.meta.nav && navigate(r.meta.nav.view, r.meta.nav.sub)} style={{ cursor: r.meta.nav ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
              <span style={{ color: 'var(--muted)' }}>{r.meta.label}</span>
              <strong>{r.v}</strong>
            </div>
            <div style={{ height: 6, background: 'var(--mist)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${(r.v / max) * 100}%`, height: '100%', background: C(r.meta.color), borderRadius: 3, transition: 'width 0.4s' }} />
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
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 8px', border: 'none', background: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontSize: 13.5, color: 'var(--ink)', fontFamily: 'Inter,sans-serif', width: '100%' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
      <ArrowRight size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} /> {labelFor(t)}
    </button>
  );
}

function LinksWidget({ config }) {
  const items = config?.items?.length ? config.items : SHORTCUT_TARGETS.slice(0, 6);
  return (
    <DashCard title={config?.title || 'Quick links'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {items.map((t, i) => <LinkRow key={i} t={t} onClick={() => navigate(t.view, t.sub)} />)}
      </div>
    </DashCard>
  );
}

const ACTIONS = [
  { label: 'Request an item', view: 'inventory', sub: 'catalog', color: 'blue' },
  { label: 'New task',        view: 'tasks',                    color: 'green' },
  { label: 'Time Clock',      view: 'timeclock',                color: 'orange' },
  { label: 'Knowledge Base',  view: 'sop',                      color: 'purple' },
];
function QuickActionsWidget() {
  return (
    <DashCard title="Quick actions">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, height: '100%' }}>
        {ACTIONS.map(a => (
          <button key={a.label} onClick={() => navigate(a.view, a.sub)}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: 6, padding: 14, border: '1px solid var(--line)', borderRadius: 12, background: CA(a.color, 0.06), cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            <div style={{ width: 30, height: 30, borderRadius: 9, background: CA(a.color), color: C(a.color), display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Zap size={15} /></div>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{a.label}</span>
          </button>
        ))}
      </div>
    </DashCard>
  );
}

function NotificationsWidget({ notifications }) {
  const list = (notifications || []).slice(0, 8);
  return (
    <DashCard title="Notifications" action={<Bell size={15} style={{ color: 'var(--muted)' }} />}>
      {list.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '24px 4px', textAlign: 'center' }}>You're all caught up.</div>
      ) : (
        <div>
          {list.map((n, i) => {
            const act = n.action || {};
            return (
              <div key={n.id || i} className="task-row" onClick={() => act.view && navigate(act.view, act.sub)}
                style={{ cursor: act.view ? 'pointer' : 'default', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="task-title">{n.title || 'Notification'}</div>
                  {n.body && <div className="task-dept" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.body}</div>}
                </div>
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
        style={{ width: '100%', height: '100%', minHeight: 60, resize: 'none', border: 'none', background: 'transparent', outline: 'none', fontFamily: 'Inter,sans-serif', fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.6 }} />
    </DashCard>
  );
}

function ClockWidget() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000 * 20); return () => clearInterval(t); }, []);
  const hh = now.getHours();
  const greet = hh < 12 ? 'Good morning' : hh < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="dash-card" onClick={() => navigate('timeclock')}
      style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, cursor: 'pointer' }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>{greet}</div>
      <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-.02em', color: 'var(--ink)' }}>
        {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div className="kpi-delta" style={{ color: C('blue'), fontWeight: 600, marginTop: 8 }}><Clock size={12} /> Open Time Clock <ArrowRight size={12} /></div>
    </div>
  );
}

// ── Registry ──────────────────────────────────────────────────────────────────
// target: undefined = both dashboards; minRole gates the gallery.
export const WIDGETS = {
  kpi:           { title: 'KPI stat',        cat: 'Metrics',   icon: BarChart3,    size: { w: 3, h: 2 }, render: KpiWidget,          configurable: 'kpi' },
  'kpi-bar':     { title: 'KPI bar chart',   cat: 'Metrics',   icon: BarChart3,    size: { w: 4, h: 3 }, render: KpiBarWidget },
  shortcut:      { title: 'Shortcut tile',   cat: 'Navigation', icon: Layers,      size: { w: 3, h: 2 }, render: ShortcutWidget,     configurable: 'shortcut' },
  links:         { title: 'Quick links',     cat: 'Navigation', icon: ExternalLink, size: { w: 3, h: 4 }, render: LinksWidget },
  'quick-actions': { title: 'Quick actions', cat: 'Navigation', icon: Zap,         size: { w: 3, h: 3 }, render: QuickActionsWidget },
  notifications: { title: 'Notifications',   cat: 'Live',      icon: Bell,         size: { w: 4, h: 4 }, render: NotificationsWidget },
  clock:         { title: 'Clock & greeting', cat: 'Utility',  icon: Clock,        size: { w: 3, h: 3 }, render: ClockWidget },
  notes:         { title: 'Notes',           cat: 'Utility',   icon: StickyNote,   size: { w: 3, h: 3 }, render: NotesWidget },
  'team-attendance': { title: 'Team clocked-in', cat: 'Team',  icon: Users,        size: { w: 3, h: 2 }, render: (p) => <TeamStatWidget {...p} config={{ metric: 'clocked_in_now' }} />, minRole: 'supervisor' },
  'team-approvals':  { title: 'Team approvals',  cat: 'Team',  icon: ClipboardCheck, size: { w: 3, h: 2 }, render: (p) => <TeamStatWidget {...p} config={{ metric: 'pending_requisitions' }} />, minRole: 'manager' },
  'time-off':        { title: 'Time off to review', cat: 'Team', icon: CalendarClock, size: { w: 3, h: 2 }, render: (p) => <TeamStatWidget {...p} config={{ metric: 'time_off_pending' }} />, minRole: 'manager' },
};
