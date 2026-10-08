// My Work (Essentials, Oct 7) - registered as 'my-work' in widgets.jsx, its
// own lazy chunk so it loads only when the tile is on the board.
//
// "What am I responsible for, and what is due?" - the caller's open tasks and
// tickets from GET /me/work (routers/my_work.py), already bucketed there into
// Overdue / Today / This Week / Later so the rule lives in one place. The tile
// shows the first ROW_CAP rows (overdue first), then hands off to My Tasks.
//
// Actions stay in the tile: Complete finishes a task in place (optimistic,
// then a refetch), a row opens its task or ticket the way the bell does
// (navigate, then nexus:open-task / nexus:open-ticket with the pending note
// for a module still loading - lib/openTarget.js), and the header's New Task /
// Submit a Ticket open the same composers Quick Actions and Support use.
//
// DashCard / navigate come from widgets.jsx, noteStyle from workdayWidgets.jsx.
// The rows are drawn here rather than with workdayWidgets' Row: that one is a
// single button, and a Complete button cannot sit inside another button.
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { CheckSquare, Ticket as TicketIcon, Check, ArrowRight, Plus } from 'lucide-react';

import { api } from '../../api';
import { LoadingState, ModalLoading } from '../../components/AsyncState';
import { formatDate } from '../../lib/datetime';
import { pollWhileVisible } from '../../lib/pollWhileVisible';
import { setPendingOpen } from '../../lib/pendingOpen';
import { useIsMobile } from '../../lib/useIsMobile';
import { ticketNoShort } from '../../tickets/ticketMeta';
import { DashCard, navigate } from '../widgets.jsx';
import { noteStyle } from '../workdayWidgets.jsx';

// The Tasks module's create modal (with its provider) - the same chunk Quick
// Actions' "New task" pulls in.
const QuickActionModal = lazy(() => import('../QuickActionModals.jsx'));
// Support's Submit a Ticket composer: CreateTicketModal reads createTicket
// from TasksProvider, so the provider comes along just for the modal (the
// same trick views/Support.jsx uses).
const TicketComposer = lazy(async () => {
  const [{ TasksProvider }, { CreateTicketModal }] = await Promise.all([
    import('../../tasks/TasksContext'),
    import('../../tickets/TicketsView'),
  ]);
  return { default: ({ onClose }) => <TasksProvider><CreateTicketModal onClose={onClose} /></TasksProvider> };
});

export const ROW_CAP = 7;
export const REFRESH_MS = 60000;
const GROUPS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'later', label: 'Later' },
];
// Status word tone - a dot and the word, never a pill (workdayWidgets.Row).
const STATUS_TONE = {
  not_started: 'muted', open: 'orange', in_progress: 'blue', reopened: 'red',
  waiting_user: 'purple', waiting_vendor: 'purple', on_hold: 'muted', recurring: 'blue',
};
const sectionStyle = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '10px 8px 4px', display: 'flex', justifyContent: 'space-between' };
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** The first `cap` rows across the four groups, overdue first, as sections
 *  with their uncapped counts - so a section header always says how much is
 *  really there even when the tile shows a slice. */
export function pickRows(data, cap = ROW_CAP) {
  const counts = data?.counts || {};
  const out = [];
  let left = cap;
  for (const g of GROUPS) {
    const items = Array.isArray(data?.[g.key]) ? data[g.key] : [];
    const count = counts[g.key] ?? items.length;
    if (!count || left <= 0) continue;
    const slice = items.slice(0, left);
    left -= slice.length;
    out.push({ ...g, count, items: slice });
  }
  return out;
}

const fire = (name, detail) => setTimeout(() => window.dispatchEvent(new CustomEvent(name, { detail })), 0);

/** Open a row where it lives: Tasks (My Tasks) or the ticket's own screen,
 *  then the drawer - the pending note serves a module still downloading. */
export function openItem(it) {
  if (!it) return;
  if (it.kind === 'ticket') {
    const id = it.ticketId || it.id;
    setPendingOpen('ticket', id);
    navigate(it.view || 'support', it.sub || undefined);
    fire('nexus:open-ticket', { ticketId: id });
    return;
  }
  const id = it.taskId || it.id;
  setPendingOpen('task', id);
  navigate(it.view || 'tasks', it.sub || 'mine');
  fire('nexus:open-task', { taskId: id });
}

