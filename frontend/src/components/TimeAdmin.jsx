import { useState, useEffect, useCallback } from 'react';
import {
  Clock, ChevronDown, ChevronRight, MapPin, AlertTriangle, Download,
  Pencil, Plus, Loader2, X, CheckCircle, Ban,
} from 'lucide-react';
import { api } from '../api';

// ── HR → Time: team timesheets, corrections, payroll export ──────────────────
// Single-screen review (the SwipeClock manager expectation): every employee's
// totals for the range, expandable to day → punch level with geofence status
// and a map pin per located punch. Corrections freeze the original time and
// stamp who adjusted; voids hide from totals but stay in the record.

const KIND_LABEL = { in: 'In', out: 'Out', break_start: 'Break start', break_end: 'Break end' };
const localTime = (iso) => iso ? new Date(iso + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMin = (m) => `${Math.floor((m || 0) / 60)}h ${String((m || 0) % 60).padStart(2, '0')}m`;
const isoDate = (d) => d.toISOString().slice(0, 10);
const utcToInput = (iso) => {
  const d = new Date(iso + 'Z');
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function weekRange(offset = 0) {
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return [isoDate(mon), isoDate(sun)];
}

const FL = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.05em', textTransform: 'uppercase' };

export default function TimeAdmin({ employees = [], toastOk, toastErr }) {
  const [[start, end], setRange] = useState(() => weekRange(0));
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState({});          // email -> bool
  const [edit, setEdit] = useState(null);        // punch being edited
  const [addFor, setAddFor] = useState(null);    // email getting a manual punch
  const [addP, setAddP] = useState({ kind: 'out', at: '', note: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setRows(null);
    api.timeTeam(start, end).then(r => setRows(r.rows)).catch(e => { setRows([]); toastErr(e?.message || 'Could not load timesheets.'); });
  }, [start, end, toastErr]);
  useEffect(() => { load(); }, [load]);

  const [timeoff, setTimeoff] = useState([]);
  const loadTimeoff = useCallback(() => {
    api.timeOffList().then(setTimeoff).catch(() => setTimeoff([]));
  }, []);
  useEffect(() => { loadTimeoff(); }, [loadTimeoff]);

  async function decideTimeoff(id, status) {
    const note = status === 'rejected' ? (window.prompt('Reason (sent to the employee):') || '') : '';
    try {
      await api.timeOffDecide(id, { status, note });
      toastOk(`Request ${status}.`);
      loadTimeoff();
    } catch (e) { toastErr(e?.message || 'Could not update the request.'); }
  }

  async function exportCsv(mode) {
    try {
      const blob = await api.timeExportCsv(start, end, mode);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `timeclock-${mode}-${start}-to-${end}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toastErr(e?.message || 'Export failed.'); }
  }

  async function saveEdit() {
    if (busy) return; setBusy(true);
    try {
      await api.timeAdjustPunch(edit.id, {
        at: edit.atInput ? new Date(edit.atInput).toISOString().slice(0, 19) : undefined,
        note: edit.note, void: edit.voided, adjust_note: edit.adjustNote || '',
      });
      toastOk('Punch updated — the original time stays on record.');
      setEdit(null); load();
    } catch (e) { toastErr(e?.message || 'Could not update the punch.'); }
    setBusy(false);
  }

  async function saveAdd() {
    if (busy) return;
    if (!addP.at) { toastErr('Pick the punch time.'); return; }
    setBusy(true);
    try {
      await api.timeAddPunch({ employee_email: addFor, kind: addP.kind,
        at: new Date(addP.at).toISOString().slice(0, 19),
        tz_offset_min: new Date().getTimezoneOffset(), note: addP.note });
      toastOk('Punch added.');
      setAddFor(null); setAddP({ kind: 'out', at: '', note: '' }); load();
    } catch (e) { toastErr(e?.message || 'Could not add the punch.'); }
    setBusy(false);
  }

  const totalMin = (rows || []).reduce((a, r) => a + r.workedMin, 0);

  return (
    <div style={{ fontFamily: 'Inter,sans-serif' }}>
      {/* Range + export bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {[['This week', 0], ['Last week', -1]].map(([l, off]) => {
          const r = weekRange(off);
          const active = r[0] === start && r[1] === end;
          return (
            <button key={l} className="secondary-btn" onClick={() => setRange(r)}
              style={{ fontSize: 12, ...(active ? { background: 'var(--pine)', color: '#fff', borderColor: 'var(--pine)' } : {}) }}>{l}</button>
          );
        })}
        <input className="form-input" type="date" value={start} onChange={e => setRange([e.target.value, end])} style={{ fontSize: 12, width: 150 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
        <input className="form-input" type="date" value={end} onChange={e => setRange([start, e.target.value])} style={{ fontSize: 12, width: 150 }} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)' }}>Team total: <span style={{ color: 'var(--pine)' }}>{fmtMin(totalMin)}</span></span>
        <button className="secondary-btn" onClick={() => exportCsv('summary')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Download size={12} /> Summary CSV
        </button>
        <button className="secondary-btn" onClick={() => exportCsv('punches')} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Download size={12} /> All punches CSV
        </button>
      </div>

      {/* Time-off requests — pending first, decisions notify the employee */}
      {timeoff.filter(r => r.status === 'pending').length > 0 && (
        <div style={{ background: 'var(--card)', border: '1.5px solid #f6c78e', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
          <div style={{ padding: '9px 14px', fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: '#b45309', borderBottom: '1px solid var(--line)' }}>
            Time-off requests pending approval
          </div>
          {timeoff.filter(r => r.status === 'pending').map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, width: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.email}</span>
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'capitalize' }}>{r.type}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.startDate} → {r.endDate}</span>
              {r.note && <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{r.note}”</span>}
              <div style={{ flex: 1 }} />
              <button className="secondary-btn" onClick={() => decideTimeoff(r.id, 'rejected')}
                style={{ fontSize: 11.5, color: '#b91c1c' }}>Reject</button>
              <button className="primary-btn" onClick={() => decideTimeoff(r.id, 'approved')}
                style={{ fontSize: 11.5 }}>Approve</button>
            </div>
          ))}
        </div>
      )}

      {rows === null && <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>}
      {rows !== null && rows.length === 0 && (
        <div style={{ padding: '26px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', border: '1.5px dashed var(--line)', borderRadius: 12 }}>
          No punches in this range. Employees punch in from the Time Clock page in the sidebar.
        </div>
      )}

      {(rows || []).map(r => (
        <div key={r.email} style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8, overflow: 'hidden' }}>
          <button onClick={() => setOpen(o => ({ ...o, [r.email]: !o[r.email] }))}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '11px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'Inter,sans-serif' }}>
            {open[r.email] ? <ChevronDown size={14} style={{ color: 'var(--muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--muted)' }} />}
            <span style={{ fontSize: 13, fontWeight: 800, flex: '0 0 220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</span>
            {r.flagCount > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, color: '#b45309' }}>
                <AlertTriangle size={11} /> {r.flagCount}
              </span>
            )}
            {r.breakMin > 0 && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.breakMin}m break</span>}
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--pine)' }}>{fmtMin(r.workedMin)}</span>
          </button>

          {open[r.email] && (
            <div style={{ borderTop: '1px solid var(--line)', padding: '10px 14px 12px 38px' }}>
              {Object.keys(r.days).sort().map(date => {
                const d = r.days[date];
                return (
                  <div key={date} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 800 }}>{new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{fmtMin(d.workedMin)}{d.breakMin ? ` · ${d.breakMin}m break` : ''}</span>
                      {d.flags.map(f => <span key={f} style={{ fontSize: 10, fontWeight: 800, color: '#b45309', textTransform: 'uppercase' }}>{f.replace(/_/g, ' ')}</span>)}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                      {d.punches.map(p => (
                        <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '4px 10px', borderRadius: 10,
                          background: p.voided ? 'transparent' : p.geoStatus === 'out_of_fence' ? 'rgba(180,83,9,0.1)' : 'var(--mist)',
                          border: '1px solid var(--line)', color: p.voided ? 'var(--line)' : 'var(--ink)',
                          textDecoration: p.voided ? 'line-through' : 'none' }}>
                          <b>{KIND_LABEL[p.kind]}</b> {localTime(p.at)}
                          {p.originalAt && <span title={`Originally ${localTime(p.originalAt)} — adjusted by ${p.adjustedBy}`} style={{ color: '#b45309', fontWeight: 700 }}>✎</span>}
                          {p.lat && (
                            <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noopener noreferrer"
                              title={`${p.geoStatus === 'in_fence' ? `At ${p.workSiteName}` : `${p.distanceM}m from ${p.workSiteName || 'nearest site'}`} (±${p.accuracyM}m)`}
                              style={{ display: 'inline-flex', color: p.geoStatus === 'out_of_fence' ? '#b45309' : 'hsl(var(--color-green))' }}>
                              <MapPin size={11} />
                            </a>
                          )}
                          {p.source !== 'web' && <span title={p.source === 'self_manual' ? `Self-corrected: ${p.note}` : `Added by ${p.createdBy}`} style={{ fontSize: 10, fontWeight: 800, color: '#b45309' }}>M</span>}
                          <button onClick={() => setEdit({ ...p, atInput: utcToInput(p.at), adjustNote: '' })} title="Adjust / void"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 1 }}>
                            <Pencil size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
              <button className="secondary-btn" onClick={() => { setAddFor(r.email); setAddP({ kind: 'out', at: '', note: '' }); }}
                style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Plus size={11} /> Add punch
              </button>
            </div>
          )}
        </div>
      ))}

      {/* Edit punch modal */}
      {edit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && setEdit(null)}>
          <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 430, boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Clock size={15} style={{ color: 'var(--pine)' }} />
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Adjust punch — {KIND_LABEL[edit.kind]}</h3>
              <button onClick={() => setEdit(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'grid', gap: 10 }}>
              {edit.originalAt && (
                <p style={{ margin: 0, fontSize: 11.5, color: '#b45309' }}>Original time on record: {localTime(edit.originalAt)} (adjusted by {edit.adjustedBy})</p>
              )}
              <div><label style={FL}>Time</label>
                <input className="form-input" type="datetime-local" value={edit.atInput}
                  onChange={e => setEdit(x => ({ ...x, atInput: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={FL}>Punch note</label>
                <input className="form-input" value={edit.note || ''} onChange={e => setEdit(x => ({ ...x, note: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={FL}>Reason for adjustment</label>
                <input className="form-input" placeholder="Shows in the audit trail" value={edit.adjustNote}
                  onChange={e => setEdit(x => ({ ...x, adjustNote: e.target.value }))} style={{ width: '100%' }} /></div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!edit.voided} onChange={e => setEdit(x => ({ ...x, voided: e.target.checked }))}
                  style={{ width: 15, height: 15, accentColor: '#b91c1c' }} />
                <Ban size={13} style={{ color: '#b91c1c' }} /> Void this punch (kept on record, excluded from totals)
              </label>
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveEdit} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={13} />} Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add punch modal */}
      {addFor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => e.target === e.currentTarget && setAddFor(null)}>
          <div style={{ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth: 430, boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Plus size={15} style={{ color: 'var(--pine)' }} />
              <h3 style={{ margin: 0, fontSize: 14.5, fontWeight: 700, flex: 1 }}>Add punch — {addFor}</h3>
              <button onClick={() => setAddFor(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={16} /></button>
            </div>
            <div style={{ padding: '16px 20px', display: 'grid', gap: 10 }}>
              <div><label style={FL}>Kind</label>
                <select className="form-input" value={addP.kind} onChange={e => setAddP(p => ({ ...p, kind: e.target.value }))} style={{ width: '100%' }}>
                  {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></div>
              <div><label style={FL}>Time</label>
                <input className="form-input" type="datetime-local" value={addP.at} onChange={e => setAddP(p => ({ ...p, at: e.target.value }))} style={{ width: '100%' }} /></div>
              <div><label style={FL}>Note</label>
                <input className="form-input" placeholder="e.g. forgot to punch out" value={addP.note}
                  onChange={e => setAddP(p => ({ ...p, note: e.target.value }))} style={{ width: '100%' }} /></div>
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="secondary-btn" onClick={() => setAddFor(null)}>Cancel</button>
              <button className="primary-btn" onClick={saveAdd} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={13} />} Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
