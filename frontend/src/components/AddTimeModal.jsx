// Add Time (Neil, Oct 14 2026): a manager adds a whole shift - or a run of
// them - for someone who did not clock in right. One screen: pick the days
// (each chip says what the day already holds), set the hours once or per
// day, say why, preview exactly what will be written, add. The server
// (POST /timeclock/add-time) judges every day with the same guards a single
// added punch gets and skips the ones it cannot take, with the reason; the
// preview IS that judgment (a dry run), so nothing lands that was not shown.
// Afterwards one Undo takes the whole batch back.
import { useState, useEffect, useMemo } from 'react';
import { X, Check, AlertTriangle, Undo2, CalendarPlus, Clock } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { DAY_MS, localKey, nextDay, weekday, monthDay, hm, t12, cap, BREAKS, TYPES, TONE, dayNote, planText } from '../lib/addTime';
import { inputToUtcTz, tzOffsetForInput, formatTimeTz, useDisplayTz, currentTzOption } from '../lib/displayTz';
import { Spinner } from './AsyncState';

const field = { border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', fontSize: 13, fontFamily: 'inherit', background: 'var(--card)', color: 'var(--ink)' };
const lab = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', display: 'block', marginBottom: 4 };

export default function AddTimeModal({ email, name = '', start = '', end = '', initialDates = [], onClose, onDone, toastOk, toastErr }) {
  useDisplayTz();   // times are typed in the timecard's display zone; follow a change of it
  const [today] = useState(() => localKey(new Date()));
  const [range, setRange] = useState(() => ({ start: start || localKey(new Date(Date.now() - 13 * DAY_MS)), end: end || today }));
  // The days read for ONE range, keyed by it: a range change reads again and
  // the grid shows its spinner until the new answer is in.
  const rangeKey = `${email}|${range.start}|${range.end}`;
  const [loaded, setLoaded] = useState(null);   // { key, days, name, err }
  const days = loaded?.key === rangeKey ? loaded.days : null;
  const who = loaded?.name || name;
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState(() => new Set(initialDates));
  const [inT, setInT] = useState('08:30');
  const [outT, setOutT] = useState('17:30');
  const [brk, setBrk] = useState(0);
  const [type, setType] = useState('Work');
  const [perDay, setPerDay] = useState(false);
  const [own, setOwn] = useState({});            // date -> { in, out } when hours differ per day
  const [force, setForce] = useState(new Set()); // days that already have time, to add a second shift to
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let alive = true;
    api.timeAddTimeDays(email, range.start, range.end).then((r) => {
      if (!alive) return;
      const list = Array.isArray(r?.days) ? r.days : [];
      setLoaded({ key: rangeKey, days: list, name: r?.name || '' });
      // First pick, when none was handed in: the days that need a punch.
      // Hours: the first chosen day's shift, else its usual hours.
      setPicked((p) => {
        const have = new Set([...p].filter((ds) => list.some((d) => d.date === ds)));
        if (have.size || initialDates.length) return have;
        return new Set(list.filter((d) => (d.state === 'needs_out' || d.state === 'needs_in') && !d.locked).map((d) => d.date));
      });
      const src = list.find((d) => d.shift || d.usual);
      const hrs = src?.shift || src?.usual;
      if (hrs) { setInT(hrs.start); setOutT(hrs.end); setBrk(BREAKS.includes(hrs.breakMin) ? hrs.breakMin : 0); }
    }).catch((e) => { if (alive) { setLoaded({ key: rangeKey, days: [], name: '' }); setErr(e?.message || "Could not read this person's days."); } });
    return () => { alive = false; };
    // initialDates only matters on the first read; its identity changing must not re-read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, range.start, range.end, rangeKey]);

  const byDate = useMemo(() => new Map((days || []).map((d) => [d.date, d])), [days]);
  const chosen = useMemo(() => [...picked].filter((ds) => byDate.has(ds)).sort(), [picked, byDate]);
  const touch = () => setPreview(null);
  const toggle = (d) => {
    if (d.locked || d.state === 'live') return;
    setPicked((p) => { const n = new Set(p); if (n.has(d.date)) n.delete(d.date); else n.add(d.date); return n; });
    touch();
  };
  const hoursFor = (ds) => (perDay && own[ds]) || { in: inT, out: outT };
  const setOwnHours = (ds, k, v) => { setOwn((o) => ({ ...o, [ds]: { ...hoursFor(ds), [k]: v } })); touch(); };
  const firstHours = chosen.map((ds) => byDate.get(ds)).find((d) => d?.shift || d?.usual);
  const shiftHours = firstHours?.shift || firstHours?.usual;

  const payload = (dry) => ({
    employee_email: email, reason: reason.trim(), dry_run: dry, category: type === 'Work' ? '' : type,
    tz_offset_min: tzOffsetForInput(`${chosen[0] || today}T${inT}`),
    days: chosen.map((ds) => {
      const h = hoursFor(ds);
      // A clock-out at or before the clock-in means the shift runs past midnight.
      const outDay = h.out <= h.in ? nextDay(ds) : ds;
      return { date: ds, in_at: inputToUtcTz(`${ds}T${h.in}`), out_at: inputToUtcTz(`${outDay}T${h.out}`),
        break_min: brk, force: force.has(ds), tz_offset_min: tzOffsetForInput(`${ds}T${h.in}`) };
    }),
  });
  const run = async (dry) => {
    setErr('');
    if (!chosen.length) { setErr('Pick at least one day.'); return; }
    if (reason.trim().length < 3) { setErr('Say why this time is being added - it goes on every punch.'); return; }
    setBusy(true);
    try {
      const r = await api.timeAddTime(payload(dry));
      if (dry) setPreview(r);
      else {
        setDone(r);
        if (r.added > 0) toastOk?.(`Added ${hm(r.totalMin)} over ${r.added} day${r.added === 1 ? '' : 's'} to ${who || email}'s timecard.`);
        onDone?.(r);
      }
    } catch (e) { const m = e?.message || 'Could not add the time.'; setErr(m); toastErr?.(m); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true); setErr('');
    try { await api.timeAddTimeUndo(done.batchId); toastOk?.('The added time was taken back.'); onDone?.(); onClose?.(); }
    catch (e) { const m = e?.message || 'Could not undo it.'; setErr(m); toastErr?.(m); }
    finally { setBusy(false); }
  };

  const zone = currentTzOption?.()?.label || '';
  const previewRows = preview?.days || [];
  const willAdd = previewRows.filter((r) => r.action !== 'skip');

  return (
    <div onClick={busy ? undefined : onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--wk-font)' }}>
      <div role="dialog" aria-modal="true" aria-label={`Add time for ${who || email}`} onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--card)', color: 'var(--ink)', borderRadius: 16, width: 'min(760px, 100%)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.28)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <CalendarPlus size={18} style={{ color: 'var(--wk-brand, #15803d)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Add Time for {who || email}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Pick the days, set the hours, say why. Each day is checked the way a single added punch is.{zone ? ` Times in ${zone}.` : ''}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy} style={{ padding: 6 }}><X size={16} /></button>
        </div>

        {done ? (
          <div style={{ padding: '22px 18px', overflow: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,162,91,0.12)', color: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Check size={18} /></span>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                {done.added > 0 ? `Added ${hm(done.totalMin)} over ${done.added} day${done.added === 1 ? '' : 's'}.` : 'Nothing was added.'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              {(done.days || []).map((r) => (
                <div key={r.date} data-done-row={r.action} style={{ display: 'flex', gap: 10, padding: '5px 0', borderTop: '1px solid var(--line)' }}>
                  <span style={{ width: 120, flexShrink: 0, fontWeight: 700 }}>{weekday(r.date)} {formatDate(r.date)}</span>
                  <span style={{ color: r.action === 'skip' ? 'hsl(var(--color-red))' : 'var(--ink)' }}>{planText(r)}</span>
                </div>
              ))}
            </div>
            {err && <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5, marginTop: 10 }}>{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              {done.batchId && (
                <button type="button" className="secondary-btn" onClick={undo} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Undo2 size={14} /> Undo
                </button>
              )}
              <button type="button" className="primary-btn" onClick={onClose} disabled={busy}>Close</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding: '14px 18px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Days */}
              <div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span style={{ ...lab, marginBottom: 0, flex: 1 }}>Days{chosen.length ? ` - ${chosen.length} picked` : ''}</span>
                  <label style={{ fontSize: 12, color: 'var(--muted)' }}>From <input type="date" value={range.start} max={range.end} onChange={(e) => { setRange((r) => ({ ...r, start: e.target.value || r.start })); touch(); }} style={{ ...field, padding: '4px 6px' }} /></label>
                  <label style={{ fontSize: 12, color: 'var(--muted)' }}>To <input type="date" value={range.end} min={range.start} max={today} onChange={(e) => { setRange((r) => ({ ...r, end: e.target.value || r.end })); touch(); }} style={{ ...field, padding: '4px 6px' }} /></label>
                </div>
                {days === null ? <div style={{ padding: 16, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
                  : days.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No days in this range.</div> : (
                  <div data-day-grid style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 6 }}>
                    {days.map((d) => {
                      const on = picked.has(d.date);
                      const off = !!d.locked || d.state === 'live';
                      const note = dayNote(d);
                      const weekend = [0, 6].includes(new Date(`${d.date}T12:00:00`).getDay());
                      return (
                        <button key={d.date} type="button" data-day={d.date} data-state={d.state} aria-pressed={on} disabled={off}
                          onClick={() => toggle(d)} title={d.locked || (d.holiday ? `Holiday - ${d.holiday}` : d.timeOff ? `Approved time off (${cap(d.timeOff)})` : d.state === 'live' ? 'On the clock right now' : undefined)}
                          style={{ textAlign: 'left', borderRadius: 10, padding: '7px 9px', cursor: off ? 'not-allowed' : 'pointer', fontFamily: 'inherit', position: 'relative',
                            border: `1.5px solid ${on ? 'var(--wk-brand, #15803d)' : 'var(--line)'}`, background: on ? 'var(--wk-brand-tint, rgba(21,128,61,0.08))' : weekend ? 'var(--wk-hover, var(--bg))' : 'var(--card)',
                            opacity: off ? 0.55 : 1, color: 'var(--ink)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, paddingRight: on ? 14 : 0 }}>
                            <span style={{ color: 'var(--muted)' }}>{weekday(d.date)}</span>
                            <b>{monthDay(d.date)}</b>
                          </div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: TONE[note.tone], marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{note.text}</div>
                          {on && <Check size={11} style={{ position: 'absolute', top: 5, right: 5, color: 'var(--wk-brand, #15803d)', background: 'var(--card)', borderRadius: '50%' }} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Hours */}
              <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label style={{ display: 'block' }}><span style={lab}>Clock In</span><input type="time" value={inT} disabled={perDay} onChange={(e) => { setInT(e.target.value); touch(); }} style={field} /></label>
                  <label style={{ display: 'block' }}><span style={lab}>Clock Out</span><input type="time" value={outT} disabled={perDay} onChange={(e) => { setOutT(e.target.value); touch(); }} style={field} /></label>
                  <label style={{ display: 'block' }}><span style={lab}>Unpaid Break</span>
                    <select value={brk} onChange={(e) => { setBrk(Number(e.target.value)); touch(); }} style={field}>{BREAKS.map((b) => <option key={b} value={b}>{b ? `${b} min` : 'None'}</option>)}</select></label>
                  <label style={{ display: 'block' }}><span style={lab}>Type</span>
                    <select value={type} onChange={(e) => { setType(e.target.value); touch(); }} style={field}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
                  {shiftHours && !perDay && (
                    <button type="button" className="secondary-btn" onClick={() => { setInT(shiftHours.start); setOutT(shiftHours.end); setBrk(BREAKS.includes(shiftHours.breakMin) ? shiftHours.breakMin : 0); touch(); }}
                      title={`${t12(shiftHours.start)} - ${t12(shiftHours.end)}`} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Clock size={12} /> Use {firstHours.shift ? 'Shift' : 'Usual'} Hours
                    </button>
                  )}
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--muted)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={perDay} onChange={(e) => { setPerDay(e.target.checked); touch(); }} /> Different hours per day
                </label>
                {perDay && chosen.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {chosen.map((ds) => {
                      const h = hoursFor(ds);
                      const d = byDate.get(ds);
                      return (
                        <div key={ds} data-own-row={ds} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
                          <span style={{ width: 120, fontWeight: 700 }}>{weekday(ds)} {formatDate(ds)}</span>
                          <input type="time" aria-label={`Clock in on ${formatDate(ds)}`} value={h.in} onChange={(e) => setOwnHours(ds, 'in', e.target.value)} style={{ ...field, padding: '4px 6px' }} />
                          <span style={{ color: 'var(--muted)' }}>to</span>
                          <input type="time" aria-label={`Clock out on ${formatDate(ds)}`} value={h.out} onChange={(e) => setOwnHours(ds, 'out', e.target.value)} style={{ ...field, padding: '4px 6px' }} />
                          {(d?.shift || d?.usual) && (
                            <button type="button" className="secondary-btn" style={{ fontSize: 11.5 }} onClick={() => { const s = d.shift || d.usual; setOwn((o) => ({ ...o, [ds]: { in: s.start, out: s.end } })); touch(); }}>
                              {d.shift ? 'Shift' : 'Usual'} {t12((d.shift || d.usual).start)} - {t12((d.shift || d.usual).end)}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {chosen.some((ds) => byDate.get(ds)?.state === 'has_time') && (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {chosen.filter((ds) => byDate.get(ds)?.state === 'has_time').map((ds) => (
                      <label key={ds} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                        <input type="checkbox" checked={force.has(ds)} onChange={(e) => { setForce((f) => { const n = new Set(f); if (e.target.checked) n.add(ds); else n.delete(ds); return n; }); touch(); }} />
                        {formatDate(ds)} already has {hm(byDate.get(ds).workedMin)} - add a second shift anyway
                      </label>
                    ))}
                  </div>
                )}
                {chosen.some((ds) => byDate.get(ds)?.state === 'needs_out' || byDate.get(ds)?.state === 'needs_in') && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <AlertTriangle size={13} style={{ color: '#b45309', flexShrink: 0, marginTop: 1 }} />
                    <span>A day with an open shift gets only its clock-out{chosen.map((ds) => byDate.get(ds)).filter((d) => d?.state === 'needs_out').map((d) => ` (${formatDate(d.date)} clocked in at ${formatTimeTz(d.openIn)})`).join('')}; a lone clock-out gets only its clock-in.</span>
                  </div>
                )}
              </div>

              {/* Reason */}
              <label style={{ display: 'block' }}>
                <span style={lab}>Reason</span>
                <textarea value={reason} onChange={(e) => { setReason(e.target.value); touch(); }} rows={2} maxLength={300} placeholder="Why this time is being added - it goes on every punch, e.g. forgot to clock in, no signal at the site"
                  style={{ ...field, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
              </label>

              {/* Preview */}
              {preview && (
                <div data-preview style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ padding: '8px 12px', background: 'var(--wk-hover, var(--bg))', fontSize: 12.5, fontWeight: 700 }}>
                    What will be written{willAdd.length ? ` - ${hm(preview.totalMin)} over ${willAdd.length} day${willAdd.length === 1 ? '' : 's'}` : ' - nothing, every day was skipped'}
                  </div>
                  {previewRows.map((r) => (
                    <div key={r.date} data-plan-row={r.action} style={{ display: 'flex', gap: 10, padding: '7px 12px', borderTop: '1px solid var(--line)', fontSize: 13, alignItems: 'baseline' }}>
                      <span style={{ width: 120, flexShrink: 0, fontWeight: 700 }}>{weekday(r.date)} {formatDate(r.date)}</span>
                      <span style={{ flex: 1, color: r.action === 'skip' ? 'hsl(var(--color-red))' : 'var(--ink)' }}>{planText(r)}</span>
                      {r.action !== 'skip' && <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatTimeTz(r.inAt)} - {formatTimeTz(r.outAt)}</span>}
                    </div>
                  ))}
                </div>
              )}
              {err && <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{err}</div>}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
              {!preview ? (
                <button type="button" className="primary-btn" onClick={() => run(true)} disabled={busy || !chosen.length}>
                  {busy ? 'Checking...' : chosen.length ? `Preview ${chosen.length} Day${chosen.length === 1 ? '' : 's'}` : 'Preview'}
                </button>
              ) : (
                <button type="button" className="primary-btn" onClick={() => run(false)} disabled={busy || !willAdd.length} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Check size={14} /> {busy ? 'Adding...' : `Add ${willAdd.length} Day${willAdd.length === 1 ? '' : 's'} - ${hm(preview.totalMin)}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
