// Team widgets (phase 3 of the dashboard widget plan, Neil, Sep 25) - the
// supervisor / manager gaps the Team category did not cover: My Ticket Queue,
// Time Exceptions, Out Today and Pending Purchases. Role gating is the
// registry's `minRole` (widgets.jsx), same as the other Team tiles; these
// only read endpoints that already existed.
//
// Loaded lazily from widgets.jsx like panels.jsx / workdayWidgets.jsx. Row and
// noteStyle come from workdayWidgets.jsx so every list tile reads the same.
import { useState, useEffect } from 'react';
import { Ticket as TicketIcon, Timer, UserMinus, ShoppingCart } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { formatDate } from '../lib/datetime';
import { setPendingOpen } from '../lib/pendingOpen';
import { TICKET_STATUS_META, CLOSED_STATES, slaState } from '../tickets/ticketMeta';
import { DashCard, navigate } from './widgets.jsx';
import { Row, noteStyle } from './workdayWidgets.jsx';

const DAY_MS = 86400000;
const localKey = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const sectionStyle = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '10px 8px 4px' };

// ── My Ticket Queue ──────────────────────────────────────────────────────────
// Open tickets assigned to me, SLA breaches first, then priority, then age.
// Desk members also get the unassigned queue (the my-access endpoint says who
// is on the desk - for everyone else the list endpoint already scopes to
// their own requests, so the unassigned section would be empty noise).
// A row opens the ticket in place, the same way the bell does.
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };

export function ticketQueueRows(tickets = [], myEmail = '', onDesk = false) {
  const me = (myEmail || '').toLowerCase();
  const open = tickets.filter(t => !CLOSED_STATES.includes(t.status));
  const decorate = (t) => {
    const sla = slaState(t);
    return {
      id: t.id, title: `${t.code ? `${t.code} · ` : ''}${t.subject || 'Untitled ticket'}`,
      meta: `${PRIORITY_LABEL[t.priority] || t.priority || 'Medium'} · ${TICKET_STATUS_META[t.status]?.label || t.status || 'Open'}`,
      status: sla === 'breached' ? 'overdue' : sla === 'at_risk' ? 'pending' : 'info',
      statusLabel: sla === 'breached' ? 'SLA breached' : sla === 'at_risk' ? 'At risk' : (PRIORITY_LABEL[t.priority] || ''),
      sort: [sla === 'breached' ? 0 : sla === 'at_risk' ? 1 : 2, PRIORITY_RANK[t.priority] ?? 2, t.createdAt || ''],
    };
  };
  const byUrgency = (a, b) => (a.sort[0] - b.sort[0]) || (a.sort[1] - b.sort[1]) || (a.sort[2] < b.sort[2] ? -1 : a.sort[2] > b.sort[2] ? 1 : 0);
  const mine = open.filter(t => (t.assigneeId || '').toLowerCase() === me && me).map(decorate).sort(byUrgency);
  const unassigned = onDesk ? open.filter(t => !t.assigneeId).map(decorate).sort(byUrgency) : [];
  return { mine, unassigned };
}

export function openTicket(id) {
  setPendingOpen('ticket', id);
  navigate('tickets');
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-ticket', { detail: { ticketId: id } })), 0);
}

export function TicketQueueWidget() {
  const { myEmail } = useRole();
  const [state, setState] = useState({ loading: true, mine: [], unassigned: [], onDesk: false });
  useEffect(() => {
    let alive = true;
    Promise.all([api.getTaskTickets().catch(() => []), api.getMyTicketAccess().catch(() => ({}))])
      .then(([tickets, access]) => {
        if (!alive) return;
        const onDesk = !!access?.onDesk;
        setState({ loading: false, onDesk, ...ticketQueueRows(tickets || [], myEmail, onDesk) });
      });
    return () => { alive = false; };
  }, [myEmail]);
  const sub = state.loading ? undefined
    : `${state.mine.length} assigned to you${state.onDesk ? `, ${state.unassigned.length} unassigned` : ''}`;
  const list = (rows) => rows.slice(0, 8).map(r => (
    <Row key={r.id} Icon={TicketIcon} title={r.title} meta={r.meta} status={r.status} statusLabel={r.statusLabel} onClick={() => openTicket(r.id)} />
  ));
  return (
    <DashCard title="My Ticket Queue" sub={sub} action={<TicketIcon size={15} style={{ color: 'var(--muted)' }} />}>
      {state.loading ? (
        <div style={noteStyle}>Loading…</div>
      ) : state.mine.length === 0 && state.unassigned.length === 0 ? (
        <div style={noteStyle}>{state.onDesk ? 'No open tickets assigned to you, and nothing unassigned.' : 'No open tickets assigned to you.'}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {state.onDesk && state.mine.length > 0 && <div style={sectionStyle}>Assigned to me</div>}
          {list(state.mine)}
          {state.onDesk && state.unassigned.length > 0 && <div style={sectionStyle}>Unassigned</div>}
          {list(state.unassigned)}
        </div>
      )}
    </DashCard>
  );
}

