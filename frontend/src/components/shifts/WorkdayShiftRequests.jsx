// Workday > Time Off > Shift Requests (Charmi, 09/30: "move requests and
// everything for the user to the other end"): the one place an employee
// asks for a swap, an offer or an open shift, sees what waits on them, and
// what became of what they asked. Time off is the form above it.
import { useEffect, useMemo, useState } from 'react';
import { Plus, CheckCircle2, ArrowLeftRight, Send, Hand, CalendarClock } from 'lucide-react';
import { api } from '../../api';
import { toDateInputValue, formatDate } from '../../lib/datetime';
import { useNameResolver } from '../../lib/useNameResolver';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import ShiftRequestDialog, { PENDING, span } from './ShiftRequestDialog';
import { ShiftBlock } from './ShiftBlock';
import { useShiftRequests } from '../useShiftRequests';

const WEEKS_AHEAD = 8;
const plusDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const STATUS = {
  pending_peer: ['Waiting On Teammate', 'hsl(var(--color-orange))'], pending_manager: ['Waiting On Manager', 'hsl(var(--color-orange))'],
  approved: ['Approved', 'hsl(var(--color-green))'], declined: ['Declined', 'hsl(var(--color-red))'], cancelled: ['Cancelled', 'var(--muted)'],
};
const KIND_ICON = { swap: ArrowLeftRight, offer: Send, open: Hand };
const card = { background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 12, padding: '10px 12px' };
const pill = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 7,
  border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' };

