// The manager's Requests page (Oct 2026, Teams parity): tabs Time Off |
// Swaps | Offers | Open Shifts with counts, a Waiting On Teammate section,
// a swap card that draws BOTH shifts, a time-off card that lists the shared
// shifts inside the leave with Approve And Remove Shifts beside Approve,
// Approve / Decline with a note, and the decided list with Title Case chips.
// Decisions go through the same endpoints as before (routers/
// shift_requests.py, PATCH /timeclock/timeoff/{id}), so their rules and
// notifications are unchanged. The settings that used to sit under this
// list live in Settings > Global Settings > Shifts now.
import { useState } from 'react';
import { CheckCircle2, XCircle, ArrowLeftRight, Send, Hand, CalendarOff, Lock, Clock } from 'lucide-react';
import AsyncSection, { SkeletonBlocks } from './AsyncState';
import { Avatar } from './ShiftScheduleExtras';
import { api } from '../api';
import { dialog } from '../ui/dialog';
import { formatDate, formatDateTime, formatWeekday } from '../lib/datetime';
import { useNameResolver } from '../lib/useNameResolver';
import { ShiftBlock } from './shifts/ShiftBlock';
import { timeOffLabel } from './shiftScheduleLib';
import { timeOffWhen, isAllDayOff } from './shifts/shiftLib';
import { notifyInboxChanged } from './shifts/useManagerInbox';

const KIND = { open: ['Open Shift', Hand], swap: ['Swap', ArrowLeftRight], offer: ['Offer', Send] };
const TABS = [['timeoff', 'Time Off', CalendarOff], ['swap', 'Swaps', ArrowLeftRight], ['offer', 'Offers', Send], ['open', 'Open Shifts', Hand]];
const STATUS_CHIP = {
  approved: ['Approved', 'hsl(var(--color-green))'], declined: ['Declined', 'hsl(var(--color-red))'], rejected: ['Declined', 'hsl(var(--color-red))'],
  cancelled: ['Cancelled', 'var(--muted)'], pending_peer: ['Waiting On Teammate', 'hsl(var(--color-orange))'], pending_manager: ['Waiting On Manager', 'hsl(var(--color-orange))'],
};
const row = { border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'grid', gridTemplateColumns: '36px 1fr', columnGap: 10, background: 'var(--card)' };
const HEAD = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 };

