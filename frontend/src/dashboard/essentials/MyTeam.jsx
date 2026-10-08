// My Team (Essentials, Oct 7) - "Who is in today, and who is stuck?" for
// supervisors and up. Registered as 'my-team' in widgets.jsx (minRole
// 'supervisor'), its own lazy chunk so it loads only when the tile is on the
// board. Two reads, both from routers/my_team.py:
//   api.getMyTeamToday()   -> In / Out / On Leave / Late buckets (one person in
//                             exactly one; Late only when the schedule module
//                             has shifts for anyone on the team)
//   api.getMyTeamOverdue() -> people with overdue tasks / SLA-breached tickets,
//                             worst first, with their single worst item
// A tile toggles the names beneath it; a name opens the person in People the
// way the directory does (lib/personNav). A Needs a Push row opens its worst
// item - a task through the Tasks module's nexus:open-task hand-off, a ticket
// through teamWidgets' openTicket - and carries a Message action (the Teams
// chat deep link PersonHoverCard uses; there is no shared helper for it).
// Refreshes on mount, when the tab becomes visible, and every 60s while it is.
// DashCard / navigate come from widgets.jsx, Row / noteStyle from
// workdayWidgets.jsx, so this tile reads like every other one.
import { useState, useEffect, useCallback, useRef } from 'react';
import { LogIn, LogOut, Palmtree, AlarmClock, ListTodo, Ticket as TicketIcon, MessageSquare, ArrowRight } from 'lucide-react';

import { api } from '../../api';
import { LoadingState } from '../../components/AsyncState';
import { useRole } from '../../contexts/RoleContext';
import { useIsMobile } from '../../lib/useIsMobile';
import { formatDate, formatTime } from '../../lib/datetime';
import { openPersonProfile } from '../../lib/personNav';
import { setPendingOpen } from '../../lib/pendingOpen';
import { DashCard, navigate } from '../widgets.jsx';
import { Row, noteStyle } from '../workdayWidgets.jsx';
import { openTicket, ticketViewFor } from '../teamWidgets.jsx';

export const REFRESH_MS = 60_000;
export const PUSH_CAP = 7;

export const TILES = [
  { key: 'in',      label: 'In',       color: 'green',  Icon: LogIn },
  { key: 'out',     label: 'Out',      color: 'blue',   Icon: LogOut },
  { key: 'onLeave', label: 'On Leave', color: 'purple', Icon: Palmtree },
  { key: 'late',    label: 'Late',     color: 'red',    Icon: AlarmClock },
];

const EMPTY_TODAY = { in: [], out: [], onLeave: [], late: [], counts: { in: 0, out: 0, onLeave: 0, late: 0 }, scheduleAvailable: false };

// Teams 1:1 chat deep link - the same URL PersonHoverCard's "Message" uses.
export function teamsChatUrl(email) {
  return `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent((email || '').trim())}`;
}

// One line under a name in a bucket list.
export function bucketMeta(kind, p) {
  const t = p.since ? formatTime(p.since) : '';
  if (kind === 'in') return `${t ? `Since ${t}` : 'Clocked in'}${p.onBreak ? ' - On Break' : ''}`;
  if (kind === 'late') return t ? `Shift started ${t}` : 'Shift started';
  if (kind === 'onLeave') {
    const until = p.until && p.until !== p.since ? ` through ${formatDate(p.until)}` : ' today';
    return `${p.detail || 'Time off'}${until}`;
  }
  if (p.detail === 'Clocked out') return t ? `Clocked out ${t}` : 'Clocked out';
  if (p.detail === 'Shift later today') return t ? `Shift at ${t}` : 'Shift later today';
  return p.detail || 'Not clocked in';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// One line under a name in Needs a Push: the counts, then the worst item.
export function pushMeta(p) {
  const parts = [];
  if (p.overdueTasks) parts.push(plural(p.overdueTasks, 'overdue task'));
  if (p.breachedTickets) parts.push(plural(p.breachedTickets, 'breached ticket'));
  const w = p.worst;
  if (w) parts.push(`Worst: ${w.code ? `${w.code} ` : ''}${w.title || ''}${w.dueOn ? ` (due ${formatDate(w.dueOn)})` : ''}`.trim());
  return parts.join(' - ');
}

export function openTask(id) {
  if (!id) return;
  setPendingOpen('task', id);
  navigate('tasks', 'mine');
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId: id } })), 0);
}

const sectionHead = { fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', letterSpacing: 0.2, padding: '10px 8px 4px' };
const linkBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, color: 'hsl(var(--color-blue))', background: 'none', border: 'none', cursor: 'pointer', padding: '8px 8px', minHeight: 44, fontFamily: 'var(--wk-font)' };

function Tile({ tile, count, open, onClick, mobile }) {
  const { label, color, Icon } = tile;
  return (
    <button type="button" onClick={onClick} aria-pressed={open} aria-label={`${label}: ${count}`}
      className="dash-link-row"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, padding: mobile ? '12px' : '10px 12px', minHeight: 44,
        border: `1px solid ${open ? `hsl(var(--color-${color}))` : 'var(--line, #e5e7eb)'}`, borderRadius: 10, background: open ? 'var(--mist)' : 'none',
        cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--wk-font)', color: 'var(--ink)', width: '100%', boxSizing: 'border-box' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
        <span className={`dk-chip dk-chip--${color}`} style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0 }}><Icon size={12} /></span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{label}</span>
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{count}</span>
    </button>
  );
}