// ── Time Exceptions ──────────────────────────────────────────────────────────
// Direct reports with unresolved punch problems (missing / unmatched punches)
// in the last 14 days - the current bi-weekly pay period (Neil, Sep 25).
// Blocking exceptions (the ones that stop timesheet sign-off) first. The
// endpoint is keyed by email; names come from the Nexus People directory.
const EXCEPTION_WINDOW_DAYS = 14;

export function exceptionRows(perEmployee = [], people = []) {
  const name = new Map(people.map(p => [(p.email || '').toLowerCase(), p.name]));
  return perEmployee
    .filter(e => (e.exceptions || []).length > 0)
    .map(e => {
      const exc = e.exceptions || [];
      const blocking = exc.filter(x => x.blocking).length;
      const latest = exc.map(x => x.date).sort().pop();
      const kinds = [...new Set(exc.map(x => x.label).filter(Boolean))].slice(0, 2).join(', ');
      return {
        id: e.email, title: name.get((e.email || '').toLowerCase()) || e.email,
        meta: `${kinds || 'Punch exception'} · latest ${formatDate(latest)}`,
        status: blocking ? 'overdue' : 'pending',
        statusLabel: blocking ? `${blocking} blocking` : `${exc.length} to review`,
        sort: [-blocking, -exc.length],
      };
    })
    .sort((a, b) => (a.sort[0] - b.sort[0]) || (a.sort[1] - b.sort[1]) || a.title.localeCompare(b.title));
}

export function TimeExceptionsWidget() {
  const [state, setState] = useState({ loading: true, rows: [], denied: false });
  useEffect(() => {
    let alive = true;
    const now = new Date();
    const start = localKey(new Date(now.getTime() - EXCEPTION_WINDOW_DAYS * DAY_MS));
    const end = localKey(now);
    Promise.all([
      api.timeExceptions(start, end).then(r => ({ rows: r || [] })).catch(e => ({ denied: e?.status === 403, rows: [] })),
      api.getPeopleDirectory().catch(() => []),
    ]).then(([res, people]) => { if (alive) setState({ loading: false, denied: !!res.denied, rows: exceptionRows(res.rows, people || []) }); });
    return () => { alive = false; };
  }, []);
  const blocking = state.rows.filter(r => r.status === 'overdue').length;
  return (
    <DashCard title="Time Exceptions" sub={state.loading || state.denied ? undefined : blocking ? `${blocking} blocking sign-off` : `Last ${EXCEPTION_WINDOW_DAYS} days`}
      action={<Timer size={15} style={{ color: 'var(--muted)' }} />}>
      {state.loading ? (
        <div style={noteStyle}>Loading…</div>
      ) : state.denied ? (
        <div style={noteStyle}>This tile needs Time editor access in People.</div>
      ) : state.rows.length === 0 ? (
        <div style={noteStyle}>No punch exceptions on your team in the last {EXCEPTION_WINDOW_DAYS} days.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {state.rows.slice(0, 10).map(r => (
            <Row key={r.id} Icon={Timer} title={r.title} meta={r.meta} status={r.status} statusLabel={r.statusLabel} onClick={() => navigate('hr', 'hr-time')} />
          ))}
        </div>
      )}
    </DashCard>
  );
}

// ── Out Today ────────────────────────────────────────────────────────────────
// Who on the team is on approved time off today, plus one compact line per
// upcoming day in the next 7 (Neil, Sep 25 - staffing at a glance). Uses the
// team time-off list (direct reports for a plain manager, wider for admins).
const TIMEOFF_TYPES = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid', other: 'Other' };
const UPCOMING_DAYS = 7;

