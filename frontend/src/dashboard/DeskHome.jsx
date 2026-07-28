/*
THESIS: the home screen reads like a premium work OS (canon, owner-pinned:
monday.com-grade) — a personal command center, not a grid of identical
widgets.
OWN-WORLD: white cards on #f6f7fb, Figtree type, brand #2b45e1 (Stella cobalt), colored icon
chips carrying meaning, soft shadows, friendly copy. Light always.
STORY: an employee reads their day in five seconds — greeting, session chip,
four numbers, the "needs your attention" list — then acts.
FIRST VIEWPORT: greeting + session/timezone meta → four stat cards → attention
queue (left) + team pulse / quick actions (right). Primary action = top queue
row.
FORM: category standard played straight at full fidelity (user's canon call,
Jul 28); craft bar monday.com.
*/
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import {
  ArrowUpRight, BookOpen, CheckCircle2, CheckSquare, ChevronRight,
  Clock, Package, PenLine, Users,
} from 'lucide-react';
import { useRole } from '../contexts/RoleContext';
import { api } from '../api';

const reduceMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

const navTo = (view, sub) =>
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view, sub } }));

// One shared 1-second heartbeat: timezone meta + the session timer.
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useCountUp(target, ms = 650) {
  const [val, setVal] = useState(reduceMotion() ? target : 0);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || reduceMotion() || !target) { setVal(target ?? 0); return; }
    done.current = true;                     // count up once, never re-tick
    let raf; const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      setVal(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return val;
}

const fmtZone = (d, tz) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(d);

const fmtElapsed = (secs) => {
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
};

