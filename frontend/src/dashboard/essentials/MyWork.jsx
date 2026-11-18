// My Work (Essentials, Oct 7) - registered as 'my-work' in widgets.jsx, its
// own lazy chunk so it loads only when the tile is on the board.
//
// "What is mine to do, and what is due?" - ONE list (Neil, 11/13/2026): the
// caller's open tasks and tickets, and since then their Yours To Do rows
// (documents and Time Sheets to sign, items to accept...), the Time Sheet to
// submit, courses assigned and policies to sign - GET /me/work
// (backend/my_work_sources.py), already bucketed there into Overdue / Today /
// This Week / Later so the rule lives in one place. The tile shows the first
// ROW_CAP rows (overdue first); View All opens the whole list beside the
// page (MyWorkSheet). With more than one kind of work, chips filter by kind.
//
// Actions stay in the tile: Complete finishes a task in place (optimistic,
// then a refetch), a row opens the screen that owns it the way the bell does
// (navigate, then nexus:open-task / nexus:open-ticket with the pending note
// for a module still loading, or the row's own link - lib/openTarget.js), and
// the header's New Task / Submit a Ticket open the same composers Quick
// Actions and Support use. Nothing else is decided from here.
//
// DashCard / navigate come from widgets.jsx, noteStyle from workdayWidgets.jsx.
// The rows are drawn here rather than with workdayWidgets' Row: that one is a
// single button, and a Complete button cannot sit inside another button.
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { CheckSquare, Ticket as TicketIcon, Check, ArrowRight, Plus, ClipboardCheck, FileSignature, Clock, GraduationCap } from 'lucide-react';

import { api } from '../../api';
import { ModalLoading } from '../../components/AsyncState';
import { WidgetSkeleton } from '../listParts.jsx';
import { formatDate, formatTime } from '../../lib/datetime';
import { pollWhileVisible } from '../../lib/pollWhileVisible';
import { setPendingOpen } from '../../lib/pendingOpen';
import { openNotificationTarget } from '../../lib/openTarget';
import { FS } from '../../lib/typeScale';
import { useIsMobile } from '../../lib/useIsMobile';
import { ticketNoShort } from '../../tickets/ticketMeta';
import { DashCard, navigate } from '../widgets.jsx';
import { noteStyle } from '../workdayWidgets.jsx';
import { ROW_CAP, GROUPS, rowKey, pickRows, chipsFor, workSub, errorLine } from './myWorkModel';

export { ROW_CAP, pickRows, workSub };

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

// The whole list, beside the page - its own chunk (it brings the shared Modal).
const MyWorkSheet = lazy(() => import('./MyWorkSheet.jsx'));

export const REFRESH_MS = 60000;
// Status word tone - a dot and the word, never a pill (workdayWidgets.Row).
const STATUS_TONE = {
  not_started: 'muted', open: 'orange', in_progress: 'blue', reopened: 'red',
  waiting_user: 'purple', waiting_vendor: 'purple', on_hold: 'muted', recurring: 'blue',
};
// The mark beside a row says what kind of work it is (elements, not
// components: one picked per row would be a component made during render).
const KIND_MARK = {
  task: <CheckSquare size={14} />, ticket: <TicketIcon size={14} />, todo: <ClipboardCheck size={14} />,
  timesheet: <Clock size={14} />, course: <GraduationCap size={14} />, policy: <FileSignature size={14} />,
  sign: <FileSignature size={14} />,
};
// A Yours To Do row's id is its approvals key ("nexus_sign:<id>"): a document
// or Time Sheet to sign gets the pen. Anchored - "assignment_accept" has
// "sign" inside it.
const markFor = (it) => (it.kind === 'todo' && /^(nexus_sign|timesheet_sign):/.test(String(it.id)) ? KIND_MARK.sign : KIND_MARK[it.kind] || KIND_MARK.task);
const sectionStyle = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '10px 8px 4px', display: 'flex', justifyContent: 'space-between' };
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// The fallback spinner goes to <body> like the composers it stands in for -
// rendered inside the card, a fixed overlay is boxed in by the tile.
const PortalLoading = () => createPortal(<ModalLoading />, document.body);

const fire = (name, detail) => setTimeout(() => window.dispatchEvent(new CustomEvent(name, { detail })), 0);

/** Open a row where it lives: Tasks (My Tasks), the ticket's own screen, or
 *  - for every other kind - the link the server gave it, the way Approvals
 *  opens a row. The pending note serves a module still downloading. */
