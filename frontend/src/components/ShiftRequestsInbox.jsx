// The manager's Requests page (Oct 2026, Teams parity): tabs Time Off |
// Swaps | Offers | Open Shifts with counts, a Waiting On Teammate section,
// a swap card that draws BOTH shifts, a time-off card that lists the shared
// shifts inside the leave with Approve And Remove Shifts beside Approve,
// Approve / Decline with a note, and the decided list with Title Case chips.
// Decisions go through the same endpoints as before (routers/
// shift_requests.py, PATCH /timeclock/timeoff/{id}), so their rules and
// notifications are unchanged. The settings that used to sit under this
// list live in Settings > Global Settings > Shifts now.
// Shifts Phase 3b (Oct 15): a Releases tab - someone wants their shift in
// the open pool. It shows when the company turned releases on, or when a
// release request exists from before it was turned off.
// Oct 30 2026 (Neil): Swaps, Offers and Open Shifts follow their switches
// the same way, and with every one of them off there is no tab strip, only
// Time Off. Soonest first. Each request says what it lands on (the shifts,
// or the usual hours when that week is not built yet), how many of the team
// are on that day and who else is off. No note boxes left open: Decline asks
// for a note, Approve keeps one behind Add Note. Words, not uppercase
// eyebrows or pills.
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, ArrowLeftRight, Send, Hand, Undo2, CalendarOff, Lock, Clock } from 'lucide-react';
import AsyncSection, { SkeletonBlocks } from './AsyncState';
import { Avatar } from './ShiftScheduleExtras';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDate, formatDateTime, formatWeekday } from '../lib/datetime';
import { useNameResolver } from '../lib/useNameResolver';
import { ShiftBlock } from './shifts/ShiftBlock';
import { span } from './shifts/ShiftRequestDialog';
import { timeOffLabel } from './shiftScheduleLib';
import { timeOffWhen, isAllDayOff, shortTimeText, addDaysIso } from './shifts/shiftLib';
import { notifyInboxChanged } from './shifts/useManagerInbox';