const timeAgo = (ts) => {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

function Stat({ i, label, value, sub, chip, Icon, onGo, hero }) {
  const n = useCountUp(value ?? 0);
  return (
    <button className={`dk-stat dk-rise${hero ? ' dk-stat--hero' : ''}`} style={{ '--i': i }} onClick={onGo}>
      <span className="dk-stat-top">
        <span className={`dk-chip dk-chip--${chip}`}><Icon /></span>
        <ArrowUpRight size={15} className="dk-stat-arrow" />
      </span>
      <span className="dk-stat-num">{n}</span>
      <span className="dk-stat-label">{label}</span>
      <span className="dk-stat-sub">{sub}</span>
    </button>
  );
}

export default function DeskHome({ kpis = {}, notifications = [], markRead }) {
  const { accounts } = useMsal();
  const { can } = useRole();
  const now = useNow();
  const firstName = (accounts[0]?.name ?? 'there').split(' ')[0];

  // Live extras: session state, pending signatures, team KPIs (managers).
  // All read-only, all existing endpoints, all safe to fail quietly.
  const [status, setStatus] = useState(null);
  const [sigs, setSigs] = useState([]);
  const [teamKpis, setTeamKpis] = useState(null);
  useEffect(() => {
    api.timeStatus().then(setStatus).catch(() => {});
    api.mySignatures().then(r => setSigs(Array.isArray(r) ? r : (r?.requests || r?.items || []))).catch(() => {});
    if (can('supervisor')) api.dashKpis('team').then(r => setTeamKpis(r?.kpis || null)).catch(() => {});
  }, [can]);

  const last = status?.lastPunch;
  const clockedIn = !!(last && last.kind !== 'out');
  const elapsed = clockedIn && last?.at
    ? Math.max(0, Math.floor((now.getTime() - new Date(last.at + 'Z').getTime()) / 1000))
    : 0;

  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dateLine = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(now);

  const unread = notifications.filter(n => !n.read);
  const actionable = unread.filter(n => n.action && !n.actioned).slice(0, 6);
  const pendingSigs = sigs.length;

  // "Needs your attention": signatures first (hard blockers), then actionable
  // unread notifications.
  const queue = useMemo(() => {
    const rows = [];
    sigs.slice(0, 3).forEach(s => rows.push({
      key: `sig-${s.id ?? s.packet_id ?? Math.random()}`,
      pill: 'Sign', tone: 'green',
      title: s.title || s.name || s.document_title || 'Document awaiting your signature',
      sub: 'E-sign · waiting on you',
      time: timeAgo(s.created_at || s.requested_at),
      go: () => navTo('myhr'),
    }));
    actionable.forEach(n => rows.push({
      key: `ntf-${n.id}`,
      pill: /approv|request/i.test(`${n.type} ${n.title}`) ? 'Approve'
        : /overdue|return/i.test(`${n.type} ${n.title}`) ? 'Overdue'
        : 'Review',
      tone: /overdue|reject|urgent|alert/i.test(`${n.type} ${n.title}`) ? 'red'
        : /approv|request/i.test(`${n.type} ${n.title}`) ? 'orange'
        : 'blue',
      title: n.title || 'Notification',
      sub: n.body || '',
      time: timeAgo(n.timestamp),
      go: () => { markRead?.(n.id); if (n.action?.view) navTo(n.action.view, n.action.sub); },
    }));
    return rows.slice(0, 7);
  }, [sigs, actionable, markRead]);

  const summary = queue.length > 0
    ? <>You have <b>{queue.length} item{queue.length === 1 ? '' : 's'}</b> that need your attention today.</>
    : <>You're all caught up.</>;

  const stats = [
    { label: 'Open tasks', value: kpis.my_open_tasks, sub: 'Assigned to you', chip: 'blue', Icon: CheckSquare, go: () => navTo('tasks'), hero: true },
    { label: 'Checked-out items', value: kpis.my_checkouts, sub: 'With you right now', chip: 'orange', Icon: Package, go: () => navTo('inventory', 'checkouts') },
    { label: 'My equipment', value: kpis.my_assignments, sub: 'Permanently assigned', chip: 'brand', Icon: Users, go: () => navTo('inventory') },
    { label: 'Signatures needed', value: pendingSigs, sub: 'Waiting on you', chip: 'green', Icon: PenLine, go: () => navTo('myhr') },
  ];

  return (
    <div className="dk-home">
      {/* ── Greeting + session ── */}
      <div className="dk-head dk-rise" style={{ '--i': 0 }}>
        <div className="dk-head-left">
          <h1>{greeting}, {firstName}!</h1>
          <div className="dk-head-sub">{dateLine} · {summary}</div>
        </div>
        <div className="dk-head-right">
          <button
            className={`dk-session-chip${clockedIn ? ' dk-session-chip--on' : ''}`}
            onClick={() => navTo('timeclock')}
            title="Open time clock"
          >
            <span className={`dk-dot ${clockedIn ? 'dk-dot--up' : 'dk-dot--off'}`} />
            {clockedIn ? <>Clocked in · <b>{fmtElapsed(elapsed)}</b></> : 'Clocked out · Open time clock'}
          </button>
          <div className="dk-zones">
            <span>New York <b>{fmtZone(now, 'America/New_York')}</b></span>
            <span className="dk-zone-sep" />
            <span>Mumbai <b>{fmtZone(now, 'Asia/Kolkata')}</b></span>
          </div>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div className="dk-board">
        {stats.map((s, i) => (
          <Stat key={s.label} i={1 + i} {...s} onGo={s.go} hero={s.hero} />
        ))}
      </div>

      {/* ── Attention queue + rail ── */}
      <div className="dk-main">
        <div className="dk-card dk-queue dk-rise" style={{ '--i': 5 }}>
          <div className="dk-pane-head">
            Needs your attention
            {queue.length > 0 && <span className="dk-count">{queue.length}</span>}
            <span className="dk-meta">newest first</span>
          </div>
          {queue.length === 0 ? (
            <div className="dk-clear">
              <span className="dk-clear-icon"><CheckCircle2 size={22} /></span>
              <h3>You're all caught up</h3>
              <p>New approvals, signatures, and alerts will land here as they come in.</p>
            </div>
          ) : (
            queue.map(row => (
              <button key={row.key} className="dk-queue-row" onClick={row.go}>
                <span className={`dk-pill dk-pill--${row.tone}`}>{row.pill}</span>
                <span className="dk-queue-body">
                  <span className="dk-queue-title">{row.title}</span>
                  {row.sub && <span className="dk-queue-sub">{row.sub}</span>}
                </span>
                {row.time && <span className="dk-queue-time">{row.time}</span>}
                <ChevronRight size={15} />
              </button>
            ))
          )}
        </div>

        <div className="dk-rail">
          {can('supervisor') && teamKpis && (
            <div className="dk-card dk-rise" style={{ '--i': 6 }}>
              <div className="dk-pane-head">Team pulse</div>
              <button className="dk-team-row" onClick={() => navTo('timeclock')}>
                <span className="dk-dot dk-dot--up" /> Clocked in now
                <b>{teamKpis.clocked_in_now ?? 0}</b>
              </button>
              <button className="dk-team-row" onClick={() => navTo('manager-dashboard')}>
                Requisitions to approve
                <b className={teamKpis.pending_requisitions > 0 ? 'dk-hot' : ''}>{teamKpis.pending_requisitions ?? 0}</b>
              </button>
              <button className="dk-team-row" onClick={() => navTo('timeclock')}>
                Time off to review
                <b className={teamKpis.time_off_pending > 0 ? 'dk-hot' : ''}>{teamKpis.time_off_pending ?? 0}</b>
              </button>
            </div>
          )}

          {/* My hours — last 7 days from the timeStatus call already made above.
              Today's bar is solid brand; earlier days a lighter cobalt. */}
          {(() => {
            const days = status?.days || {};
            const off = now.getTimezoneOffset() * 60000;
            const series = [];
            for (let i = 6; i >= 0; i--) {
              const d = new Date(now.getTime() - off - i * 86400000);
              const key = d.toISOString().slice(0, 10);
              series.push({ key, min: days[key]?.workedMin || 0, wd: new Date(d.getTime() + off).toLocaleDateString([], { weekday: 'short' }).slice(0, 2), today: i === 0 });
            }
            // Today's closed segments exclude the live session — add it so the
            // card agrees with the running timer (paused while on break).
            if (clockedIn && last?.kind !== 'break_start') series[6].min += Math.floor(elapsed / 60);
            const total = series.reduce((a, s) => a + s.min, 0);
            if (total === 0 && !clockedIn) return null;   // no time-clock use — skip the card
            const max = Math.max(480, ...series.map(s => s.min));
            const fmtH = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
            return (
              <div className="dk-card dk-rise" style={{ '--i': 7 }}>
                <div className="dk-pane-head">My hours <span className="dk-meta">last 7 days · {fmtH(total)}</span></div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 88, padding: '14px 16px 10px' }}>
                  {series.map(s => (
                    <div key={s.key} title={`${s.key} — ${fmtH(s.min)}`}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 5, minWidth: 0, height: '100%' }}>
                      <div style={{ width: '62%', maxWidth: 22, height: Math.max(s.min ? 6 : 3, (s.min / max) * 56), borderRadius: 99,
                        background: !s.min ? 'var(--mist)' : s.today ? 'var(--wk-brand)' : '#b9c4f4' }} />
                      <span style={{ fontSize: 10, fontWeight: s.today ? 700 : 500, color: s.today ? 'var(--wk-brand)' : 'var(--wk-faint)' }}>{s.wd}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          <div className="dk-card dk-rise" style={{ '--i': 8 }}>
            <div className="dk-pane-head">Quick actions</div>
            <button className="dk-key" onClick={() => navTo('inventory', 'catalog')}>
              <span className="dk-chip dk-chip--orange"><Package /></span> Request an item
              <ChevronRight size={14} className="dk-key-arrow" />
            </button>
            <button className="dk-key" onClick={() => navTo('tasks')}>
              <span className="dk-chip dk-chip--blue"><CheckSquare /></span> New task
              <ChevronRight size={14} className="dk-key-arrow" />
            </button>
            <button className="dk-key" onClick={() => navTo('timeclock')}>
              <span className="dk-chip dk-chip--green"><Clock /></span> Time clock
              <ChevronRight size={14} className="dk-key-arrow" />
            </button>
            <button className="dk-key" onClick={() => navTo('sop')}>
              <span className="dk-chip dk-chip--brand"><BookOpen /></span> Knowledge base
              <ChevronRight size={14} className="dk-key-arrow" />
            </button>
            <div className="dk-hint">Press <kbd>Ctrl</kbd>+<kbd>K</kbd> to search everything</div>
          </div>
        </div>
      </div>
    </div>
  );
}
