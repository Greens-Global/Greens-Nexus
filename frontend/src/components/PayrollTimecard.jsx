import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Plus, X, Loader2, CheckCircle, Download, AlertTriangle } from 'lucide-react';
import { api } from '../api';

// ── Payroll timecard (SwipeClock-style, manager-editable) ─────────────────────
// One employee, one pay period (biweekly). In/out segments per day with manager
// edit/add, weekly overtime split (>40h at 1.5x), and wage totals off a
// manager-set hourly rate. Exact minutes, no rounding.

const ANCHOR = Date.UTC(2024, 0, 1);   // a Monday — biweekly periods count from here
const DAY = 86400000;
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
const hhmm = (min) => `${Math.floor((min || 0) / 60)}:${String((min || 0) % 60).padStart(2, '0')}`;
const money = (n) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const t12 = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase() : '—';
const utcToInput = (iso) => { const d = new Date(iso + 'Z'); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const inputToUtc = (v) => new Date(v).toISOString().slice(0, 19);

function periodStartFor(date) {
  const mon = new Date(date); mon.setHours(0, 0, 0, 0);
  mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));       // Monday of this week
  const idx = Math.floor((mon.getTime() - ANCHOR) / (14 * DAY));
  return new Date(ANCHOR + idx * 14 * DAY);
}