export default function MyTeam() {
  const { can, myGrantedModules } = useRole();
  const isMobile = useIsMobile();
  const [today, setToday] = useState(null);
  const [overdue, setOverdue] = useState(null);
  const [error, setError] = useState('');
  const [openBucket, setOpenBucket] = useState(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const [t, o] = await Promise.allSettled([api.getMyTeamToday(), api.getMyTeamOverdue()]);
    if (!alive.current) return;
    if (t.status === 'fulfilled' && t.value) setToday(t.value);
    if (o.status === 'fulfilled' && o.value) setOverdue(o.value);
    const failed = [t, o].filter(r => r.status === 'rejected');
    setError(failed.length ? (failed[0].reason?.message || 'Could not load your team') : '');
  }, []);

  // Mount, tab visible, and every minute while the tab is visible.
  useEffect(() => {
    alive.current = true;
    let timer = null;
    const start = () => { if (!timer) timer = setInterval(load, REFRESH_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => { if (document.visibilityState === 'visible') { load(); start(); } else stop(); };
    load();
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => { alive.current = false; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  const data = today || (overdue ? EMPTY_TODAY : null);
  const people = overdue?.people || [];
  const loading = !data && !overdue && !error;
  const tiles = TILES.filter(t => t.key !== 'late' || data?.scheduleAvailable);
  const teamSize = data ? TILES.reduce((n, t) => n + (data.counts?.[t.key] || 0), 0) : 0;
  const anyTasks = people.some(p => p.overdueTasks > 0);

  function openWorst(p) {
    const w = p.worst;
    if (!w) return openPersonProfile(p.email);
    if (w.kind === 'ticket') return openTicket(w.id, ticketViewFor(can, myGrantedModules));
    return openTask(w.id);
  }

  function viewAll() {
    if (anyTasks) navigate('tasks', 'teams');
    else navigate(ticketViewFor(can, myGrantedModules));
  }

  return (
    <DashCard title="My Team" sub={data?.date ? `Today, ${formatDate(data.date)}` : undefined}>
      {loading && <LoadingState compact minHeight={120} label="Loading your team" />}
      {!loading && !data && (
        <div style={noteStyle}>
          {error || 'Could not load your team.'}
          <div><button type="button" style={linkBtn} onClick={load}>Retry</button></div>
        </div>
      )}
      {data && (
        <>
          <div data-testid="team-tiles" style={{ display: 'grid', gridTemplateColumns: `repeat(${isMobile ? 2 : tiles.length}, minmax(0, 1fr))`, gap: 8 }}>
            {tiles.map(t => (
              <Tile key={t.key} tile={t} count={data.counts?.[t.key] || 0} open={openBucket === t.key} mobile={isMobile}
                onClick={() => setOpenBucket(openBucket === t.key ? null : t.key)} />
            ))}
          </div>
          {openBucket && (
            <div data-testid={`bucket-${openBucket}`} style={{ marginTop: 6 }}>
              {(data[openBucket] || []).length === 0 && (
                <div style={{ ...noteStyle, padding: '12px 8px' }}>No one here right now.</div>
              )}
              {(data[openBucket] || []).map(p => (
                <Row key={p.email} title={p.name || p.email} meta={bucketMeta(openBucket, p)} onClick={() => openPersonProfile(p.email)} />
              ))}
            </div>
          )}
          {teamSize === 0 && people.length === 0 && (
            <div style={noteStyle}>No one reports to you in People yet.</div>
          )}
          {(teamSize > 0 || people.length > 0) && (
            <>
              <div style={sectionHead}>Needs a Push</div>
              {error && !overdue && <div style={{ ...noteStyle, padding: '8px' }}>Could not load overdue work. <button type="button" style={{ ...linkBtn, minHeight: 0, padding: 0 }} onClick={load}>Retry</button></div>}
              {overdue && people.length === 0 && <div style={{ ...noteStyle, padding: '12px 8px' }}>Everyone is on track.</div>}
              {people.slice(0, PUSH_CAP).map(p => (
                <div key={p.email} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Row Icon={p.worst?.kind === 'ticket' ? TicketIcon : ListTodo} title={p.name || p.email} meta={pushMeta(p)}
                      status="overdue" statusLabel={isMobile ? '' : 'Overdue'} onClick={() => openWorst(p)} />
                  </div>
                  <a href={teamsChatUrl(p.email)} target="_blank" rel="noreferrer" aria-label={`Message ${p.name || p.email} on Teams`} title="Message on Teams"
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 8, color: 'var(--muted)', flexShrink: 0 }}>
                    <MessageSquare size={16} />
                  </a>
                </div>
              ))}
              {people.length > PUSH_CAP && (
                <button type="button" style={linkBtn} onClick={viewAll}>View All ({overdue?.total || people.length}) <ArrowRight size={13} /></button>
              )}
            </>
          )}
        </>
      )}
    </DashCard>
  );
}
