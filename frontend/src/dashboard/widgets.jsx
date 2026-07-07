import { useState, useEffect } from 'react';
import {
  ArrowRight, ListTodo, Package, ShieldCheck, Bell, Clock, StickyNote,
  BarChart3, Layers, Zap, Users, ClipboardCheck, CalendarClock, ExternalLink,
} from 'lucide-react';

// Fire the app's cross-view navigation event (see CLAUDE.md).
export function navigate(view, sub) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub: sub || null } }));
}

const C = (name) => `hsl(var(--color-${name}))`;
const CA = (name, a = 0.12) => `hsla(var(--color-${name}),${a})`;

// Every KPI the /dashboards/kpis endpoint can return, with how to present it.
export const KPI_CATALOG = {
  open_tasks:           { label: 'Open tasks',              color: 'blue',   nav: { view: 'tasks' } },
  my_open_tasks:        { label: 'My open tasks',           color: 'blue',   nav: { view: 'tasks' } },
  pending_requisitions: { label: 'Requisitions to approve', color: 'orange', nav: { view: 'manager-dashboard', sub: 'actions' } },
  pending_inventory:    { label: 'Inventory requests',      color: 'orange', nav: { view: 'manager-dashboard', sub: 'actions' } },
  open_purchases:       { label: 'Open purchases',          color: 'purple', nav: { view: 'inventory' } },
  my_checkouts:         { label: 'My active checkouts',     color: 'green',  nav: { view: 'inventory', sub: 'my-requests' } },
  my_assignments:       { label: 'Items assigned to me',    color: 'green',  nav: { view: 'inventory' } },
  unread_notifications: { label: 'Unread notifications',    color: 'blue' },
  warranties_expiring:  { label: 'Warranties expiring',     color: 'red',    nav: { view: 'property-asset' } },
  clocked_in_now:       { label: 'Clocked in now',          color: 'green',  nav: { view: 'manager-dashboard', sub: 'team-time' } },
  time_off_pending:     { label: 'Time off to review',      color: 'orange', nav: { view: 'manager-dashboard', sub: 'team-time' } },
};

