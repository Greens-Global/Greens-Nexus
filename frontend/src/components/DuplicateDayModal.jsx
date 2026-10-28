// Duplicate Day (Neil, Oct 27 2026): HR fixing a time sheet that had to be
// kept by hand enters one day - or picks one already on the card - and lays
// it onto other days of the period: picked ones, All Working Days (the
// person's shift days, else Monday to Friday, never a holiday or approved
// time off) or All Days. HR only - the server refuses anyone else
// (POST /timeclock/duplicate-day). The preview IS the server's dry run, a
// day that already has punches is skipped unless Replace Existing is
// ticked, a reason is required, and one Undo takes the whole batch back
// (and brings back what it replaced).
import { useState, useEffect, useMemo } from 'react';
import { X, Check, Undo2, Copy, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { localKey, nextDay, weekday, monthDay, hm, t12, TYPES, TONE, dayNote } from '../lib/addTime';
import { dupPlanText, dupTemplateText, periodDays } from '../lib/duplicateDay';
import { inputToUtcTz, tzOffsetForInput, useDisplayTz, currentTzOption } from '../lib/displayTz';
import { Spinner } from './AsyncState';
import ChoicePills from './ChoicePills';
import { TimeField } from '../tasks/components';

const field = { border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', fontSize: 13, fontFamily: 'inherit', background: 'var(--card)', color: 'var(--ink)' };
const lab = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', display: 'block', marginBottom: 4 };
const SOURCES = ['Copy A Day', 'Fill In A Day'];
const MODES = { 'Pick Days': 'days', 'All Working Days': 'working', 'All Days': 'all' };

export default function DuplicateDayModal({ email, name = '', start, end, initialSource = '', onClose, onDone, toastOk, toastErr }) {
  useDisplayTz();   // times are typed in the timecard's display zone
  const [today] = useState(() => localKey(new Date()));
  const [loaded, setLoaded] = useState(null);   // { days, name } | null while reading
  const [err, setErr] = useState('');
  const days = loaded?.days || null;
  const who = loaded?.name || name;
  const withTime = useMemo(() => (days || []).filter((d) => d.state === 'has_time'), [days]);
  const [source, setSource] = useState(SOURCES[0]);
  const [srcDate, setSrcDate] = useState(initialSource);
  const [inT, setInT] = useState('08:30');
  const [outT, setOutT] = useState('17:30');
  const [breaks, setBreaks] = useState([{ start: '12:00', end: '12:30' }]);
  const [type, setType] = useState('Work');
  const [modeLabel, setModeLabel] = useState('Pick Days');
  const [picked, setPicked] = useState(() => new Set());
  const [replace, setReplace] = useState(false);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const touch = () => setPreview(null);
  const mode = MODES[modeLabel];
  const copying = source === SOURCES[0];

  useEffect(() => {
    if (busy) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  useEffect(() => {
    let alive = true;
    api.timeAddTimeDays(email, start, end).then((r) => {
      if (!alive) return;
      const list = Array.isArray(r?.days) ? r.days : [];
      setLoaded({ days: list, name: r?.name || '' });
      // No day to copy from: start on Fill In A Day.
      setSrcDate((s) => (s && list.some((d) => d.date === s && d.state === 'has_time') ? s : (list.find((d) => d.state === 'has_time')?.date || '')));
      if (!list.some((d) => d.state === 'has_time')) setSource(SOURCES[1]);
    }).catch((e) => { if (alive) { setLoaded({ days: [], name: '' }); setErr(e?.message || "Could not read this person's days."); } });
    return () => { alive = false; };
  }, [email, start, end]);

  const sourceDay = copying ? srcDate : '';
  const chosen = useMemo(() => [...picked].filter((ds) => ds !== sourceDay).sort(), [picked, sourceDay]);
  const pickable = (d) => !d.locked && d.state !== 'live' && d.date <= today && d.date !== sourceDay;
  const toggle = (d) => {
    if (!pickable(d)) return;
    setPicked((p) => { const n = new Set(p); if (n.has(d.date)) n.delete(d.date); else n.add(d.date); return n; });
    touch();
  };

  // A time typed on the reference day, as UTC: a time at or before the
  // clock-in is the next morning (an overnight shift).
  const ref = start;
  const utcAt = (hhmm) => inputToUtcTz(`${hhmm < inT ? nextDay(ref) : ref}T${hhmm}`);
  const payload = (dry) => {
    const all = periodDays(start, end);
    const tzOffsets = Object.fromEntries(all.map((ds) => [ds, tzOffsetForInput(`${ds}T${copying ? '12:00' : inT}`)]));
    return {
      employee_email: email, reason: reason.trim(), dry_run: dry, replace,
      mode, targets: mode === 'days' ? chosen : [], start, end,
      tz_offset_min: tzOffsetForInput(`${ref}T${inT}`), tz_offsets: tzOffsets,
      ...(copying ? { source_date: srcDate } : {
        fill_date: ref, in_at: inputToUtcTz(`${ref}T${inT}`), out_at: utcAt(outT),
        breaks: breaks.filter((b) => b.start && b.end).map((b) => ({ start_at: utcAt(b.start), end_at: utcAt(b.end) })),
        category: type === 'Work' ? '' : type,
      }),
    };
  };
  const run = async (dry) => {
    setErr('');
    if (copying && !srcDate) { setErr('Pick the day to copy.'); return; }
    if (mode === 'days' && !chosen.length) { setErr('Pick at least one day to copy onto.'); return; }
    if (reason.trim().length < 3) { setErr('Say why this day is being copied - it goes on every punch.'); return; }
    setBusy(true);
    try {
      const r = await api.timeDuplicateDay(payload(dry));
      if (dry) setPreview(r);
      else {
        setDone(r);
        if (r.added > 0) toastOk?.(`Copied onto ${r.added} day${r.added === 1 ? '' : 's'} of ${who || email}'s time sheet.`);
        onDone?.(r);
      }
    } catch (e) { const m = e?.message || 'Could not copy the day.'; setErr(m); toastErr?.(m); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true); setErr('');
    try { await api.timeDuplicateDayUndo(done.batchId); toastOk?.('The copied day was taken back.'); onDone?.(); onClose?.(); }
    catch (e) { const m = e?.message || 'Could not undo it.'; setErr(m); toastErr?.(m); }
    finally { setBusy(false); }
  };

  const zone = currentTzOption?.()?.label || '';
  const rows = preview?.days || [];
  const willDo = rows.filter((r) => r.action !== 'skip');
  const resultRows = (list) => list.map((r) => (
    <div key={r.date} data-dup-row={r.action} style={{ display: 'flex', gap: 10, padding: '7px 12px', borderTop: '1px solid var(--line)', fontSize: 13, alignItems: 'baseline' }}>
      <span style={{ width: 120, flexShrink: 0, fontWeight: 700 }}>{weekday(r.date)} {formatDate(r.date)}</span>
      <span style={{ flex: 1, color: r.action === 'skip' ? 'hsl(var(--color-red))' : r.action === 'replace' ? '#b45309' : 'var(--ink)' }}>{dupPlanText(r)}</span>
    </div>
  ));

  return (
    <div onClick={busy ? undefined : onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--wk-font)' }}>
      <div role="dialog" aria-modal="true" aria-label={`Duplicate a day for ${who || email}`} onClick={(e) => e.stopPropagation()} className="nx-popup"
        style={{ background: 'var(--card)', color: 'var(--ink)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.28)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <Copy size={18} style={{ color: 'var(--wk-brand, #15803d)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Duplicate Day for {who || email}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>HR only. Copy one day - its clock-ins, breaks and type - onto other days of {formatDate(start)} - {formatDate(end)}.{zone ? ` Times in ${zone}.` : ''}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy} style={{ padding: 6 }}><X size={16} /></button>
        </div>

        {done ? (
          <div style={{ padding: '22px 18px', overflow: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,162,91,0.12)', color: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Check size={18} /></span>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                {done.added > 0 ? `Copied onto ${done.added} day${done.added === 1 ? '' : 's'} - ${hm(done.totalMin)} in all.` : 'Nothing was copied.'}
              </div>
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>{resultRows(done.days || [])}</div>
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
            <div style={{ padding: '14px 18px', overflow: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {days === null ? <div style={{ padding: 16, display: 'flex', justifyContent: 'center' }}><Spinner /></div> : (
                <>
                  {/* The day to copy */}
                  <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div><span style={lab}>The Day</span>
                      <ChoicePills label="The day" value={source} options={SOURCES} onChange={(s) => { setSource(s); touch(); }} /></div>
                    {copying ? (
                      withTime.length ? (
                        <label style={{ display: 'block' }}><span style={lab}>Copy From</span>
                          <select data-source-day value={srcDate} onChange={(e) => { setSrcDate(e.target.value); touch(); }} style={{ ...field, minWidth: 220 }}>
                            {withTime.map((d) => <option key={d.date} value={d.date}>{weekday(d.date)} {formatDate(d.date)} - {hm(d.workedMin)}</option>)}
                          </select>
                        </label>
                      ) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No day of this period has time to copy yet - fill one in instead.</div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                          <label style={{ display: 'block' }}><span style={lab}>Clock In</span><TimeField ariaLabel="Clock In" value={inT} onChange={(v) => { setInT(v); touch(); }} style={field} step={5} /></label>
                          <label style={{ display: 'block' }}><span style={lab}>Clock Out</span><TimeField ariaLabel="Clock Out" value={outT} onChange={(v) => { setOutT(v); touch(); }} style={field} step={5} /></label>
                          <div><span style={lab}>Type</span>
                            <ChoicePills label="Type" value={type} options={TYPES} onChange={(t) => { setType(t); touch(); }} /></div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span style={{ ...lab, marginBottom: 0 }}>Unpaid Breaks</span>
                          {breaks.map((b, i) => (
                            <div key={i} data-break-row style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                              <TimeField ariaLabel={`Break ${i + 1} start`} value={b.start} onChange={(v) => { setBreaks((l) => l.map((x, j) => (j === i ? { ...x, start: v } : x))); touch(); }} style={{ ...field, padding: '4px 6px' }} step={5} />
                              <span style={{ color: 'var(--muted)' }}>to</span>
                              <TimeField ariaLabel={`Break ${i + 1} end`} value={b.end} onChange={(v) => { setBreaks((l) => l.map((x, j) => (j === i ? { ...x, end: v } : x))); touch(); }} style={{ ...field, padding: '4px 6px' }} step={5} />
                              <button type="button" className="icon-btn" aria-label={`Remove break ${i + 1}`} onClick={() => { setBreaks((l) => l.filter((_x, j) => j !== i)); touch(); }} style={{ padding: 4 }}><Trash2 size={13} /></button>
                            </div>
                          ))}
                          <button type="button" className="secondary-btn" onClick={() => { setBreaks((l) => [...l, { start: '15:00', end: '15:15' }]); touch(); }}
                            style={{ alignSelf: 'flex-start', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Break</button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Where it goes */}
                  <div>
                    <span style={lab}>Copy Onto{mode === 'days' && chosen.length ? ` - ${chosen.length} picked` : ''}</span>
                    <ChoicePills label="Copy onto" value={modeLabel} options={Object.keys(MODES)} onChange={(m) => { setModeLabel(m); touch(); }} />
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                      {mode === 'working' ? "The person's shift days in this period (Monday to Friday without a shift), never a holiday or approved time off, never a day that has not happened yet."
                        : mode === 'all' ? 'Every day of this period up to today, weekends and holidays included.'
                          : 'Tick the days. A day that already has time says so.'}
                    </div>
                    {mode === 'days' && (
                      <div data-day-grid style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 6, marginTop: 8 }}>
                        {days.map((d) => {
                          const on = picked.has(d.date) && d.date !== sourceDay;
                          const ok = pickable(d);
                          const note = d.date === sourceDay ? { text: 'Copying', tone: 'green' } : d.date > today ? { text: 'Not Yet', tone: 'muted' } : dayNote(d);
                          const weekend = [0, 6].includes(new Date(`${d.date}T12:00:00`).getDay());
                          return (
                            <label key={d.date} data-day={d.date} data-state={d.state}
                              title={d.locked || (d.holiday ? `Holiday - ${d.holiday}` : d.timeOff ? `Approved time off` : undefined)}
                              style={{ display: 'block', borderRadius: 10, padding: '7px 9px', cursor: ok ? 'pointer' : 'not-allowed', position: 'relative',
                                border: `1.5px solid ${on ? 'var(--wk-brand, #15803d)' : 'var(--line)'}`, background: on ? 'var(--wk-brand-tint, rgba(21,128,61,0.08))' : weekend ? 'var(--wk-hover, var(--bg))' : 'var(--card)',
                                opacity: ok ? 1 : 0.55 }}>
                              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, gap: 4 }}>
                                <input type="checkbox" checked={on} disabled={!ok} onChange={() => toggle(d)} aria-label={`${weekday(d.date)} ${formatDate(d.date)}`} style={{ margin: 0 }} />
                                <span style={{ color: 'var(--muted)' }}>{weekday(d.date)}</span>
                                <b>{monthDay(d.date)}</b>
                              </span>
                              <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: TONE[note.tone], marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{note.text}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, color: 'var(--ink)', cursor: 'pointer', marginTop: 10 }}>
                      <input type="checkbox" checked={replace} onChange={(e) => { setReplace(e.target.checked); touch(); }} style={{ marginTop: 2 }} />
                      <span><b>Replace Existing</b> - <span style={{ color: 'var(--muted)' }}>a day that already has punches gets this day instead. Without it those days are skipped. The replaced punches are kept on record and come back with Undo.</span></span>
                    </label>
                  </div>
                </>
              )}

              {/* Reason */}
              <label className="nx-fill">
                <span style={lab}>Reason</span>
                <textarea value={reason} onChange={(e) => { setReason(e.target.value); touch(); }} rows={2} maxLength={300} placeholder="Why this day is being copied - it goes on every punch, e.g. paper time sheet for October"
                  style={{ ...field, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
              </label>

              {/* Preview */}
              {preview && (
                <div data-preview style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ padding: '8px 12px', background: 'var(--wk-hover, var(--bg))', fontSize: 12.5, fontWeight: 700 }}>
                    {dupTemplateText(preview.template, t12)}
                    <div style={{ fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>
                      {willDo.length ? `${hm(preview.totalMin)} over ${willDo.length} day${willDo.length === 1 ? '' : 's'}${preview.replaced ? ` - ${preview.replaced} replaced` : ''}` : 'Nothing - every day was skipped'}
                    </div>
                  </div>
                  {resultRows(rows)}
                </div>
              )}
              {err && <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{err}</div>}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
              <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
              {!preview ? (
                <button type="button" className="primary-btn" onClick={() => run(true)} disabled={busy || days === null}>
                  {busy ? 'Checking...' : 'Preview'}
                </button>
              ) : (
                <button type="button" className="primary-btn" onClick={() => run(false)} disabled={busy || !willDo.length} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Check size={14} /> {busy ? 'Copying...' : `Copy Onto ${willDo.length} Day${willDo.length === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