const KIND = { open: ['Open Shift', Hand], swap: ['Swap', ArrowLeftRight], offer: ['Offer', Send], release: ['Release', Undo2] };
const TABS = [['timeoff', 'Time Off', CalendarOff], ['swap', 'Swaps', ArrowLeftRight], ['offer', 'Offers', Send], ['open', 'Open Shifts', Hand], ['release', 'Releases', Undo2]];
// The company switch behind each kind (routers/shift_requests _KIND_SETTING).
const KIND_SETTING = { swap: 'swaps', offer: 'offers', open: 'openShifts', release: 'releaseShifts' };
// What a request row says. A release is worded here so the row always reads
// "<who> wants to release <shift>" whatever summary the API sent.
const summaryOf = (r, who) => (r.kind === 'release' && r.shift ? `${who(r.requester)} wants to release ${span(r.shift)}` : r.summary);
const STATUS_CHIP = {
  approved: ['Approved', 'hsl(var(--color-green))'], declined: ['Declined', 'hsl(var(--color-red))'], rejected: ['Declined', 'hsl(var(--color-red))'],
  cancelled: ['Cancelled', 'var(--muted)'], pending_peer: ['Waiting On Teammate', 'hsl(var(--color-orange))'], pending_manager: ['Waiting On Manager', 'hsl(var(--color-orange))'],
};
const row = { border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'grid', gridTemplateColumns: '36px 1fr', columnGap: 10, background: 'var(--card)' };
const HEAD = { fontSize: 13, fontWeight: 700, color: 'var(--ink)', marginBottom: 6 };
const KICKER = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--muted)', flexWrap: 'wrap' };
const LINK = { background: 'none', border: 'none', padding: '6px 2px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: 'var(--wk-brand)' };

// A decided status in words with its color as an icon - no box (Oct 30 2026).
export function StatusChip({ status }) {
  const [label, color] = STATUS_CHIP[status] || [status, 'var(--muted)'];
  return (
    <span style={{ fontSize: 12, fontWeight: 700, color, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4, lineHeight: 1.3 }}>
      {status === 'approved' ? <CheckCircle2 size={12} /> : status === 'declined' || status === 'rejected' ? <XCircle size={12} /> : <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />}{label}
    </span>
  );
}

// Days from a to b (inclusive), at most `cap`.
const daysOf = (a, b, cap = 14) => { const out = []; for (let d = a; d && d <= (b || a) && out.length < cap; d = addDaysIso(d, 1)) out.push(d); return out; };
const dayShort = (iso) => `${formatWeekday(iso, 'short')} ${formatDate(iso).slice(0, 5)}`;

// The schedule around the requests (one read, Oct 30 2026): the person's
// shifts in the dates, their usual hours, the team's people on each day and
// who else is off - from GET /timeclock/schedule for the span the requests
// cover. Nothing when it cannot be read (an older API, no access).
function useRequestContext(timeoff, pending) {
  const range = useMemo(() => {
    const dates = [];
    (timeoff || []).forEach((t) => { if (t.startDate) dates.push(t.startDate, t.endDate || t.startDate); });
    (pending || []).forEach((r) => { [r.shift?.date, r.targetShift?.date].forEach((d) => d && dates.push(d)); });
    if (!dates.length) return null;
    dates.sort();
    const lo = dates[0];
    const hi = dates[dates.length - 1] < addDaysIso(lo, 91) ? dates[dates.length - 1] : addDaysIso(lo, 91);
    return { lo, hi };
  }, [timeoff, pending]);
  const [sched, setSched] = useState(null);
  useEffect(() => {
    if (!range) return undefined;
    let live = true;
    Promise.resolve().then(() => (api.timeSchedule ? api.timeSchedule(range.lo, range.hi) : null))
      .then((r) => { if (live) setSched(r && Array.isArray(r.scheduled) ? r : null); })
      .catch(() => { if (live) setSched(null); });
    return () => { live = false; };
  }, [range?.lo, range?.hi]); // eslint-disable-line react-hooks/exhaustive-deps
  return range ? sched : null;
}

// What one request lands on, in three short lines.
function contextOf(sched, email, dates, skipId = '') {
  if (!sched || !email || !dates.length) return null;
  const em = email.toLowerCase();
  const inDates = new Set(dates);
  const mine = (sched.scheduled || []).filter((s) => (s.email || '').toLowerCase() === em && inDates.has(s.date) && !s.pendingDelete)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start)));
  // Usual hours only when the week has nothing built for the team yet - never as if scheduled.
  const team = (sched.groups || []).find((g) => !g.archived && (g.members || []).some((m) => String(m).toLowerCase() === em));
  const members = team ? (team.members || []).map((m) => String(m).toLowerCase()) : [];
  const built = (sched.scheduled || []).some((s) => inDates.has(s.date) && (!members.length || members.includes((s.email || '').toLowerCase())));
  const usualId = sched.usual?.[em] || '';
  const usual = !mine.length && !built && usualId ? (sched.shifts || []).find((p) => p.id === usualId) : null;
  // The team on each day (the person themself not counted), and who else is off.
  const on = team ? dates.slice(0, 7).map((d) => {
    const people = new Set((sched.scheduled || []).filter((s) => s.date === d && !s.pendingDelete && s.id !== skipId && s.email && members.includes(s.email.toLowerCase()) && s.email.toLowerCase() !== em).map((s) => s.email.toLowerCase()));
    return { d, n: people.size, of: Math.max(0, members.length - 1) };
  }) : [];
  const off = [];
  (sched.timeoff || []).forEach((t) => {
    const who = (t.email || '').toLowerCase();
    if (who === em || (members.length && !members.includes(who)) || !['approved', 'pending'].includes(t.status)) return;
    if (dates.some((d) => d >= t.startDate && d <= (t.endDate || t.startDate)) && !off.some((o) => o.email === who)) off.push({ email: who, requested: t.status !== 'approved' });
  });
  return { mine, usual, team, on, off, more: Math.max(0, dates.length - 7) };
}