function Chip({ status }) {
  const [label, color] = STATUS[status] || [status, 'var(--muted)'];
  return <span style={{ fontSize: 11, fontWeight: 700, color, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>{status === 'approved' && <CheckCircle2 size={12} />}{label}</span>;
}

export default function WorkdayShiftRequests({ toast }) {
  const nameOf = useNameResolver();
  const [start, end] = useMemo(() => { const t = new Date(); return [toDateInputValue(t), toDateInputValue(plusDays(t, WEEKS_AHEAD * 7))]; }, []);
  const [reqs, reloadReqs, reqsError] = useShiftRequests(start, end);
  const [mine, setMine] = useState(null);
  const [mineError, setMineError] = useState(false);
  const [tick, setTick] = useState(0);
  const [asking, setAsking] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    setMineError(false);
    api.timeMySchedule(start, end)
      .then((r) => { if (live) setMine((r?.scheduled || []).filter((s) => s.date >= start)); })
      .catch(() => { if (live) { setMine([]); setMineError(true); } });
    return () => { live = false; };
  }, [start, end, tick]);

  const retry = () => { reloadReqs(); setTick((t) => t + 1); };
  const done = (msg) => { setAsking(false); toast?.(true, msg); retry(); };
  async function act(fn, id, msg) {
    setBusyId(id);
    try { await fn(); toast?.(true, msg); retry(); } catch (e) { toast?.(false, e.message || 'Something went wrong.'); }
    setBusyId('');
  }
  const cfg = reqs?.settings || {};
  const anyKind = cfg.swaps !== false || cfg.offers !== false || cfg.openShifts !== false;
  const incoming = reqs?.incoming || [];
  const list = reqs?.mine || [];
  const shownList = showAll ? list : list.slice(0, 10);
  const who = (p) => (p ? nameOf(p.email, p.name) : 'a teammate');
  const mySummary = (r) => {
    if (r.kind === 'open') return `You asked for the open shift ${span(r.shift)}`;
    if (r.kind === 'swap') return `You asked to swap ${span(r.shift)} for ${who(r.target)}'s ${span(r.targetShift)}`;
    return `You offered ${span(r.shift)} to ${who(r.target)}`;
  };

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16, padding: '16px 18px', marginBottom: 12, boxShadow: 'var(--wk-shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10, flexWrap: 'wrap' }}>
        <span className="wkc-chip"><CalendarClock size={14} /></span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', flex: 1 }}>Shift Requests</span>
        <button type="button" className="primary-btn" onClick={() => setAsking(true)} disabled={!reqs || mine === null || !anyKind}
          title={anyKind ? undefined : 'Shift requests are turned off by your company'}
          style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={13} /> New Request</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
        Swap a shift with a teammate, offer one away, or ask for an open shift. A swap or an offer goes to your teammate first, then to a manager.
      </div>
      <AsyncSection loading={!reqs && !reqsError} error={!!reqsError} onRetry={retry} errorMessage="Your shift requests could not be loaded right now." skeleton={<SkeletonBlocks count={2} height={48} borderRadius={10} />}
        isEmpty={!incoming.length && !list.length} emptyContent={<div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '8px 0' }}>No shift requests yet.</div>}>
        {mineError && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', marginBottom: 8 }}>Your shared shifts could not be loaded, so a swap or an offer may not be possible right now.</div>}
        <div style={{ display: 'grid', gap: 8 }}>
          {incoming.map((r) => {
            const Icon = KIND_ICON[r.kind] || Hand;
            return (
              <div key={r.id} style={{ ...card, borderColor: 'var(--wk-brand)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', gap: 5 }}><Icon size={12} /> Waiting On You</div>
                <div style={{ fontSize: 13, color: 'var(--ink)', margin: '4px 0' }}>{r.summary}.</div>
                {(r.shift || r.targetShift) && (
                  <div style={{ display: 'grid', gridTemplateColumns: r.targetShift ? '1fr auto 1fr' : '1fr', gap: 8, alignItems: 'center', maxWidth: 480, margin: '6px 0' }}>
                    {r.shift && <ShiftBlock shift={r.shift} style={{ marginBottom: 0 }}><div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{who(r.requester)} · {formatDate(r.shift.date)}</div></ShiftBlock>}
                    {r.targetShift && <ArrowLeftRight size={14} color="var(--muted)" />}
                    {r.targetShift && <ShiftBlock shift={r.targetShift} style={{ marginBottom: 0 }}><div style={{ fontSize: 10.5, color: 'var(--muted)' }}>You · {formatDate(r.targetShift.date)}</div></ShiftBlock>}
                  </div>
                )}
                {r.note && <div style={{ fontSize: 12, color: 'var(--muted)' }}>“{r.note}”</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button type="button" className="primary-btn" style={{ fontSize: 12, padding: '4px 12px' }} disabled={busyId === r.id}
                    onClick={() => act(() => api.shiftRequestRespond(r.id, { accept: true }), r.id, 'Accepted. A manager will approve it next.')}>Accept</button>
                  <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '4px 12px' }} disabled={busyId === r.id}
                    onClick={() => act(() => api.shiftRequestRespond(r.id, { accept: false }), r.id, 'Declined.')}>Decline</button>
                </div>
              </div>
            );
          })}
          {shownList.map((r) => (
            <div key={r.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 200, fontSize: 12.5, color: 'var(--ink)' }}>
                {mySummary(r)}
                {r.decisionNote ? <span style={{ color: 'var(--muted)' }}> · {r.decisionNote}</span> : null}
              </span>
              <Chip status={r.status} />
              {PENDING.includes(r.status) && (
                <button type="button" style={pill} disabled={busyId === r.id} onClick={() => act(() => api.shiftRequestCancel(r.id), r.id, 'Request cancelled.')}>Cancel</button>
              )}
            </div>
          ))}
          {list.length > 10 && !showAll && (
            <button type="button" className="secondary-btn" onClick={() => setShowAll(true)} style={{ fontSize: 12, justifySelf: 'start' }}>Show All {list.length}</button>
          )}
        </div>
      </AsyncSection>
      {asking && reqs && (
        <ShiftRequestDialog reqs={reqs} myShifts={mine || []} nameOf={nameOf} onClose={() => setAsking(false)} onDone={done} />
      )}
    </div>
  );
}