// Curated shortcut destinations for the picker (module + optional sub-screen).
export const SHORTCUT_TARGETS = [
  { view: 'timeclock',        label: 'Time Clock' },
  { view: 'tasks',            label: 'Tasks' },
  { view: 'inventory',        label: 'Item Management' },
  { view: 'inventory', sub: 'checkouts',   label: 'Item Management · Checkouts' },
  { view: 'inventory', sub: 'my-requests', label: 'Item Management · My Requests' },
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

// ── Small building blocks ─────────────────────────────────────────────────────
const Pad = ({ children, onClick, style }) => (
  <div onClick={onClick} style={{ padding: 16, height: '100%', boxSizing: 'border-box',
    cursor: onClick ? 'pointer' : 'default', display: 'flex', flexDirection: 'column', ...style }}>
    {children}
  </div>
);

function KpiWidget({ config, kpis }) {
  const meta = KPI_CATALOG[config?.metric] || { label: 'Metric', color: 'blue' };
  const value = kpis?.[config?.metric] ?? 0;
  const go = () => meta.nav && navigate(meta.nav.view, meta.nav.sub);
  return (
    <Pad onClick={meta.nav ? go : undefined} style={{ justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{meta.label}</span>
        <div style={{ width: 30, height: 30, borderRadius: 9, background: CA(meta.color), display: 'flex', alignItems: 'center', justifyContent: 'center', color: C(meta.color) }}>
          <BarChart3 size={16} />
        </div>
      </div>
      <div>
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-.02em', color: 'var(--ink)', lineHeight: 1 }}>{value}</div>
        {meta.nav && <div style={{ fontSize: 12, color: C(meta.color), fontWeight: 600, marginTop: 6, display: 'flex', alignItems: 'center', gap: 3 }}>Open <ArrowRight size={12} /></div>}
      </div>
    </Pad>
  );
}

function KpiBarWidget({ config, kpis }) {
  const metrics = config?.metrics?.length ? config.metrics
    : ['open_tasks', 'pending_requisitions', 'my_checkouts', 'warranties_expiring'];
  const rows = metrics.map(m => ({ m, v: kpis?.[m] ?? 0, meta: KPI_CATALOG[m] || { label: m, color: 'blue' } }));
  const max = Math.max(1, ...rows.map(r => r.v));
  return (
    <Pad>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>At a glance</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, justifyContent: 'center' }}>
        {rows.map(r => (
          <div key={r.m} onClick={() => r.meta.nav && navigate(r.meta.nav.view, r.meta.nav.sub)} style={{ cursor: r.meta.nav ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
              <span style={{ color: 'var(--muted)' }}>{r.meta.label}</span>
              <strong>{r.v}</strong>
            </div>
            <div style={{ height: 6, background: 'var(--mist)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${(r.v / max) * 100}%`, height: '100%', background: C(r.meta.color), borderRadius: 3 }} />
            </div>
          </div>
        ))}
      </div>
    </Pad>
  );
}

function ShortcutWidget({ config }) {
  const t = config || SHORTCUT_TARGETS[0];
  return (
    <Pad onClick={() => navigate(t.view, t.sub)} style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center', gap: 10, background: CA(t.color || 'blue', 0.06) }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, background: CA(t.color || 'blue'), color: C(t.color || 'blue'), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Layers size={22} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 700 }}>{labelFor(t)}</div>
      <div style={{ fontSize: 11.5, color: C(t.color || 'blue'), fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>Open <ArrowRight size={12} /></div>
    </Pad>
  );
}

function LinksWidget({ config }) {
  const items = config?.items?.length ? config.items : SHORTCUT_TARGETS.slice(0, 6);
  return (
    <Pad style={{ padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 4px 10px' }}>{config?.title || 'Quick links'}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto' }}>
        {items.map((t, i) => (
          <button key={i} onClick={() => navigate(t.view, t.sub)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', border: 'none', background: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontSize: 13, color: 'var(--ink)', fontFamily: 'Inter,sans-serif' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}>
            <ArrowRight size={13} style={{ color: 'var(--muted)' }} /> {labelFor(t)}
          </button>
        ))}
      </div>
    </Pad>
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
    <Pad style={{ padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 4px 10px' }}>Quick actions</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, flex: 1 }}>
        {ACTIONS.map(a => (
          <button key={a.label} onClick={() => navigate(a.view, a.sub)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: 4, padding: 12, border: '1px solid var(--line)', borderRadius: 10, background: CA(a.color, 0.06), cursor: 'pointer', fontFamily: 'Inter,sans-serif' }}>
            <Zap size={15} style={{ color: C(a.color) }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>{a.label}</span>
          </button>
        ))}
      </div>
    </Pad>
  );
}

function NotificationsWidget({ notifications }) {
  const list = (notifications || []).slice(0, 6);
  return (
    <Pad style={{ padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 4px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Bell size={14} /> Notifications
      </div>
      {list.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '20px 4px', textAlign: 'center' }}>You're all caught up.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto' }}>
          {list.map((n, i) => {
            const act = n.action || {};
            return (
              <div key={n.id || i} onClick={() => act.view && navigate(act.view, act.sub)} style={{ padding: '8px 10px', borderRadius: 8, cursor: act.view ? 'pointer' : 'default' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>{n.title || 'Notification'}</div>
                {n.body && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</div>}
              </div>
            );
          })}
        </div>
      )}
    </Pad>
  );
}

function NotesWidget({ config, updateConfig }) {
  const [text, setText] = useState(config?.text || '');
  useEffect(() => { setText(config?.text || ''); }, [config?.text]);
  return (
    <Pad style={{ padding: 12, background: CA('orange', 0.05) }}>
      <div style={{ fontSize: 13, fontWeight: 700, margin: '4px 4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <StickyNote size={14} style={{ color: C('orange') }} /> Notes
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} onBlur={() => updateConfig({ text })}
        placeholder="Jot something down…"
        style={{ flex: 1, width: '100%', resize: 'none', border: 'none', background: 'transparent', outline: 'none', fontFamily: 'Inter,sans-serif', fontSize: 13, color: 'var(--ink)', lineHeight: 1.5 }} />
    </Pad>
  );
}

function ClockWidget() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000 * 30); return () => clearInterval(t); }, []);
  const hh = now.getHours();
  const greet = hh < 12 ? 'Good morning' : hh < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <Pad onClick={() => navigate('timeclock')} style={{ justifyContent: 'center', gap: 4, background: CA('blue', 0.05) }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}>{greet}</div>
      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em', color: 'var(--ink)' }}>
        {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div style={{ fontSize: 11.5, color: C('blue'), fontWeight: 600, marginTop: 6, display: 'flex', alignItems: 'center', gap: 3 }}>
        <Clock size={12} /> Open Time Clock <ArrowRight size={12} />
      </div>
    </Pad>
  );
}

function TeamStatWidget({ config, kpis }) {
  const metric = config?.metric || 'clocked_in_now';
  const meta = KPI_CATALOG[metric] || { label: metric, color: 'green' };
  const Icon = metric === 'clocked_in_now' ? Users : ClipboardCheck;
  return (
    <Pad onClick={() => meta.nav && navigate(meta.nav.view, meta.nav.sub)} style={{ justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{meta.label}</span>
        <div style={{ width: 30, height: 30, borderRadius: 9, background: CA(meta.color), display: 'flex', alignItems: 'center', justifyContent: 'center', color: C(meta.color) }}><Icon size={16} /></div>
      </div>
      <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--ink)', lineHeight: 1 }}>{kpis?.[metric] ?? 0}</div>
      <div style={{ fontSize: 12, color: C(meta.color), fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>View team <ArrowRight size={12} /></div>
    </Pad>
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