function RequestContext({ ctx, nameOf }) {
  if (!ctx) return null;
  const { mine, usual, team, on, off, more } = ctx;
  const line = (label, body) => (
    <div style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.45 }}>
      <span style={{ color: 'var(--muted)', minWidth: 96, flexShrink: 0 }}>{label}</span><span style={{ color: 'var(--ink)', minWidth: 0 }}>{body}</span>
    </div>
  );
  return (
    <div data-request-context="" style={{ display: 'grid', gap: 2, margin: '6px 0 2px' }}>
      {line('Lands On', mine.length ? mine.map((s) => `${dayShort(s.date)} ${shortTimeText(s.start, s.end)}${s.code ? ` ${s.code}` : ''}`).join(', ')
        : usual ? <span>No shifts yet - usual hours {shortTimeText(usual.start, usual.end)}{usual.name ? ` (${usual.name})` : ''}; that week is not built</span>
          : <span style={{ color: 'var(--muted)' }}>No shifts in these dates</span>)}
      {team && on.length > 0 && line(`${team.name} On`, <span>{on.map((x) => `${on.length > 1 ? `${dayShort(x.d)} ` : ''}${x.n} of ${x.of}`).join(' · ')}{more ? ` · +${more} more days` : ''}</span>)}
      {line('Also Off', off.length ? off.map((o) => `${nameOf(o.email)}${o.requested ? ' (requested)' : ''}`).join(', ') : <span style={{ color: 'var(--muted)' }}>Nobody else{team ? ` on ${team.name}` : ''}</span>)}
    </div>
  );
}

// Both shifts of a request, side by side; a shift that is gone says so.
function RequestShifts({ r, who }) {
  const gone = <div style={{ fontSize: 12, color: 'var(--muted)', border: '1px dashed var(--line)', borderRadius: 6, padding: '8px 10px' }}>No longer on the schedule</div>;
  const block = (s, owner) => (s ? (
    <ShiftBlock shift={s} style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{owner} · {formatWeekday(s.date, 'short')} {formatDate(s.date)}</div>
    </ShiftBlock>
  ) : gone);
  const two = r.kind === 'swap';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: two ? '1fr auto 1fr' : 'minmax(0, 320px)', gap: 8, alignItems: 'center', margin: '6px 0' }}>
      {block(r.shift, who(r.requester))}
      {two && <ArrowLeftRight size={14} color="var(--muted)" />}
      {two && block(r.targetShift, who(r.target))}
    </div>
  );
}

