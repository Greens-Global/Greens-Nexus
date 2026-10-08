// The one request dialog (Oct 2026): swap a shift, offer one away, or ask
// for an open shift. Workday > Time Off opens it from New Request; My Shifts
// opens it from the Request link under a shared shift with that shift
// filled in. The two near-identical forms it replaces (RequestDialog and
// NewRequestDialog in ShiftSelfService.jsx) are gone.
import { useState } from 'react';
import { ArrowLeftRight, Send, Hand, X } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatWeekday } from '../../lib/datetime';
import { ShiftBlock } from './ShiftBlock';
import { shiftTimeText, todayIso } from './shiftLib';

export const PENDING = ['pending_peer', 'pending_manager'];
export const span = (s) => (s ? `${formatWeekday(s.date, 'short')} ${formatDate(s.date)} · ${shiftTimeText(s)}` : '');
const LBL = { fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 };

export default function ShiftRequestDialog({ reqs, myShifts = [], shift = null, kind: initialKind = '', nameOf, onClose, onDone }) {
  const cfg = reqs?.settings || {};
  const teammates = reqs?.teammates || [];
  const teamShifts = reqs?.swapShifts || {};
  const openShifts = cfg.openShifts ? (reqs?.openShifts || []).filter((s) => s.date >= todayIso()) : [];
  const kinds = [
    ['swap', 'Swap', ArrowLeftRight, cfg.swaps !== false, 'Trade one of your shifts for a teammate’s'],
    ['offer', 'Offer', Send, cfg.offers !== false, 'Give one of your shifts to a teammate'],
    ['open', 'Open Shift', Hand, cfg.openShifts !== false, 'Ask for a shift nobody has yet'],
  ];
  const [kind, setKind] = useState(() => (initialKind && kinds.find((k) => k[0] === initialKind && k[3]) ? initialKind : (kinds.find((k) => k[3]) || kinds[0])[0]));
  const [shiftId, setShiftId] = useState(shift?.id || '');
  const [target, setTarget] = useState('');
  const [targetShift, setTargetShift] = useState('');
  const [openId, setOpenId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pending = new Set((reqs?.mine || []).filter((r) => PENDING.includes(r.status)).map((r) => r.shift?.id));
  const free = myShifts.filter((s) => !pending.has(s.id) && s.date >= todayIso());
  const theirs = (teamShifts[target] || []).filter((s) => s.date >= todayIso());
  const who = (email, stored) => (nameOf ? nameOf(email, stored) : (stored || email));
  const blocked = kind === 'open'
    ? (!openShifts.length ? 'There are no open shifts to ask for right now.' : '')
    : !teammates.length ? 'You are not in a group yet, so there is nobody to swap with. Ask your manager to add you to one.'
      : !free.length ? 'You have no shared shifts coming up. A swap or an offer needs a shift your manager has shared.' : '';
  const ready = !busy && !blocked && (kind === 'open' ? !!openId : (shiftId && target && (kind === 'offer' || targetShift)));
  const mine = free.find((s) => s.id === shiftId) || shift;
  const picked = theirs.find((s) => s.id === targetShift);

  async function send() {
    setBusy(true); setErr('');
    try {
      if (kind === 'open') {
        await api.shiftRequestCreate({ kind: 'open', shift_id: openId });
        onDone('Request sent. A manager will approve it.');
        return;
      }
      await api.shiftRequestCreate({ kind, shift_id: shiftId, target_email: target, target_shift_id: kind === 'swap' ? targetShift : '', note });
      const name = who(target, teammates.find((t) => t.email === target)?.name);
      onDone(kind === 'swap' ? `Swap request sent to ${name}.` : `Shift offered to ${name}.`);
    } catch (e) { setErr(e.message || 'Could not send the request.'); setBusy(false); }
  }

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
          {kinds.find((k) => k[0] === kind)[4]}.{kind === 'open' ? ' A manager approves it.' : ' Your teammate accepts first, then a manager approves.'}
        </div>

        {blocked ? (
          <div role="note" style={{ fontSize: 12.5, color: 'var(--ink)', background: 'hsla(var(--color-orange),0.1)', border: '1px solid hsla(var(--color-orange),0.4)', borderRadius: 8, padding: '9px 12px' }}>{blocked}</div>
        ) : kind === 'open' ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={LBL}>Open shifts</div>
            {openShifts.map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: s.requested ? 'default' : 'pointer', opacity: s.requested ? 0.6 : 1 }}>
                <input type="radio" name="open-shift" aria-label={`Open shift ${span(s)}`} checked={openId === s.id} disabled={!!s.requested} onChange={() => setOpenId(s.id)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <ShiftBlock shift={s} open style={{ marginBottom: 0 }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{formatWeekday(s.date, 'short')} {formatDate(s.date)} · {s.openSlots || 1} {s.openSlots === 1 ? 'spot' : 'spots'}{s.requested ? ' · Requested' : ''}</div>
                  </ShiftBlock>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <label><div style={LBL}>Your shift</div>
              <select className="form-select" aria-label="Your shift" value={shiftId} onChange={(e) => setShiftId(e.target.value)} style={{ width: '100%' }}>
                <option value="">Pick one of your shifts</option>
                {free.map((s) => <option key={s.id} value={s.id}>{span(s)}{s.label ? ` · ${s.label}` : ''}</option>)}
              </select>
            </label>
            <label><div style={LBL}>Teammate</div>
              <select className="form-select" aria-label="Teammate" value={target} onChange={(e) => { setTarget(e.target.value); setTargetShift(''); }} style={{ width: '100%' }}>
                <option value="">Pick a teammate</option>
                {teammates.map((t) => <option key={t.email} value={t.email}>{who(t.email, t.name)}</option>)}
              </select>
            </label>
            {kind === 'swap' && target && (
              <label><div style={LBL}>Their shift</div>
                {theirs.length ? (
                  <select className="form-select" aria-label="Their shift" value={targetShift} onChange={(e) => setTargetShift(e.target.value)} style={{ width: '100%' }}>
                    <option value="">Pick one of their shifts</option>
                    {theirs.map((s) => <option key={s.id} value={s.id}>{span(s)}{s.label ? ` · ${s.label}` : ''}</option>)}
                  </select>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>They have no shared shifts coming up. Offer your shift instead, or pick someone else.</div>
                )}
              </label>
            )}
            {mine && (kind === 'offer' || picked) && (
              <div style={{ display: 'grid', gridTemplateColumns: kind === 'swap' ? '1fr auto 1fr' : '1fr', gap: 8, alignItems: 'center' }}>
                <ShiftBlock shift={mine} style={{ marginBottom: 0 }}><div style={{ fontSize: 10.5, color: 'var(--muted)' }}>You · {formatDate(mine.date)}</div></ShiftBlock>
                {kind === 'swap' && <ArrowLeftRight size={14} color="var(--muted)" />}
                {kind === 'swap' && picked && <ShiftBlock shift={picked} style={{ marginBottom: 0 }}><div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{who(target, teammates.find((t) => t.email === target)?.name)} · {formatDate(picked.date)}</div></ShiftBlock>}
              </div>
            )}
            <label><div style={LBL}>Note (optional)</div>
              <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, or anything they should know" style={{ width: '100%' }} />
            </label>
          </div>
        )}
        {err && <div role="alert" style={{ fontSize: 12.5, color: 'hsl(var(--color-red))', marginTop: 10 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" onClick={send} disabled={!ready} style={{ opacity: ready ? 1 : 0.55 }}>
            {busy ? '…' : kind === 'swap' ? 'Send Swap Request' : kind === 'offer' ? 'Send Offer' : 'Request Shift'}
          </button>
        </div>
      </div>
    </div>
  );
}