export default function PayrollTimecard({ toastOk, toastErr }) {
  const [people, setPeople] = useState([]);
  const [email, setEmail] = useState('');
  const [pStart, setPStart] = useState(() => periodStartFor(new Date()));
  const [data, setData] = useState(null);
  const [rateInput, setRateInput] = useState('');
  const [editDay, setEditDay] = useState(null);   // { date, seg? }
  const [busy, setBusy] = useState(false);

  const start = isoDate(pStart);
  const end = isoDate(pStart.getTime() + 13 * DAY);
  const dates = useMemo(() => Array.from({ length: 14 }, (_, i) => isoDate(pStart.getTime() + i * DAY)), [pStart]);

  // employee list (scoped) for the picker
  useEffect(() => {
    api.timeTeam(start, end).then(r => {
      const list = (r.rows || []).map(x => ({ email: x.email, name: x.name || x.email }));
      setPeople(list);
      setEmail(e => e || list[0]?.email || '');
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(() => {
    if (!email) return;
    setData(null);
    api.timePayroll(email, start, end).then(d => { setData(d); setRateInput(d.rateSet ? String(d.rate) : ''); })
      .catch(e => { setData(null); toastErr?.(e?.message || 'Could not load the timecard.'); });
  }, [email, start, end, toastErr]);
  useEffect(load, [load]);

  const byDate = useMemo(() => Object.fromEntries((data?.days || []).map(d => [d.date, d])), [data]);
  const weekTotals = useMemo(() => {
    const w = {};
    (data?.days || []).forEach(d => { (w[d.weekStart] ||= { min: 0 }).min += d.workedMin; });
    return w;
  }, [data]);
  const rate = data?.rate || 0;

  async function saveRate() {
    setBusy(true);
    try { await api.timePayrollRate({ email, hourly_rate: parseFloat(rateInput) || 0 }); toastOk?.('Pay rate saved.'); load(); }
    catch (e) { toastErr?.(e?.message || 'Could not save rate.'); }
    setBusy(false);
  }
  async function approve() {
    setBusy(true);
    try { await api.timeApprove({ email, start, end }); toastOk?.('Timecard approved — the employee is notified.'); }
    catch (e) { toastErr?.(e?.message || 'Could not approve.'); }
    setBusy(false);
  }

  const shift = (n) => setPStart(new Date(pStart.getTime() + n * 14 * DAY));
  const label = `${pStart.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' })} – ${new Date(pStart.getTime() + 13 * DAY).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' })}`;
  const T = data?.totals;

  const th = { fontSize: 10, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', padding: '7px 10px', textAlign: 'right', whiteSpace: 'nowrap' };
  const td = { fontSize: 12.5, padding: '6px 10px', textAlign: 'right', borderTop: '1px solid var(--line)', whiteSpace: 'nowrap' };

  // build rows: for each date, its segments (or one empty row); weekly subtotal after each week
  const rows = [];
  let prevWeek = null;
  dates.forEach(ds => {
    const d = byDate[ds];
    const wk = d?.weekStart || (() => { const x = new Date(ds); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return isoDate(x); })();
    if (prevWeek && wk !== prevWeek) rows.push({ type: 'wk', week: prevWeek });
    prevWeek = wk;
    const segs = d?.segments || [];
    if (!segs.length) rows.push({ type: 'day', ds, seg: null });
    else segs.forEach((seg, i) => rows.push({ type: 'day', ds, seg, first: i === 0 }));
  });
  if (prevWeek) rows.push({ type: 'wk', week: prevWeek });

  const dow = (ds) => new Date(ds + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <select className="form-input" value={email} onChange={e => setEmail(e.target.value)} style={{ fontSize: 13, minWidth: 200, fontWeight: 700 }}>
          {people.map(p => <option key={p.email} value={p.email}>{p.name}</option>)}
        </select>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button className="icon-btn" onClick={() => shift(-1)} style={{ padding: 6 }}><ChevronLeft size={16} /></button>
          <span style={{ fontSize: 12.5, fontWeight: 700, minWidth: 175, textAlign: 'center' }}>{label}</span>
          <button className="icon-btn" onClick={() => shift(1)} style={{ padding: 6 }}><ChevronRight size={16} /></button>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 700 }}>Rate $/hr</span>
          <input type="number" min="0" step="0.01" className="form-input" value={rateInput} placeholder="0.00"
            onChange={e => setRateInput(e.target.value)} style={{ width: 90, fontSize: 13 }} />
          <button className="secondary-btn" onClick={saveRate} disabled={busy} style={{ fontSize: 12 }}>Save</button>
        </div>
      </div>

      {!data?.rateSet && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#b45309', marginBottom: 10 }}>
          <AlertTriangle size={13} /> No pay rate set for this employee — wages show $0 until you set one.
        </div>
      )}

      {data === null ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 12 }}>
          <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg)' }}>
                <th style={{ ...th, textAlign: 'left' }}>Date</th>
                <th style={{ ...th, textAlign: 'left' }}>In</th>
                <th style={{ ...th, textAlign: 'left' }}>Out</th>
                <th style={th}>Hours</th>
                <th style={th}>Non-OT</th>
                <th style={th}>OT</th>
                <th style={th}>Amount</th>
                <th style={{ ...th, width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => r.type === 'wk' ? (
                <tr key={i} style={{ background: 'hsla(var(--color-green),0.05)' }}>
                  <td colSpan={8} style={{ ...td, textAlign: 'center', fontWeight: 800, color: 'var(--pine)', fontSize: 12 }}>
                    Total hours for week of {new Date(r.week + 'T00:00').toLocaleDateString([], { month: 'numeric', day: 'numeric' })}: {hhmm(weekTotals[r.week]?.min || 0)}
                  </td>
                </tr>
              ) : (
                <tr key={i} className="pr-row">
                  <td style={{ ...td, textAlign: 'left', fontWeight: r.first === undefined ? 400 : 700, color: r.seg ? 'var(--ink)' : 'var(--muted)' }}>
                    {r.first === false ? '' : dow(r.ds)}
                  </td>
                  <td style={{ ...td, textAlign: 'left' }}>{r.seg ? t12(r.seg.in) : '—'}</td>
                  <td style={{ ...td, textAlign: 'left', color: r.seg && !r.seg.out ? '#b91c1c' : 'var(--ink)', fontWeight: r.seg && !r.seg.out ? 700 : 400 }}>
                    {r.seg ? (r.seg.out ? t12(r.seg.out) : 'Missing') : '—'}
                  </td>
                  <td style={td}>{r.seg ? hhmm(r.seg.workedMin) : '—'}</td>
                  <td style={td}>{r.seg?.regMin ? hhmm(r.seg.regMin) : '—'}</td>
                  <td style={{ ...td, color: r.seg?.otMin ? '#b45309' : 'var(--muted)', fontWeight: r.seg?.otMin ? 700 : 400 }}>{r.seg?.otMin ? hhmm(r.seg.otMin) : '—'}</td>
                  <td style={{ ...td, fontWeight: 700 }}>{r.seg ? money(r.seg.amount) : '—'}</td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <button onClick={() => setEditDay({ date: r.ds, seg: r.seg })}
                      title={r.seg ? 'Edit punch' : 'Add punch'}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}>
                      {r.seg ? <Pencil size={13} /> : <Plus size={14} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            {T && (
              <tfoot>
                <tr style={{ background: 'var(--bg)', fontWeight: 800 }}>
                  <td colSpan={3} style={{ ...td, textAlign: 'left' }}>Totals</td>
                  <td style={td}>{hhmm(T.regMin + T.otMin)}</td>
                  <td style={td}>{hhmm(T.regMin)}</td>
                  <td style={td}>{hhmm(T.otMin)}</td>
                  <td style={td}>{money(T.totalPay)}</td>
                  <td style={td}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Summary + acknowledgment */}
      {T && (
        <div style={{ marginTop: 14, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 260, border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
            {[
              [`Regular hours at ${money(rate)}/hr`, hhmm(T.regMin), money(T.regPay)],
              [`Overtime hours at ${money(rate * 1.5)}/hr`, hhmm(T.otMin), money(T.otPay)],
              ['Totals', hhmm(T.regMin + T.otMin), money(T.totalPay)],
            ].map(([lbl, hrs, amt], i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px', gap: 8, padding: '8px 12px', borderTop: i ? '1px solid var(--line)' : 'none', background: i === 2 ? 'var(--bg)' : 'transparent', fontWeight: i === 2 ? 800 : 500, fontSize: 12.5 }}>
                <span style={{ color: i === 2 ? 'var(--ink)' : 'var(--muted)' }}>{lbl}</span>
                <span style={{ textAlign: 'right' }}>{hrs}</span>
                <span style={{ textAlign: 'right' }}>{amt}</span>
              </div>
            ))}
          </div>
          <div style={{ minWidth: 200, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}>
              <span>Missing punches</span><span style={{ fontWeight: 700, color: T.missingPunches ? '#b91c1c' : 'var(--ink)' }}>{T.missingPunches}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--muted)' }}>
              <span>Edited punches</span><span style={{ fontWeight: 700 }}>{T.editedPunches}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="secondary-btn" onClick={() => api.timeExportCsv(start, end, 'punches')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> CSV</button>
              <button className="primary-btn" onClick={approve} disabled={busy} style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}><CheckCircle size={13} /> Approve</button>
            </div>
          </div>
        </div>
      )}
      {T && (
        <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, fontStyle: 'italic' }}>
          Overtime is calculated at over 40 hours per week (federal / WA / OR). Corrections keep the original punch on record.
        </p>
      )}

      {editDay && (
        <PunchEditModal day={editDay} email={email} busy={busy} setBusy={setBusy}
          onDone={() => { setEditDay(null); load(); }} onClose={() => setEditDay(null)}
          toastOk={toastOk} toastErr={toastErr} />
      )}
      <style>{`.pr-row:hover { background: var(--bg); }`}</style>
    </div>
  );
}

function PunchEditModal({ day, email, busy, setBusy, onDone, onClose, toastOk, toastErr }) {
  const seg = day.seg;
  const [inAt, setInAt] = useState(seg?.in ? utcToInput(seg.in) : `${day.date}T09:00`);
  const [outAt, setOutAt] = useState(seg?.out ? utcToInput(seg.out) : `${day.date}T17:00`);
  const tz = new Date().getTimezoneOffset();

  async function save() {
    setBusy(true);
    try {
      // Edit existing in-punch, or add one
      if (seg?.inId) { if (utcToInput(seg.in) !== inAt) await api.timeAdjustPunch(seg.inId, { at: inputToUtc(inAt) }); }
      else await api.timeAddPunch({ employee_email: email, kind: 'in', at: inputToUtc(inAt), tz_offset_min: tz, note: 'payroll edit' });
      // Edit existing out-punch, or add one
      if (seg?.outId) { if (utcToInput(seg.out) !== outAt) await api.timeAdjustPunch(seg.outId, { at: inputToUtc(outAt) }); }
      else await api.timeAddPunch({ employee_email: email, kind: 'out', at: inputToUtc(outAt), tz_offset_min: tz, note: 'payroll edit' });
      toastOk?.('Timecard updated — original times stay on record.'); onDone();
    } catch (e) { toastErr?.(e?.message || 'Could not save.'); }
    setBusy(false);
  }
  async function removeOut() {
    if (!seg?.outId) return;
    setBusy(true);
    try { await api.timeAdjustPunch(seg.outId, { void: true }); toastOk?.('Punch voided.'); onDone(); }
    catch (e) { toastErr?.(e?.message || 'Could not void.'); }
    setBusy(false);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 400, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{seg ? 'Edit punch' : 'Add punch'}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{new Date(day.date + 'T00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>Clock in<input type="datetime-local" className="form-input" value={inAt} onChange={e => setInAt(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>Clock out<input type="datetime-local" className="form-input" value={outAt} onChange={e => setOutAt(e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          {seg?.outId && <button onClick={removeOut} disabled={busy} style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Void out-punch</button>}
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy}>{busy ? '…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
