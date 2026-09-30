// Shift self-service for employees (Sep 29 2026, Teams Shifts parity) - the
// parts of My Workday > Shifts (MyShifts.jsx) that let a person act on their
// schedule: ask for an open shift, swap a shift with a teammate, or offer one
// away. Every request needs a manager's approval (and a swap/offer the
// teammate's first) - see backend routers/shift_requests.py.
import { useState } from 'react';
import { ArrowLeftRight, Send, Hand, X, CheckCircle2, Clock, CalendarOff } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';

const PENDING = ['pending_peer', 'pending_manager'];

function hhmm12(hhmm) {
  const [h, m] = (hhmm || '').split(':').map(Number);
  if (Number.isNaN(h)) return hhmm || '';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
const span = (s) => `${formatDate(s.date)} · ${hhmm12(s.start)} - ${hhmm12(s.end)}`;

const pill = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 7,
  border: '1px solid var(--wk-line2)', background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontFamily: 'inherit' };

/** Swap / Offer under one of my own upcoming, placed shifts. */
export function ShiftActions({ shift, todayKey, reqs, onAsk }) {
  if (!reqs || shift.fromPreset || !shift.date || shift.date < todayKey) return null;
  const cfg = reqs.settings || {};
  const hasTeam = (reqs.teammates || []).length > 0;
  const pending = (reqs.mine || []).some((r) => r.shift.id === shift.id && PENDING.includes(r.status));
  if (pending) return <div style={{ fontSize: 11, color: '#b45309', fontWeight: 600, marginTop: 5 }}>Request pending</div>;
  if (!hasTeam || (!cfg.swaps && !cfg.offers)) return null;
  return (
    <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
      {cfg.swaps && <button type="button" style={pill} onClick={() => onAsk({ kind: 'swap', shift })}><ArrowLeftRight size={11} /> Swap</button>}
      {cfg.offers && <button type="button" style={pill} onClick={() => onAsk({ kind: 'offer', shift })}><Send size={11} /> Offer</button>}
    </div>
  );
}