export function outRows(approved = [], now = new Date()) {
  const today = localKey(now);
  const horizon = localKey(new Date(now.getTime() + UPCOMING_DAYS * DAY_MS));
  const todayRows = [];
  const upcoming = new Map(); // date -> names
  for (const r of approved) {
    if (r.status && r.status !== 'approved') continue;
    const s = (r.startDate || '').slice(0, 10), e = (r.endDate || s).slice(0, 10);
    if (!s) continue;
    const who = r.name || r.email || 'Someone';
    if (s <= today && today <= e) {
      const back = new Date(new Date(`${e}T12:00:00`).getTime() + DAY_MS);
      const partial = r.startTime && r.endTime ? `${r.startTime} - ${r.endTime}` : '';
      todayRows.push({ id: `to-${r.id}`, title: who, meta: `${TIMEOFF_TYPES[r.type] || r.type || 'Time off'}${partial ? ` · ${partial}` : ''} · back ${formatDate(back)}`, statusLabel: partial ? 'Partial' : 'Out', status: partial ? 'pending' : 'overdue', end: e });
    }
    // Every remaining day of the request inside the window counts - including
    // the rest of a range that already started, so someone out through Monday
    // shows on tomorrow's line too, not just today's.
    for (let d = new Date(`${s}T12:00:00`); localKey(d) <= e && localKey(d) <= horizon; d = new Date(d.getTime() + DAY_MS)) {
      const k = localKey(d);
      if (k <= today) continue;
      if (!upcoming.has(k)) upcoming.set(k, new Set());
      upcoming.get(k).add(who);
    }
  }
  todayRows.sort((a, b) => a.title.localeCompare(b.title));
  const upcomingRows = [...upcoming.entries()].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, names]) => ({ date: k, names: [...names].sort() }));
  return { today: todayRows, upcoming: upcomingRows };
}
const dayLabel = (k, now = new Date()) => {
  const d = new Date(`${k}T12:00:00`);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY_MS);
  return diff === 1 ? 'Tomorrow' : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${formatDate(d).slice(0, 5)}`;
};

export function OutTodayWidget() {
  const [state, setState] = useState({ loading: true, today: [], upcoming: [] });
  useEffect(() => {
    let alive = true;
    api.timeOffList('approved').then(rows => { if (alive) setState({ loading: false, ...outRows(rows || []) }); })
      .catch(() => { if (alive) setState({ loading: false, today: [], upcoming: [] }); });
    return () => { alive = false; };
  }, []);
  return (
    <DashCard title="Out Today" sub={state.loading ? undefined : state.today.length ? `${state.today.length} out` : 'Everyone is in'}
      action={<UserMinus size={15} style={{ color: 'var(--muted)' }} />}>
      {state.loading ? (
        <div style={noteStyle}>Loading…</div>
      ) : (
        <>
          {state.today.length === 0 ? (
            <div style={{ ...noteStyle, padding: '14px 8px' }}>Nobody on your team is out today.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {state.today.slice(0, 8).map(r => (
                <Row key={r.id} Icon={UserMinus} title={r.title} meta={r.meta} status={r.status} statusLabel={r.statusLabel} onClick={() => navigate('hr', 'hr-leave')} />
              ))}
            </div>
          )}
          {state.upcoming.length > 0 && (
            <>
              <div style={sectionStyle}>Next {UPCOMING_DAYS} days</div>
              {state.upcoming.map(u => (
                <div key={u.date} style={{ display: 'flex', gap: 10, padding: '4px 8px', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--muted)', flexShrink: 0, width: 92 }}>{dayLabel(u.date)}</span>
                  <span style={{ color: 'var(--ink)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.names.join(', ')}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </DashCard>
  );
}

// ── Pending Purchases ────────────────────────────────────────────────────────
// Purchase requests still pending - the module is thin (item, vendor, cost,
// qty, dept, status; no requester or approver), so this is a plain list that
// opens Purchase Requests. Manager-only, like the module itself.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function purchaseRows(requests = []) {
  return requests
    .filter(r => (r.status || 'pending') === 'pending')
    .map(r => ({
      id: r.id, title: r.item || 'Purchase request',
      meta: [r.dept, r.vendor, r.qty > 1 ? `qty ${r.qty}` : ''].filter(Boolean).join(' · '),
      statusLabel: usd.format((Number(r.cost) || 0) * (Number(r.qty) || 1)), status: 'pending',
      total: (Number(r.cost) || 0) * (Number(r.qty) || 1),
    }))
    .sort((a, b) => b.total - a.total);
}

export function PendingPurchasesWidget() {
  const [state, setState] = useState({ loading: true, rows: [] });
  useEffect(() => {
    let alive = true;
    api.getPurchaseRequests().then(r => { if (alive) setState({ loading: false, rows: purchaseRows(r || []) }); })
      .catch(() => { if (alive) setState({ loading: false, rows: [] }); });
    return () => { alive = false; };
  }, []);
  const total = state.rows.reduce((a, r) => a + r.total, 0);
  return (
    <DashCard title="Pending Purchases" sub={state.loading ? undefined : state.rows.length ? `${state.rows.length} pending · ${usd.format(total)}` : undefined}
      action={<ShoppingCart size={15} style={{ color: 'var(--muted)' }} />}>
      {state.loading ? (
        <div style={noteStyle}>Loading…</div>
      ) : state.rows.length === 0 ? (
        <div style={noteStyle}>No pending purchase requests.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {state.rows.slice(0, 10).map(r => (
            <Row key={r.id} Icon={ShoppingCart} title={r.title} meta={r.meta} status={r.status} statusLabel={r.statusLabel} onClick={() => navigate('purchase')} />
          ))}
        </div>
      )}
    </DashCard>
  );
}