export function openItem(it) {
  if (!it) return;
  if (it.kind === 'ticket') {
    const id = it.ticketId || it.id;
    setPendingOpen('ticket', id);
    navigate(it.view || 'support', it.sub || undefined);
    fire('nexus:open-ticket', { ticketId: id });
    return;
  }
  if (it.kind && it.kind !== 'task') {
    const link = it.link && it.link.view ? it.link : { view: it.view, sub: it.sub };
    if (!link.view) return;
    navigate(link.view, link.sub || undefined);
    openNotificationTarget(link);
    return;
  }
  const id = it.taskId || it.id;
  setPendingOpen('task', id);
  navigate(it.view || 'tasks', it.sub || 'mine');
  fire('nexus:open-task', { taskId: id });
}

export function WorkRow({ it, overdue, mobile, busy, onOpen, onComplete }) {
  const tone = overdue ? 'red' : (STATUS_TONE[it.status] || 'blue');
  const color = tone === 'muted' ? 'var(--muted)' : `hsl(var(--color-${tone}))`;
  const where = it.kind === 'ticket' ? (ticketNoShort(it.code) || it.project) : it.project;
  // A ticket's SLA deadline is a moment (dueAt, Honest SLA) - date and time.
  const due = it.dueAt ? `Due ${formatDate(it.dueAt)} ${formatTime(it.dueAt)}` : it.dueOn ? `Due ${formatDate(it.dueOn)}` : '';
  const meta = [where, due].filter(Boolean).join(' · ');
  const label = it.statusLabel || titleCase(it.status);
  // 44px on a phone; 36px on a desktop - still a comfortable pointer target.
  const target = mobile ? 44 : 36;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, opacity: busy ? 0.5 : 1 }}>
      <button type="button" className="dash-link-row" onClick={() => onOpen(it)} aria-label={`Open ${it.title}`}
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', minHeight: target, border: 'none', background: 'none', borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--wk-font)', color: 'var(--ink)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--mist)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
        <span className="dk-chip dk-chip--blue" style={{ width: 28, height: 28, borderRadius: 7, flexShrink: 0 }}>{markFor(it)}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
            {it.unread && <span role="img" aria-label="Unread reply" title="Unread reply" style={{ width: 7, height: 7, borderRadius: 99, background: 'hsl(var(--color-blue))', flexShrink: 0 }} />}
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
          </span>
          {meta && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta}</span>}
        </span>
        {label && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color, flexShrink: 0 }}>
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

/** The kind chips: All, then one per kind of work with rows. Buttons that
 *  say which is on (aria-pressed), not tabs - they filter the same list.
 *  They wrap: a chip scrolled out of sight is a kind of work nobody finds
 *  (and .scroll-tabs is a sticky page bar on a phone, wrong inside a card). */