/** The swap / offer form. `teamShifts` = {email: [placed published shifts this week]}. */
export function RequestDialog({ ask, teammates, teamShifts, todayKey, onClose, onDone }) {
  const { kind, shift } = ask;
  const [target, setTarget] = useState('');
  const [targetShift, setTargetShift] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const theirs = (teamShifts[target] || []).filter((s) => s.date >= todayKey);
  const ready = target && (kind === 'offer' || targetShift) && !busy;

  async function send() {
    setBusy(true); setErr('');
    try {
      await api.shiftRequestCreate({ kind, shift_id: shift.id, target_email: target, target_shift_id: kind === 'swap' ? targetShift : '', note });
      const who = teammates.find((t) => t.email === target)?.name || target;
      onDone(kind === 'swap' ? `Swap request sent to ${who}.` : `Shift offered to ${who}.`);
    } catch (e) { setErr(e.message || 'Could not send the request.'); setBusy(false); }
  }

  const lbl = { fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={kind === 'swap' ? 'Swap Shift' : 'Offer Shift'}
        style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 440, padding: 20, maxHeight: '92dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{kind === 'swap' ? 'Swap Shift' : 'Offer Shift'}</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>
          Your shift: <b style={{ color: 'var(--ink)' }}>{span(shift)}</b>. {kind === 'swap' ? 'Your teammate accepts first' : 'Your teammate accepts it first'}, then a manager approves.
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <label><div style={lbl}>Teammate</div>
            <select className="form-select" value={target} onChange={(e) => { setTarget(e.target.value); setTargetShift(''); }} style={{ width: '100%' }}>
              <option value="">Pick a teammate</option>
              {teammates.map((t) => <option key={t.email} value={t.email}>{t.name}</option>)}
            </select>
          </label>
          {kind === 'swap' && target && (
            <label><div style={lbl}>Their shift</div>
              {theirs.length ? (
                <select className="form-select" value={targetShift} onChange={(e) => setTargetShift(e.target.value)} style={{ width: '100%' }}>
                  <option value="">Pick one of their shifts</option>
                  {theirs.map((s) => <option key={s.id} value={s.id}>{span(s)}{s.label ? ` · ${s.label}` : ''}</option>)}
                </select>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>They have no upcoming shifts this week. Move to another week to pick one.</div>
              )}
            </label>
          )}
          <label><div style={lbl}>Note (optional)</div>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, or anything they should know" style={{ width: '100%' }} />
          </label>
          {err && <div role="alert" style={{ fontSize: 12.5, color: '#b91c1c' }}>{err}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={send} disabled={!ready} style={{ opacity: ready ? 1 : 0.55 }}>
            {busy ? '…' : kind === 'swap' ? 'Send Swap Request' : 'Send Offer'}
          </button>
        </div>
      </div>
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 12, padding: '10px 12px' };

/** Published open shifts I could ask for. */
export function OpenShifts({ reqs, onDone }) {
  const [busyId, setBusyId] = useState('');
  const [err, setErr] = useState('');
  const list = reqs?.settings?.openShifts ? reqs.openShifts || [] : [];
  if (!list.length) return null;
  async function ask(s) {
    setBusyId(s.id); setErr('');
    try { await api.shiftRequestCreate({ kind: 'open', shift_id: s.id }); onDone('Request sent. A manager will approve it.'); }
    catch (e) { setErr(e.message || 'Could not send the request.'); }
    setBusyId('');
  }
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>Open Shifts</div>
      {err && <div role="alert" style={{ fontSize: 12.5, color: '#b91c1c', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {list.map((s) => (
          <div key={s.id} style={card}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 5 }}><Clock size={12} /> {span(s)}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '3px 0 8px' }}>
              {s.label || s.code || 'Open shift'} · {s.openSlots} {s.openSlots === 1 ? 'spot' : 'spots'} open
            </div>
            {s.requested
              ? <span style={{ fontSize: 11.5, fontWeight: 700, color: '#b45309' }}>Requested</span>
              : <button type="button" style={pill} disabled={busyId === s.id} onClick={() => ask(s)}><Hand size={11} /> Request</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

const STATUS = {
  pending_peer: ['Waiting on your teammate', '#b45309'], pending_manager: ['Waiting on a manager', '#b45309'],
  approved: ['Approved', 'hsl(var(--color-green))'], declined: ['Declined', '#b91c1c'], cancelled: ['Cancelled', 'var(--muted)'],
};

// My own request, in my words.
function mySummary(r) {
  const mine = span(r.shift);
  if (r.kind === 'open') return `You asked for the open shift ${mine}`;
  const who = r.target?.name || r.target?.email || 'a teammate';
  if (r.kind === 'swap') return `You asked to swap ${mine} for ${who}'s ${span(r.targetShift || {})}`;
  return `You offered ${mine} to ${who}`;
}

/** Swaps/offers waiting on me, then my own requests. */
export function ShiftRequestsList({ reqs, onDone }) {
  const [busyId, setBusyId] = useState('');
  const [err, setErr] = useState('');
  const incoming = reqs?.incoming || [];
  const mine = (reqs?.mine || []).slice(0, 10);
  if (!incoming.length && !mine.length) return null;
  async function act(fn, id, msg) {
    setBusyId(id); setErr('');
    try { await fn(); onDone(msg); } catch (e) { setErr(e.message || 'Something went wrong.'); }
    setBusyId('');
  }
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginBottom: 8 }}>Shift Requests</div>
      {err && <div role="alert" style={{ fontSize: 12.5, color: '#b91c1c', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'grid', gap: 8 }}>
        {incoming.map((r) => (
          <div key={r.id} style={{ ...card, borderColor: 'var(--wk-brand)' }}>
            <div style={{ fontSize: 13, color: 'var(--ink)' }}>{r.summary}.</div>
            {r.note && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>“{r.note}”</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button type="button" className="primary-btn" style={{ fontSize: 12, padding: '4px 12px' }} disabled={busyId === r.id}
                onClick={() => act(() => api.shiftRequestRespond(r.id, { accept: true }), r.id, 'Accepted. A manager will approve it next.')}>Accept</button>
              <button type="button" className="secondary-btn" style={{ fontSize: 12, padding: '4px 12px' }} disabled={busyId === r.id}
                onClick={() => act(() => api.shiftRequestRespond(r.id, { accept: false }), r.id, 'Declined.')}>Decline</button>
            </div>
          </div>
        ))}
        {mine.map((r) => {
          const [label, color] = STATUS[r.status] || [r.status, 'var(--muted)'];
          return (
            <div key={r.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 200, fontSize: 12.5, color: 'var(--ink)' }}>
                {mySummary(r)}
                {r.decisionNote ? <span style={{ color: 'var(--muted)' }}> · {r.decisionNote}</span> : null}
              </span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {r.status === 'approved' && <CheckCircle2 size={12} />}{label}
              </span>
              {PENDING.includes(r.status) && (
                <button type="button" style={pill} disabled={busyId === r.id}
                  onClick={() => act(() => api.shiftRequestCancel(r.id), r.id, 'Request cancelled.')}>Cancel</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** New Request (Shifts > Requests, Sep 30): pick what to ask for, then which
 *  of my upcoming published shifts it is about. Time off is asked for in
 *  Workday, so that choice takes the person there. */
export function NewRequestDialog({ reqs, myShifts = [], onClose, onDone }) {
  const cfg = reqs?.settings || {};
  const teammates = reqs?.teammates || [];
  const teamShifts = reqs?.swapShifts || {};
  const kinds = [
    ['swap', 'Swap', ArrowLeftRight, cfg.swaps !== false, 'Trade one of your shifts for a teammate\u2019s'],
    ['offer', 'Offer', Send, cfg.offers !== false, 'Give one of your shifts to a teammate'],
    ['timeoff', 'Time Off', CalendarOff, cfg.timeOffRequests !== false, 'Ask for a day, or part of a day, off'],
  ];
  const [kind, setKind] = useState((kinds.find((k) => k[3]) || kinds[0])[0]);
  const [shiftId, setShiftId] = useState('');
  const [target, setTarget] = useState('');
  const [targetShift, setTargetShift] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pending = new Set((reqs?.mine || []).filter((r) => PENDING.includes(r.status)).map((r) => r.shift.id));
  const free = myShifts.filter((s) => !pending.has(s.id));
  const theirs = teamShifts[target] || [];
  const shifting = kind !== 'timeoff';
  const blocked = !shifting ? '' : !teammates.length
    ? 'You are not on a team yet, so there is nobody to swap with. Ask your manager to add you to one.'
    : !free.length
      ? 'You have no published shifts coming up. A swap or an offer needs a shift your manager has published.'
      : '';
  const ready = shifting && !blocked && shiftId && target && (kind === 'offer' || targetShift) && !busy;

  async function send() {
    setBusy(true); setErr('');
    try {
      await api.shiftRequestCreate({ kind, shift_id: shiftId, target_email: target, target_shift_id: kind === 'swap' ? targetShift : '', note });
      const who = teammates.find((t) => t.email === target)?.name || target;
      onDone(kind === 'swap' ? `Swap request sent to ${who}.` : `Shift offered to ${who}.`);
    } catch (e) { setErr(e.message || 'Could not send the request.'); setBusy(false); }
  }
  function openTimeOff() {
    window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'timeclock', sub: 'timeoff' } }));
    onClose();
  }

  const lbl = { fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="New Request"
        style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 480, padding: 20, maxHeight: '92dvh', overflowY: 'auto', fontFamily: 'Inter,sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>New Request</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div role="group" aria-label="Request type" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
          {kinds.map(([k, label, Icon, on]) => (
            <button key={k} type="button" aria-pressed={kind === k} disabled={!on} title={on ? undefined : 'Turned off by your company'}
              onClick={() => { setKind(k); setErr(''); setTargetShift(''); }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '10px 6px', borderRadius: 10, cursor: on ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, opacity: on ? 1 : 0.45,
                border: `1px solid ${kind === k ? 'var(--wk-brand)' : 'var(--wk-line2)'}`,
                background: kind === k ? 'var(--wk-brand-tint)' : 'var(--card)', color: kind === k ? 'var(--wk-brand)' : 'var(--ink)' }}>
              <Icon size={16} /> {label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>
          {kinds.find((k) => k[0] === kind)[4]}.{shifting ? ' Your teammate accepts first, then a manager approves.' : ' Your manager approves it.'}
        </div>

        {!shifting ? (
          <div style={{ fontSize: 12.5, color: 'var(--ink)' }}>Time off is asked for in Workday, where your balance and past requests are.</div>
        ) : blocked ? (
          <div role="note" style={{ fontSize: 12.5, color: '#92400e', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 8, padding: '9px 12px' }}>{blocked}</div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <label><div style={lbl}>Your shift</div>
              <select className="form-select" aria-label="Your shift" value={shiftId} onChange={(e) => setShiftId(e.target.value)} style={{ width: '100%' }}>
                <option value="">Pick one of your shifts</option>
                {free.map((s) => <option key={s.id} value={s.id}>{span(s)}{s.label ? ` · ${s.label}` : ''}</option>)}
              </select>
            </label>
            <label><div style={lbl}>Teammate</div>
              <select className="form-select" aria-label="Teammate" value={target} onChange={(e) => { setTarget(e.target.value); setTargetShift(''); }} style={{ width: '100%' }}>
                <option value="">Pick a teammate</option>
                {teammates.map((t) => <option key={t.email} value={t.email}>{t.name}</option>)}
              </select>
            </label>
            {kind === 'swap' && target && (
              <label><div style={lbl}>Their shift</div>
                {theirs.length ? (
                  <select className="form-select" aria-label="Their shift" value={targetShift} onChange={(e) => setTargetShift(e.target.value)} style={{ width: '100%' }}>
                    <option value="">Pick one of their shifts</option>
                    {theirs.map((s) => <option key={s.id} value={s.id}>{span(s)}{s.label ? ` · ${s.label}` : ''}</option>)}
                  </select>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>They have no published shifts coming up. Offer your shift instead, or pick someone else.</div>
                )}
              </label>
            )}
            <label><div style={lbl}>Note (optional)</div>
              <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, or anything they should know" style={{ width: '100%' }} />
            </label>
          </div>
        )}
        {err && <div role="alert" style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 10 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          {shifting ? (
            <button type="button" className="primary-btn" onClick={send} disabled={!ready} style={{ opacity: ready ? 1 : 0.55 }}>
              {busy ? '…' : kind === 'swap' ? 'Send Swap Request' : 'Send Offer'}
            </button>
          ) : (
            <button type="button" className="primary-btn" onClick={openTimeOff}>Open Time Off</button>
          )}
        </div>
      </div>
    </div>
  );
}