export default function ShiftRequestsInbox({ inbox, timeoff, loading, error, onRetry, onChanged, toastOk, toastErr }) {
  const nameOf = useNameResolver();
  const [tabPick, setTab] = useState('timeoff');
  const [notes, setNotes] = useState({});
  const [noteOpen, setNoteOpen] = useState({});   // id -> the Add Note box is open
  const [busyId, setBusyId] = useState('');
  const [removal, setRemoval] = useState({});   // time-off id -> conflicts returned after approval
  const who = (p) => (p ? nameOf(p.email, p.name) : 'a teammate');
  const photos = inbox?.photos || {};
  const face = (email, name) => <Avatar name={nameOf(email, name)} photoUrl={photos[(email || '').toLowerCase()] || ''} size={36} />;
  // A teammate or decider named inside a line: a small face before the name.
  const tag = (p, size = 18) => (p ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }}>
      <Avatar name={who(p)} photoUrl={photos[(p.email || '').toLowerCase()] || ''} size={size} />{who(p)}
    </span>
  ) : 'a teammate');
  // A kind's tab shows when its switch is on, or when a request of that kind
  // exists from before it was turned off. An older API without `settings`:
  // every tab but Releases, as before.
  const anyOf = (kind) => ['pending', 'waitingOnPeer', 'recent'].some((k) => (inbox?.[k] || []).some((r) => r.kind === kind));
  const settings = inbox?.settings || null;
  const tabs = TABS.filter(([k]) => k === 'timeoff' || anyOf(k) || (settings ? settings[KIND_SETTING[k]] === true : k !== 'release'));
  const tab = tabs.some(([k]) => k === tabPick) ? tabPick : 'timeoff';
  // Soonest first (Oct 30 2026).
  const soon = (r) => r.shift?.date || r.targetShift?.date || '';
  const pending = (inbox?.pending || []).filter((r) => r.kind === tab).sort((a, b) => soon(a).localeCompare(soon(b)));
  const waiting = (inbox?.waitingOnPeer || []).filter((r) => r.kind === tab).sort((a, b) => soon(a).localeCompare(soon(b)));
  const recent = (inbox?.recent || []).filter((r) => r.kind === tab);
  const offList = [...(timeoff || [])].sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
  const counts = { timeoff: offList.filter((t) => t.canDecide !== false).length, swap: 0, offer: 0, open: 0, release: 0 };
  (inbox?.pending || []).forEach((r) => { counts[r.kind] = (counts[r.kind] || 0) + 1; });
  const sched = useRequestContext(timeoff, inbox?.pending);
  const changed = () => { onChanged?.(); notifyInboxChanged(); };

  // Decline always says why (Oct 30 2026): the note is asked for, required.
  const askWhy = (title) => dialog.prompt('Tell them why. They see this note with the decision.', { title, confirmText: 'Decline', required: true, multiline: true, placeholder: 'e.g. Two people are already off that day' });
  async function decideTimeOff(t, approve, removeShifts = false) {
    let note = notes[t.id] || '';
    if (!approve) {
      const why = await askWhy('Decline Time Off');
      if (why == null || !String(why).trim()) return;
      note = String(why).trim();
    }
    setBusyId(t.id);
    try {
      const r = await api.timeOffDecide(t.id, { status: approve ? 'approved' : 'rejected', note, ...(removeShifts ? { remove_shifts: true } : {}) });
      // Second Approval By HR (Oct 27 2026): the manager's approval sends it
      // to HR - nothing is approved yet, so the shifts inside it stay.
      const left = approve && !removeShifts && !r?.awaitingHr ? (r?.conflicts || []) : [];
      if (r?.awaitingHr) {
        toastOk?.('Approved - it now waits for HR approval. The shifts inside it stay until HR approves.');
      } else if (left.length) {
        setRemoval((m) => ({ ...m, [t.id]: left }));
        toastOk?.(`Time off approved. ${left.length} shared shift${left.length === 1 ? '' : 's'} inside it still stand${left.length === 1 ? 's' : ''}.`);
      } else {
        toastOk?.(approve ? (removeShifts ? 'Time off approved and the shifts inside it marked for removal. Share the schedule to send that.' : 'Time off approved. They were told.') : 'Time off declined. They were told.');
      }
      changed();
    } catch (e) { toastErr?.(e.message || 'Could not save the decision.'); }
    setBusyId('');
  }
  async function removeAfter(t) {
    setBusyId(t.id);
    try {
      await api.timeOffDecide(t.id, { status: 'approved', note: notes[t.id] || '', remove_shifts: true });
      setRemoval((m) => { const n = { ...m }; delete n[t.id]; return n; });
      toastOk?.('The shifts inside the leave are marked for removal. Share the schedule to send that.');
      changed();
    } catch (e) { toastErr?.(e.message || 'Could not remove the shifts.'); }
    setBusyId('');
  }
  async function decide(r, approve, force = false) {
    let note = notes[r.id] || '';
    if (!approve) {
      const why = await askWhy(`Decline ${(KIND[r.kind] || ['Request'])[0]}`);
      if (why == null || !String(why).trim()) return;
      note = String(why).trim();
    }
    setBusyId(r.id);
    try {
      await api.shiftRequestDecide(r.id, { approve, note, ...(force ? { force: true } : {}) });
      toastOk?.(approve ? (r.kind === 'release' ? 'Approved. The shift is in the open pool and they were told.' : 'Approved. The schedule is updated and everyone involved was told.') : 'Declined. Everyone involved was told.');
      changed();
    } catch (e) {
      // 409: the new owner would have a conflict (CONTRACT.md 7) - ask, then force.
      if (approve && e?.status === 409 && !force) {
        setBusyId('');
        const ok = await dialog.confirm(`${e.message} Approve anyway?`, { title: 'Approve With A Conflict', confirmText: 'Approve Anyway' });
        if (ok) return decide(r, true, true);
        return;
      }
      toastErr?.(e.message || 'Could not save the decision.');
    }
    setBusyId('');
  }

  // An approval's note is optional and stays folded behind Add Note.
  const noteBox = (id, label) => (noteOpen[id] ? (
    <input className="form-input" aria-label={label} placeholder="Note (optional)" value={notes[id] || ''} autoFocus
      onChange={(e) => setNotes((n) => ({ ...n, [id]: e.target.value }))} style={{ flexBasis: '100%', fontSize: 12.5, order: 9 }} />
  ) : (
    <button type="button" onClick={() => setNoteOpen((o) => ({ ...o, [id]: true }))} style={LINK}>Add Note</button>
  ));
  const empty = tab === 'timeoff' ? !offList.length : !pending.length && !waiting.length;

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {tabs.length > 1 && <div className="scroll-tabs" role="tablist" aria-label="Request types" style={{ display: 'flex', gap: 2, marginBottom: 14, borderBottom: '1px solid var(--wk-line)' }}>
        {tabs.map(([k, label, Icon]) => {
          const on = tab === k;
          const n = counts[k] || 0;
          return (
            <button key={k} type="button" role="tab" aria-selected={on} onClick={() => setTab(k)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 12px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 13, fontWeight: on ? 700 : 600, color: on ? 'var(--wk-brand)' : 'var(--muted)', whiteSpace: 'nowrap', marginBottom: -1,
                borderBottom: on ? '2.5px solid var(--wk-brand)' : '2.5px solid transparent' }}>
              <Icon size={14} /> {label}
              {n > 0 && <span aria-label={`${n} waiting`} style={{ fontSize: 12, fontWeight: 800, color: on ? 'var(--wk-brand)' : 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{n}</span>}
            </button>
          );
        })}
      </div>}

      <AsyncSection loading={loading} error={!!error} onRetry={onRetry} errorMessage="The requests could not be loaded right now." skeleton={<SkeletonBlocks count={3} height={72} borderRadius={12} />}
        isEmpty={empty && !recent.length} emptyContent={<div style={{ fontSize: 13, color: 'var(--muted)', padding: '22px 16px', textAlign: 'center', border: '1px dashed var(--wk-line2)', borderRadius: 12 }}>Nothing waiting on you.</div>}>
        {tab === 'timeoff' ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {offList.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)', padding: '22px 16px', textAlign: 'center', border: '1px dashed var(--wk-line2)', borderRadius: 12 }}>No time-off requests waiting.</div>}
            {offList.map((t) => {
              const when = t.startDate === t.endDate ? formatDate(t.startDate) : `${formatDate(t.startDate)} - ${formatDate(t.endDate)}`;
              const conflicts = removal[t.id] || t.conflicts || [];
              const decided = !!removal[t.id];
              return (
                <div key={t.id} className={t.canDecide !== false && !decided ? 'nx-needs-you--card' : undefined} style={row}>
                  {face(t.email, t.name)}
                  <div style={{ minWidth: 0 }}>
                    <div style={KICKER}>
                      <CalendarOff size={13} /> Time Off · {timeOffLabel(t.type)}
                      {t.confidential && <span title="Confidential - the reason is visible only to the employee and their approver" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Lock size={11} /> Confidential</span>}
                      {t.createdAt && <span style={{ fontWeight: 500 }}>· asked {formatDateTime(t.createdAt.endsWith('Z') ? t.createdAt : `${t.createdAt}Z`)}</span>}
                    </div>
                    <div style={{ fontSize: 13.5, color: 'var(--ink)', margin: '4px 0' }}>{nameOf(t.email, t.name)} · {when}{isAllDayOff(t) ? '' : `, ${timeOffWhen(t)}`}</div>
                    {!t.redacted && <div style={{ fontSize: 12, color: 'var(--muted)' }}><span style={{ fontWeight: 700 }}>Reason:</span> {t.note || 'None given'}</div>}
                    <RequestContext ctx={contextOf(sched, t.email, daysOf(t.startDate, t.endDate))} nameOf={(e) => nameOf(e)} />
                    {conflicts.length > 0 && (
                      <div style={{ marginTop: 8, paddingLeft: 10, borderLeft: '2px solid hsl(var(--color-orange))' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}><Clock size={12} /> {conflicts.length} shared shift{conflicts.length === 1 ? '' : 's'} inside this leave</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 6 }}>
                          {conflicts.map((s) => <ShiftBlock key={s.id} shift={s} style={{ marginBottom: 0 }}><div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{formatWeekday(s.date, 'short')} {formatDate(s.date)}</div></ShiftBlock>)}
                        </div>
                      </div>
                    )}
                    {t.canDecide === false ? (
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                        {t.own ? `Your own request - ${t.reviewer || 'your manager'} decides it; nobody approves their own time off.` : `${t.reviewer || 'Their manager'} decides this request.`}
                      </div>
                    ) : decided ? (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <StatusChip status="approved" />
                        <button type="button" className="secondary-btn" disabled={busyId === t.id} onClick={() => removeAfter(t)} style={{ fontSize: 12.5 }}>Remove Those Shifts</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        {conflicts.length > 0 && <button type="button" className="primary-btn" disabled={busyId === t.id} onClick={() => decideTimeOff(t, true, true)} style={{ fontSize: 12.5 }}>Approve And Remove Shifts</button>}
                        <button type="button" className={conflicts.length ? 'secondary-btn' : 'primary-btn'} disabled={busyId === t.id} onClick={() => decideTimeOff(t, true)} style={{ fontSize: 12.5 }}>Approve</button>
                        <button type="button" className="secondary-btn" disabled={busyId === t.id} onClick={() => decideTimeOff(t, false)} style={{ fontSize: 12.5 }}>Decline</button>
                        {noteBox(t.id, 'Note to the employee')}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 10 }}>
              {pending.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)', padding: '22px 16px', textAlign: 'center', border: '1px dashed var(--wk-line2)', borderRadius: 12 }}>Nothing waiting on a manager.</div>}
              {pending.map((r) => {
                const [label, Icon] = KIND[r.kind] || [r.kind, Hand];
                return (
                  <div key={r.id} className="nx-needs-you--card" style={row}>
                    {face(r.requester?.email, r.requester?.name)}
                    <div style={{ minWidth: 0 }}>
                      <div style={KICKER}>
                        <Icon size={13} /> {label} <span style={{ fontWeight: 500 }}>· asked {formatDateTime(`${r.createdAt}Z`)}</span>
                      </div>
                      <div style={{ fontSize: 13.5, color: 'var(--ink)', margin: '4px 0' }}>{summaryOf(r, who)}.</div>
                      <RequestShifts r={r} who={who} />
                      {r.shift?.date && <RequestContext ctx={(() => {
                        // For the person who would take the shift: the requester of an open shift, the teammate of an offer, the requester of a swap.
                        const taker = r.kind === 'offer' ? r.target?.email : r.kind === 'release' ? '' : r.requester?.email;
                        const c = contextOf(sched, taker || r.requester?.email, [r.shift.date], r.shift.id);
                        return c && r.kind === 'release' ? { ...c, mine: [], usual: null } : c;
                      })()} nameOf={(e) => nameOf(e)} />}
                      {r.note && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{who(r.requester)}: “{r.note}”</div>}
                      {r.peerNote && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{tag(r.target)}: “{r.peerNote}”</div>}
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button type="button" className="primary-btn" disabled={busyId === r.id} onClick={() => decide(r, true)} style={{ fontSize: 12.5 }}>Approve</button>
                        <button type="button" className="secondary-btn" disabled={busyId === r.id} onClick={() => decide(r, false)} style={{ fontSize: 12.5 }}>Decline</button>
                        {noteBox(r.id, 'Note to the team')}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {waiting.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={HEAD}>Waiting On Teammate</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {waiting.map((r) => (
                    <div key={r.id} style={{ ...row, opacity: 0.85 }}>
                      {face(r.requester?.email, r.requester?.name)}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13, color: 'var(--ink)', flex: 1 }}>{r.summary}.</span>
                          <StatusChip status="pending_peer" />
                        </div>
                        <RequestShifts r={r} who={who} />
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{tag(r.target)} has not answered yet. It reaches you once they accept.</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {recent.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={HEAD}>Recently Decided</div>
            {recent.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '6px 0', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
                <Avatar name={who(r.requester)} photoUrl={photos[(r.requester?.email || '').toLowerCase()] || ''} size={20} />
                <span style={{ flex: 1, minWidth: 200 }}>{summaryOf(r, who)}{r.decisionNote ? <span style={{ color: 'var(--muted)' }}> · {r.decisionNote}</span> : null}</span>
                <StatusChip status={r.status} />
                {r.decidedBy && <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}>by {tag({ email: r.decidedBy }, 18)}</span>}
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.decidedAt ? formatDate(`${r.decidedAt}Z`) : ''}</span>
              </div>
            ))}
          </div>
        )}
      </AsyncSection>
    </div>
  );
}
