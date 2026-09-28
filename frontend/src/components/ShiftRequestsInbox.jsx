// Manager inbox for shift requests (Sep 29 2026, Teams Shifts parity):
// open-shift requests, and swaps/offers the teammate already accepted, for
// people this manager is responsible for (backend routers/shift_requests.py
// scopes it). Approve or decline with an optional note; the on/off switches
// for each request type live here too.
import { useEffect, useState } from 'react';
import { X, CheckCircle2, XCircle, ArrowLeftRight, Send, Hand } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';

const KIND = { open: ['Open shift', Hand], swap: ['Swap', ArrowLeftRight], offer: ['Offer', Send] };

export default function ShiftRequestsInbox({ onClose, onChanged, toastOk, toastErr }) {
  const [data, setData] = useState(null);
  const [notes, setNotes] = useState({});
  const [busyId, setBusyId] = useState('');
  const [cfg, setCfg] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.shiftRequestsInbox()
      .then((r) => { if (live) { setData(r); setCfg(r.settings); } })
      .catch((e) => { if (live) { setData({ pending: [], recent: [] }); toastErr?.(e.message || 'Could not load requests.'); } });
    return () => { live = false; };
  }, [tick, toastErr]);

  async function decide(r, approve) {
    setBusyId(r.id);
    try {
      await api.shiftRequestDecide(r.id, { approve, note: notes[r.id] || '' });
      toastOk?.(approve ? 'Approved. The schedule is updated and everyone involved was told.' : 'Declined. Everyone involved was told.');
      setTick((t) => t + 1); onChanged?.();
    } catch (e) { toastErr?.(e.message || 'Could not save the decision.'); }
    setBusyId('');
  }

  async function saveCfg(next) {
    setCfg(next);
    try { setCfg(await api.shiftRequestSettingsSave(next)); toastOk?.('Request settings saved.'); }
    catch (e) { toastErr?.(e.message || 'Could not save the settings.'); setTick((t) => t + 1); }
  }

  const row = { border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Shift Requests" style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 620, padding: 20, maxHeight: '92dvh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Shift Requests</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Requests from your team waiting on a manager. Swaps and offers show here once the teammate has accepted.
        </div>

        {data === null ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: 16, textAlign: 'center' }}>Loading…</div>
        ) : data.pending.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: 16, textAlign: 'center' }}>Nothing waiting on you.</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {data.pending.map((r) => {
              const [label, Icon] = KIND[r.kind] || [r.kind, Hand];
              return (
                <div key={r.id} style={row}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    <Icon size={12} /> {label} <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· asked {formatDateTime(r.createdAt + 'Z')}</span>
                  </div>
                  <div style={{ fontSize: 13.5, color: 'var(--ink)', margin: '4px 0' }}>{r.summary}.</div>
                  {r.note && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.requester.name}: “{r.note}”</div>}
                  {r.peerNote && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.target?.name}: “{r.peerNote}”</div>}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <input className="form-input" aria-label="Note to the team" placeholder="Note (optional)" value={notes[r.id] || ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} style={{ flex: 1, minWidth: 160, fontSize: 12.5 }} />
                    <button type="button" className="primary-btn" disabled={busyId === r.id} onClick={() => decide(r, true)} style={{ fontSize: 12.5 }}>Approve</button>
                    <button type="button" className="secondary-btn" disabled={busyId === r.id} onClick={() => decide(r, false)} style={{ fontSize: 12.5 }}>Decline</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {data?.recent?.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Recently Decided</div>
            {data.recent.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '5px 0', borderTop: '1px solid var(--line)' }}>
                {r.status === 'approved' ? <CheckCircle2 size={13} color="#15803d" /> : <XCircle size={13} color="#b91c1c" />}
                <span style={{ flex: 1 }}>{r.summary}</span>
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatDate(r.decidedAt + 'Z')}</span>
              </div>
            ))}
          </div>
        )}

        {cfg && (
          <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Settings</div>
            {[['openShifts', 'Staff can request open shifts'], ['swaps', 'Staff can swap shifts with teammates'], ['offers', 'Staff can offer their shifts to teammates']].map(([k, text]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', padding: '3px 0' }}>
                <input type="checkbox" checked={!!cfg[k]} onChange={(e) => saveCfg({ ...cfg, [k]: e.target.checked })} /> {text}
              </label>
            ))}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Every request still needs a manager's approval. Turning one off stops new requests of that kind.</div>
          </div>
        )}
      </div>
    </div>
  );
}