export function WorkChips({ chips, value, onChange, mobile }) {
  if (!chips.length) return null;
  return (
    <div role="group" aria-label="Show" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 8px 2px', flexShrink: 0 }}>
      {chips.map((c) => {
        const on = value === c.key;
        return (
          <button key={c.key} type="button" aria-pressed={on} onClick={() => onChange(c.key)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, padding: '0 10px', minHeight: mobile ? 36 : 26, borderRadius: 99, cursor: 'pointer', fontFamily: 'var(--wk-font)', fontSize: FS.label, fontWeight: 600, whiteSpace: 'nowrap',
              border: `1px solid ${on ? 'var(--ink)' : 'var(--line)'}`, background: on ? 'var(--ink)' : 'none', color: on ? 'var(--card)' : 'var(--muted)' }}>
            {c.label} <span style={{ fontWeight: 500, opacity: 0.8, fontVariantNumeric: 'tabular-nums' }}>{c.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function MyWork({ phone }) {
  // The grid says when the board is a phone stack; outside it, the viewport.
  const isMobileViewport = useIsMobile();
  const mobile = phone ?? isMobileViewport;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(() => new Set());
  const [composer, setComposer] = useState(null);   // 'task' | 'ticket'
  const [only, setOnly] = useState('all');          // the kind chip: 'all' or a source key
  const [sheet, setSheet] = useState(false);        // View All: the whole list beside the page
  const alive = useRef(true);

  const load = useCallback(() => api.getMyWork().then((d) => {
    if (!alive.current) return;
    setData(d || { overdue: [], today: [], week: [], later: [], counts: {} });
    // A chip whose kind emptied out (the last ticket closed) falls back to All.
    setOnly((o) => (o === 'all' || (d?.sources || []).some((x) => x.key === o && x.count > 0) ? o : 'all'));
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
    const key = rowKey(it);
    if (busy.has(key)) return;
    setBusy((s) => new Set(s).add(key));
    // Optimistic: the row goes now, the refetch confirms. Matched on kind AND
    // id - a ticket with the task's number must stay put. Where it sat is
    // remembered so a failure puts back THIS row only, into whatever the list
    // is by then (a snapshot of the whole list would bring back rows another
    // Complete finished in the meantime).
    const removed = [];
    setData((d) => {
      if (!d) return d;
      const next = { ...d, counts: { ...(d.counts || {}) } };
      for (const g of GROUPS) {
        const items = Array.isArray(d[g.key]) ? d[g.key] : [];
        const at = items.findIndex((x) => rowKey(x) === key);
        if (at >= 0) {
          removed.push({ group: g.key, at, row: items[at] });
          next[g.key] = items.filter((_, i) => i !== at);
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
      if (alive.current) {
        setData((d) => {
          if (!d) return d;
          const next = { ...d, counts: { ...(d.counts || {}) } };
          for (const r of removed) {
            const items = Array.isArray(next[r.group]) ? next[r.group] : [];
            if (items.some((x) => rowKey(x) === key)) continue;   // a refetch already has it
            next[r.group] = [...items.slice(0, r.at), r.row, ...items.slice(r.at)];
            if (typeof next.counts[r.group] === 'number') next.counts[r.group] += 1;
            if (typeof next.counts.total === 'number') next.counts.total += 1;
          }
          return next;
        });
        setError(e?.message || 'Could not complete the task.');
      }
    } finally {
      if (alive.current) setBusy((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  };

  const closeComposer = () => { setComposer(null); load(); };
  const headBtn = { fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, padding: mobile ? '0 10px' : '2px 8px', minHeight: mobile ? 44 : 0 };
  const actions = (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <button type="button" className="secondary-btn" style={headBtn} onClick={() => setComposer('task')}><Plus size={12} /> New Task</button>
      <button type="button" className="secondary-btn" style={headBtn} onClick={() => setComposer('ticket')}><TicketIcon size={12} /> Submit a Ticket</button>
    </div>
  );

  const chips = chipsFor(data);
  const sections = pickRows(data, ROW_CAP, only);
  const total = data?.counts?.total ?? sections.reduce((n, s) => n + s.count, 0);
  // A source that could not load is named - a list that failed never looks
  // like an empty one.
  const failed = errorLine(data?.errors);
  const warn = { ...noteStyle, padding: '4px 8px', color: 'hsl(var(--color-red))', textAlign: 'left' };
  let body;
  if (!data && !error) body = <WidgetSkeleton />;
  else if (!data && error) body = <div style={noteStyle}>{error}</div>;
  else if (!sections.length && !chips.length) body = <div style={noteStyle}>{failed || 'Nothing due this week.'}</div>;
  else body = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <WorkChips chips={chips} value={only} onChange={setOnly} mobile={mobile} />
      {error && <div style={warn}>{error}</div>}
      {failed && <div role="status" style={warn}>{failed}</div>}
      {sections.map((s) => (
        <div key={s.key}>
          <div style={sectionStyle}><span>{s.label}</span><span>{s.count}</span></div>
          {s.items.map((it) => (
            <WorkRow key={`${it.kind}-${it.id}`} it={it} overdue={s.key === 'overdue'} mobile={mobile}
              busy={busy.has(rowKey(it))} onOpen={openItem} onComplete={complete} />
          ))}
        </div>
      ))}
      <button type="button" className="secondary-btn" onClick={() => setSheet(true)}
        style={{ marginTop: 'auto', alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8, minHeight: mobile ? 44 : 0 }}>
        View All <ArrowRight size={13} />
      </button>
    </div>
  );

  return (
    // Everything that is mine, every due date - not the My Open Tasks number
    // (live tasks only) or Tasks Home's tiles (tasks only), so the line says
    // what the number is made of (Neil, 11/05/2026: 50 here read against 35
    // there). View All opens the whole list beside the page; it carries no
    // count of its own.
    <DashCard title="My Work" sub={total ? workSub(total, data?.sources) : undefined} action={actions}>
      {body}
      {composer === 'task' && <Suspense fallback={<PortalLoading />}><QuickActionModal kind="task" onClose={closeComposer} /></Suspense>}
      {composer === 'ticket' && <Suspense fallback={<PortalLoading />}><TicketComposer onClose={closeComposer} /></Suspense>}
      {sheet && (
        <Suspense fallback={<PortalLoading />}>
          <MyWorkSheet data={data} only={only} onOnly={setOnly} busy={busy} mobile={mobile} onComplete={complete}
            onOpen={(it) => { setSheet(false); openItem(it); }} onClose={() => setSheet(false)} />
        </Suspense>
      )}
    </DashCard>
  );
}