function WorkRow({ it, overdue, mobile, busy, onOpen, onComplete }) {
  const Icon = it.kind === 'ticket' ? TicketIcon : CheckSquare;
  const tone = overdue ? 'red' : (STATUS_TONE[it.status] || 'blue');
  const color = tone === 'muted' ? 'var(--muted)' : `hsl(var(--color-${tone}))`;
  const where = it.kind === 'ticket' ? (ticketNoShort(it.code) || it.project) : it.project;
  const meta = [where, it.dueOn ? `Due ${formatDate(it.dueOn)}` : ''].filter(Boolean).join(' · ');
  const label = it.statusLabel || titleCase(it.status);
  const target = mobile ? 44 : 30;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, opacity: busy ? 0.5 : 1 }}>
      <button type="button" className="dash-link-row" onClick={() => onOpen(it)} aria-label={`Open ${it.title}`}
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', minHeight: target, border: 'none', background: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--wk-font)', color: 'var(--ink)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mist)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
        <span className="dk-chip dk-chip--blue" style={{ width: 28, height: 28, borderRadius: 7, flexShrink: 0 }}><Icon size={14} /></span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
            {it.unread && <span role="img" aria-label="Unread reply" title="Unread reply" style={{ width: 7, height: 7, borderRadius: 99, background: 'hsl(var(--color-blue))', flexShrink: 0 }} />}
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
          </span>
          {meta && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta}</span>}
        </span>
        {label && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color, flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} /> {label}
          </span>
        )}
      </button>
      {it.kind === 'task' && (
        <button type="button" onClick={() => onComplete(it)} disabled={busy} title="Complete" aria-label={`Complete ${it.title}`}
          style={{ width: target, height: target, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)', borderRadius: 8, background: 'none', color: 'var(--muted)', cursor: busy ? 'default' : 'pointer' }}>
          <Check size={15} />
        </button>
      )}
    </div>
  );
}

export default function MyWork() {
  const mobile = useIsMobile();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(() => new Set());
  const [composer, setComposer] = useState(null);   // 'task' | 'ticket'
  const alive = useRef(true);

  const load = useCallback(() => api.getMyWork().then((d) => {
    if (!alive.current) return;
    setData(d || { overdue: [], today: [], week: [], later: [], counts: {} });
    setError('');
  }).catch((e) => {
    if (!alive.current) return;
    setError(e?.message || 'Could not load your work.');
  }), []);

  useEffect(() => {
    alive.current = true;
    load();
    const stop = pollWhileVisible(load, REFRESH_MS);
    return () => { alive.current = false; stop(); };
  }, [load]);

  const complete = async (it) => {
    if (busy.has(it.id)) return;
    setBusy((s) => new Set(s).add(it.id));
    // Optimistic: the row goes now, the refetch confirms.
    const before = data;
    setData((d) => {
      if (!d) return d;
      const next = { ...d, counts: { ...(d.counts || {}) } };
      for (const g of GROUPS) {
        const items = Array.isArray(d[g.key]) ? d[g.key] : [];
        if (items.some((x) => x.id === it.id)) {
          next[g.key] = items.filter((x) => x.id !== it.id);
          if (typeof next.counts[g.key] === 'number') next.counts[g.key] -= 1;
          if (typeof next.counts.total === 'number') next.counts.total -= 1;
        }
      }
      return next;
    });
    try {
      await api.updateTask(it.id, { completed: true });
      await load();
    } catch (e) {
      if (alive.current) { setData(before); setError(e?.message || 'Could not complete the task.'); }
    } finally {
      if (alive.current) setBusy((s) => { const n = new Set(s); n.delete(it.id); return n; });
    }
  };

  const closeComposer = () => { setComposer(null); load(); };
  const headBtn = { fontSize: 11.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, padding: mobile ? '0 10px' : '2px 8px', minHeight: mobile ? 44 : 0 };
  const actions = (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <button type="button" className="secondary-btn" style={headBtn} onClick={() => setComposer('task')}><Plus size={12} /> New Task</button>
      <button type="button" className="secondary-btn" style={headBtn} onClick={() => setComposer('ticket')}><TicketIcon size={12} /> Submit a Ticket</button>
    </div>
  );

  const sections = pickRows(data);
  const total = data?.counts?.total ?? sections.reduce((n, s) => n + s.count, 0);
  let body;
  if (!data && !error) body = <LoadingState compact minHeight={120} label="Loading your work" />;
  else if (!data && error) body = <div style={noteStyle}>{error}</div>;
  else if (!sections.length) body = <div style={noteStyle}>Nothing due this week.</div>;
  else body = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {error && <div style={{ ...noteStyle, padding: '4px 8px', color: 'hsl(var(--color-red))' }}>{error}</div>}
      {sections.map((s) => (
        <div key={s.key}>
          <div style={sectionStyle}><span>{s.label}</span><span>{s.count}</span></div>
          {s.items.map((it) => (
            <WorkRow key={`${it.kind}-${it.id}`} it={it} overdue={s.key === 'overdue'} mobile={mobile}
              busy={busy.has(it.id)} onOpen={openItem} onComplete={complete} />
          ))}
        </div>
      ))}
      <button type="button" className="secondary-btn" onClick={() => navigate('tasks', 'mine')}
        style={{ marginTop: 'auto', alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8, minHeight: mobile ? 44 : 0 }}>
        View All{total > ROW_CAP ? ` (${total})` : ''} <ArrowRight size={13} />
      </button>
    </div>
  );

  return (
    <DashCard title="My Work" sub={total ? `${total} open` : undefined} action={actions}>
      {body}
      {composer === 'task' && <Suspense fallback={<ModalLoading />}><QuickActionModal kind="task" onClose={closeComposer} /></Suspense>}
      {composer === 'ticket' && <Suspense fallback={<ModalLoading />}><TicketComposer onClose={closeComposer} /></Suspense>}
    </DashCard>
  );
}