export function StatusChip({ status }) {
  const [label, color] = STATUS_CHIP[status] || [status, 'var(--muted)'];
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {status === 'approved' ? <CheckCircle2 size={11} /> : status === 'declined' || status === 'rejected' ? <XCircle size={11} /> : null}{label}
    </span>
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
  const [tab, setTab] = useState('timeoff');
  const [notes, setNotes] = useState({});
  const [busyId, setBusyId] = useState('');
  const [removal, setRemoval] = useState({});   // time-off id -> conflicts returned after approval
  const who = (p) => (p ? nameOf(p.email, p.name) : 'a teammate');
  const photos = inbox?.photos || {};
  const face = (email, name) => <Avatar name={nameOf(email, name)} photoUrl={photos[(email || '').toLowerCase()] || ''} size={36} />;
  const pending = (inbox?.pending || []).filter((r) => r.kind === tab);
  const waiting = (inbox?.waitingOnPeer || []).filter((r) => r.kind === tab);
  const recent = (inbox?.recent || []).filter((r) => r.kind === tab);
  const offList = timeoff || [];
  const counts = { timeoff: offList.filter((t) => t.canDecide !== false).length, swap: 0, offer: 0, open: 0 };
  (inbox?.pending || []).forEach((r) => { counts[r.kind] = (counts[r.kind] || 0) + 1; });
  const changed = () => { onChanged?.(); notifyInboxChanged(); };

  async function decideTimeOff(t, approve, removeShifts = false) {
    setBusyId(t.id);
    try {
      const r = await api.timeOffDecide(t.id, { status: approve ? 'approved' : 'rejected', note: notes[t.id] || '', ...(removeShifts ? { remove_shifts: true } : {}) });
      const left = approve && !removeShifts ? (r?.conflicts || []) : [];
      if (left.length) {
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
    setBusyId(r.id);
    try {
      await api.shiftRequestDecide(r.id, { approve, note: notes[r.id] || '', ...(force ? { force: true } : {}) });
      toastOk?.(approve ? 'Approved. The schedule is updated and everyone involved was told.' : 'Declined. Everyone involved was told.');
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

  const noteBox = (id, label) => (
    <input className="form-input" aria-label={label} placeholder="Note (optional)" value={notes[id] || ''}
      onChange={(e) => setNotes((n) => ({ ...n, [id]: e.target.value }))} style={{ flex: 1, minWidth: 160, fontSize: 12.5 }} />
  );
  const empty = tab === 'timeoff' ? !offList.length : !pending.length && !waiting.length;

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      <div className="scroll-tabs" role="tablist" aria-label="Request types" style={{ display: 'flex', gap: 2, marginBottom: 14, borderBottom: '1px solid var(--wk-line)' }}>
        {TABS.map(([k, label, Icon]) => {
          const on = tab === k;
          const n = counts[k] || 0;
          return (
            <button key={k} type="button" role="tab" aria-selected={on} onClick={() => setTab(k)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 12px', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 13, fontWeight: on ? 700 : 600, color: on ? 'var(--wk-brand)' : 'var(--muted)', whiteSpace: 'nowrap', marginBottom: -1,
                borderBottom: on ? '2.5px solid var(--wk-brand)' : '2.5px solid transparent' }}>
              <Icon size={14} /> {label}
              {n > 0 && <span aria-label={`${n} waiting`} style={{ fontSize: 10.5, fontWeight: 800, background: 'hsl(var(--color-red))', color: '#fff', borderRadius: 10, padding: '0 6px', minWidth: 18, textAlign: 'center' }}>{n}</span>}
            </button>
          );
        })}
      </div>

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
                <div key={t.id} style={row}>
                  {face(t.email, t.name)}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', flexWrap: 'wrap' }}>
                      <CalendarOff size={12} /> Time Off · {timeOffLabel(t.type)}
                      {t.confidential && <span title="Confidential - the reason is visible only to the employee and their approver" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, textTransform: 'none', letterSpacing: 0 }}><Lock size={11} /> Confidential</span>}
                      {t.createdAt && <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· asked {formatDateTime(t.createdAt.endsWith('Z') ? t.createdAt : `${t.createdAt}Z`)}</span>}
                    </div>
                    <div style={{ fontSize: 13.5, color: 'var(--ink)', margin: '4px 0' }}>{nameOf(t.email, t.name)} · {when}{isAllDayOff(t) ? '' : `, ${timeOffWhen(t)}`}</div>
                    {!t.redacted && <div style={{ fontSize: 12, color: 'var(--muted)' }}><span style={{ fontWeight: 700 }}>Reason:</span> {t.note || 'None given'}</div>}
                    {conflicts.length > 0 && (
                      <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'hsla(var(--color-orange),0.1)', border: '1px solid hsla(var(--color-orange),0.4)' }}>
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
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        {noteBox(t.id, 'Note to the employee')}
                        {conflicts.length > 0 && <button type="button" className="primary-btn" disabled={busyId === t.id} onClick={() => decideTimeOff(t, true, true)} style={{ fontSize: 12.5 }}>Approve And Remove Shifts</button>}
                        <button type="button" className={conflicts.length ? 'secondary-btn' : 'primary-btn'} disabled={busyId === t.id} onClick={() => decideTimeOff(t, true)} style={{ fontSize: 12.5 }}>Approve</button>
                        <button type="button" className="secondary-btn" disabled={busyId === t.id} onClick={() => decideTimeOff(t, false)} style={{ fontSize: 12.5 }}>Decline</button>
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
                  <div key={r.id} style={row}>
                    {face(r.requester?.email, r.requester?.name)}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', flexWrap: 'wrap' }}>
                        <Icon size={12} /> {label} <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· asked {formatDateTime(`${r.createdAt}Z`)}</span>
                      </div>
                      <div style={{ fontSize: 13.5, color: 'var(--ink)', margin: '4px 0' }}>{r.summary}.</div>
                      <RequestShifts r={r} who={who} />
                      {r.note && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{who(r.requester)}: “{r.note}”</div>}
                      {r.peerNote && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{who(r.target)}: “{r.peerNote}”</div>}
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        {noteBox(r.id, 'Note to the team')}
                        <button type="button" className="primary-btn" disabled={busyId === r.id} onClick={() => decide(r, true)} style={{ fontSize: 12.5 }}>Approve</button>
                        <button type="button" className="secondary-btn" disabled={busyId === r.id} onClick={() => decide(r, false)} style={{ fontSize: 12.5 }}>Decline</button>
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
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{who(r.target)} has not answered yet. It reaches you once they accept.</div>
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
                <span style={{ flex: 1, minWidth: 200 }}>{r.summary}{r.decisionNote ? <span style={{ color: 'var(--muted)' }}> · {r.decisionNote}</span> : null}</span>
                <StatusChip status={r.status} />
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.decidedAt ? formatDate(`${r.decidedAt}Z`) : ''}</span>
              </div>
            ))}
          </div>
        )}
      </AsyncSection>
    </div>
  );
}
