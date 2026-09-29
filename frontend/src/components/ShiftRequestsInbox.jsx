// Manager inbox for shift requests (Sep 29 2026, Teams Shifts parity):
// open-shift requests, and swaps/offers the teammate already accepted, for
// people this manager is responsible for (backend routers/shift_requests.py
// scopes it) - and pending TIME-OFF requests too, decided through the same
// endpoint the time-off screen uses (PATCH /timeclock/timeoff/{id}), so its
// rules and notifications are unchanged. Approve or decline with an optional
// note; the on/off switches live here too.
import { useEffect, useState } from 'react';
import { X, CheckCircle2, XCircle, ArrowLeftRight, Send, Hand, CalendarOff, Lock } from 'lucide-react';
import { api } from '../api';
import { formatDate, formatDateTime } from '../lib/datetime';
import { ZONE_GROUPS, zoneOptionLabel } from '../lib/worldClockZones';

const KIND = { open: ['Open shift', Hand], swap: ['Swap', ArrowLeftRight], offer: ['Offer', Send] };
const hhmm12 = (v) => { const [h, m] = (v || '0:0').split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };

export default function ShiftRequestsInbox({ onClose, onChanged, toastOk, toastErr, canConfigure = true }) {
  const [data, setData] = useState(null);
  const [notes, setNotes] = useState({});
  const [busyId, setBusyId] = useState('');
  const [cfg, setCfg] = useState(null);
  const [timeoff, setTimeoff] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.shiftRequestsInbox()
      .then((r) => { if (live) { setData(r); setCfg(r.settings); } })
      .catch((e) => { if (live) { setData({ pending: [], recent: [] }); toastErr?.(e.message || 'Could not load requests.'); } });
    api.timeOffList('pending')
      .then((r) => { if (live) setTimeoff(Array.isArray(r) ? r : []); })
      .catch(() => { if (live) setTimeoff([]); });
    return () => { live = false; };
  }, [tick, toastErr]);

  async function decideTimeOff(t, approve) {
    setBusyId(t.id);
    try {
      await api.timeOffDecide(t.id, { status: approve ? 'approved' : 'rejected', note: notes[t.id] || '' });
      toastOk?.(approve ? 'Time off approved. They were told.' : 'Time off declined. They were told.');
      setTick((x) => x + 1); onChanged?.();
    } catch (e) { toastErr?.(e.message || 'Could not save the decision.'); }
    setBusyId('');
  }

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
        ) : data.pending.length === 0 && !(timeoff || []).length ? (
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

        {(timeoff || []).length > 0 && (
          <div style={{ marginTop: data?.pending?.length ? 18 : 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Time Off</div>
            <div style={{ display: 'grid', gap: 10 }}>
              {timeoff.map((t) => {
                const when = t.startDate === t.endDate ? formatDate(t.startDate) : `${formatDate(t.startDate)} - ${formatDate(t.endDate)}`;
                const hours = t.startTime && t.endTime ? `, ${hhmm12(t.startTime)} - ${hhmm12(t.endTime)}` : '';
                return (
                  <div key={t.id} style={row}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                      <CalendarOff size={12} /> {t.redacted ? 'Time off' : `Time off · ${t.type}`}
                      {t.confidential && (
                        <span title="Confidential - the type and reason are visible only to the employee and their approver"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4, textTransform: 'none', letterSpacing: 0 }}>
                          <Lock size={11} /> Confidential
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13.5, color: 'var(--ink)', margin: '4px 0' }}>{t.name || t.email} · {when}{hours}</div>
                    {/* Why they are off - what the approver decides on. A redacted
                        (confidential, not yours to decide) request shows neither. */}
                    {!t.redacted && (
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        <span style={{ fontWeight: 700 }}>Reason:</span> {t.note || 'None given'}
                      </div>
                    )}
                    {t.canDecide === false ? (
                      // Confidential and not yours to decide, or your own request.
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                        {t.reviewer ? `${t.reviewer} decides this request.` : 'Your manager decides this request.'}
                      </div>
                    ) : (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <input className="form-input" aria-label="Note to the employee" placeholder="Note (optional)" value={notes[t.id] || ''}
                        onChange={(e) => setNotes((n) => ({ ...n, [t.id]: e.target.value }))} style={{ flex: 1, minWidth: 160, fontSize: 12.5 }} />
                      <button type="button" className="primary-btn" disabled={busyId === t.id} onClick={() => decideTimeOff(t, true)} style={{ fontSize: 12.5 }}>Approve</button>
                      <button type="button" className="secondary-btn" disabled={busyId === t.id} onClick={() => decideTimeOff(t, false)} style={{ fontSize: 12.5 }}>Decline</button>
                    </div>
                    )}
                  </div>
                );
              })}
            </div>
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

        {cfg && canConfigure && (
          <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Settings</div>
            {[['openShifts', 'Staff can request open shifts'], ['swaps', 'Staff can swap shifts with teammates'], ['offers', 'Staff can offer their shifts to teammates'],
              ['teamSchedules', 'Staff can see their teammates’ shifts in My Shifts'],
              ['teamShiftDetails', 'Staff can see the notes, activities and breaks on teammates’ shifts'],
              ['teamTimeOffReasons', 'Staff can see why a teammate is off, and their note'],
              ['timeOffRequests', 'Staff can request time off']].map(([k, text]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer', padding: '3px 0' }}>
                <input type="checkbox" checked={!!cfg[k]} onChange={(e) => saveCfg({ ...cfg, [k]: e.target.checked })} /> {text}
              </label>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '3px 0', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={cfg.reminders !== false} onChange={(e) => saveCfg({ ...cfg, reminders: e.target.checked })} />
                Remind staff before a scheduled shift
              </label>
              <select className="form-input" aria-label="Reminder lead time" disabled={cfg.reminders === false}
                value={cfg.reminderLeadMinutes || 60} onChange={(e) => saveCfg({ ...cfg, reminderLeadMinutes: Number(e.target.value) })}
                style={{ width: 'auto', fontSize: 12.5, padding: '3px 30px 3px 8px' }}>
                {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} ${m === 60 ? 'hour' : 'hours'}`} before</option>)}
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '3px 0', flexWrap: 'wrap' }}>
              Team time zone
              <select className="form-input" aria-label="Team time zone" value={cfg.timeZone || 'America/Los_Angeles'}
                onChange={(e) => saveCfg({ ...cfg, timeZone: e.target.value })} style={{ width: 'auto', fontSize: 12.5, padding: '3px 30px 3px 8px' }}>
                {Object.entries(ZONE_GROUPS).map(([region, zones]) => (
                  <optgroup key={region} label={region}>
                    {zones.map((tz) => <option key={tz} value={tz}>{zoneOptionLabel(tz)}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <TimeOffReasons toastOk={toastOk} toastErr={toastErr} />
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>Every request still needs a manager's approval. Turning one off stops new requests of that kind. Hiding teammates’ shifts still lets staff pick a shift to swap for. A confidential time-off reason is never shown to teammates. The team time zone is what a shift with no preset runs on, and what a new preset starts with.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Custom time-off reasons (Sep 29, Teams parity), e.g. "Jury Duty", next to
// the built-in Vacation / Sick / Personal / Unpaid / Other. Removing one
// leaves existing requests of that type as they are.
function TimeOffReasons({ toastOk, toastErr }) {
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    let live = true;
    api.timeOffTypes().then((r) => { if (live) setList(r.custom || []); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, []);
  async function save(next) {
    try { const r = await api.timeOffTypesSave({ custom: next }); setList(r.custom); setDraft(''); toastOk?.('Time-off reasons saved.'); }
    catch (e) { toastErr?.(e.message || 'Could not save the reasons.'); }
  }
  if (!list) return null;
  const add = () => { const v = draft.trim(); if (v) save([...list, v]); };
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12.5, marginBottom: 5 }}>Extra time-off reasons</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {list.map((r) => (
          <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, border: '1px solid var(--line)', borderRadius: 999, padding: '2px 4px 2px 10px' }}>
            {r}
            <button type="button" aria-label={`Remove ${r}`} onClick={() => save(list.filter((x) => x !== r))}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', padding: 2 }}><X size={12} /></button>
          </span>
        ))}
        <input className="form-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Jury Duty" aria-label="New time-off reason"
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }} style={{ width: 150, fontSize: 12.5, padding: '3px 8px' }} />
        <button type="button" className="secondary-btn" onClick={add} disabled={!draft.trim()} style={{ fontSize: 12 }}>Add Reason</button>
      </div>
    </div>
  );
}
