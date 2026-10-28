// Add Time From Record (Neil, Oct 27 2026; was Duplicate Day): "an option
// for HR to rapidly add time to a time sheet that wasn't done through Nexus".
// HR sets one day - typed in, or copied from a day already on the card - and
// lays it over a range of up to 62 days (All Working Days: the person's
// shift days, else Monday to Friday, never a holiday or approved time off;
// All Days; or Pick Days). The review grid then has one row per day, each
// editable on its own - times, breaks, Work / Sick Day / Vacation / Personal
// / Off - and Check runs the server's dry run, so every refused row says why
// before anything is written. One reason and an optional source document
// (the paper sheet: a picture or PDF, or Ctrl+V) per batch, one Undo.
// HR only - the server refuses anyone else (POST /timeclock/duplicate-day).
import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Check, Undo2, ClipboardList, Plus, Trash2, Paperclip, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { weekday, hm, t12, TONE } from '../lib/addTime';
import {
  dupPlanText, ROW_TYPES, LEAVE_TYPES, rowMinutes, creditOf, CREDIT_WORD, rowFromShifts,
  shiftsText, dayGate, defaultPicks, recordRows,
} from '../lib/duplicateDay';
import { inputToUtcTz, tzOffsetForInput, utcToInputTz, useDisplayTz, currentTzOption } from '../lib/displayTz';
import { Spinner } from './AsyncState';
import ChoicePills from './ChoicePills';
import { TimeField, DateField } from '../tasks/components';
import { filesFromPaste } from '../tasks/lib';

const field = { border: '1px solid var(--line)', borderRadius: 8, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit', background: 'var(--card)', color: 'var(--ink)' };
const small = { ...field, padding: '4px 6px', fontSize: 12.5, minWidth: 0, width: '100%', boxSizing: 'border-box' };
const lab = { fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', display: 'block', marginBottom: 4 };
const SOURCES = ['Fill In A Day', 'Copy A Day'];
const MODES = { 'All Working Days': 'working', 'All Days': 'all', 'Pick Days': 'days' };
const TPL_TYPES = ['Work', 'Sick Day', 'Vacation', 'Personal'];
const MAX_DAYS = 62;
const DOC_TYPES = 'image/*,application/pdf';
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);

export default function AddTimeFromRecordModal({ email, name = '', start, end, onClose, onDone, toastOk, toastErr }) {
  useDisplayTz();   // times are typed in the time sheet's display zone
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(end);
  const [loaded, setLoaded] = useState(null);   // the server's days for from..to | null while reading
  const [err, setErr] = useState('');
  const [source, setSource] = useState(SOURCES[0]);
  const [srcDate, setSrcDate] = useState('');
  const [inT, setInT] = useState('08:30');
  const [outT, setOutT] = useState('17:00');
  const [breaks, setBreaks] = useState([{ start: '12:00', end: '12:30' }]);
  const [type, setType] = useState('Work');
  const [modeLabel, setModeLabel] = useState('All Working Days');
  const [picked, setPicked] = useState(() => new Set());
  const [edits, setEdits] = useState({});        // {date: the row's own values over the template}
  const [reason, setReason] = useState('');
  const [doc, setDoc] = useState(null);          // {path, name} once staged
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const fileRef = useRef(null);
  const mode = MODES[modeLabel];
  const copying = source === SOURCES[1];
  const touch = () => setPreview(null);

  const rangeErr = !from || !to ? 'Pick the first and last day.'
    : to < from ? 'The range ends before it starts.'
      : daysBetween(from, to) >= MAX_DAYS ? `Pick a range of ${MAX_DAYS} days or less.` : '';

  useEffect(() => {
    if (busy) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  // A fresh range starts from the mode's own days (modeRef: the mode as it
  // is when the days arrive, without reloading them on a mode change).
  const modeRef = useRef(mode);
  const key = `${from}|${to}`;
  useEffect(() => {
    if (rangeErr) return undefined;
    let alive = true;
    api.timeRecordDays(email, from, to).then((r) => {
      if (!alive) return;
      const list = Array.isArray(r?.days) ? r.days : [];
      setLoaded({ key: `${from}|${to}`, days: list, name: r?.name || '', india: r?.india || null });
      setPicked(defaultPicks(list, modeRef.current));
      setPreview(null);
      setErr('');
    }).catch((e) => { if (alive) { setLoaded({ key: `${from}|${to}`, days: [], name: '' }); setErr(e?.message || "Could not read this person's days."); } });
    return () => { alive = false; };
  }, [email, from, to, rangeErr]);

  const ready = !rangeErr && loaded?.key === key;   // the days on screen are this range's
  const days = useMemo(() => (ready ? loaded.days : []), [ready, loaded]);
  const byDate = useMemo(() => Object.fromEntries(days.map((d) => [d.date, d])), [days]);
  const who = loaded?.name || name;
  const india = (ready && loaded.india) || null;
  const copyable = useMemo(() => days.filter((d) => (d.shifts || []).length && d.shifts.every((s) => s.wellFormed)), [days]);
  const srcDay = copyable.some((d) => d.date === srcDate) ? srcDate : (copyable[0]?.date || '');
  const pickMode = (label) => { modeRef.current = MODES[label]; setModeLabel(label); setPicked(defaultPicks(days, MODES[label])); touch(); };

  const template = useMemo(() => {
    if (copying) return rowFromShifts(byDate[srcDay]?.shifts, utcToInputTz) || { type: 'Work', in: '', out: '', breaks: [], category: '' };
    return { type, in: inT, out: outT, breaks: LEAVE_TYPES.includes(type) ? [] : breaks, category: '' };
  }, [copying, byDate, srcDay, type, inT, outT, breaks]);
  const rowFor = (ds) => ({ ...template, ...(edits[ds] || {}) });
  const editRow = (ds, patch) => { setEdits((m) => ({ ...m, [ds]: { ...(m[ds] || {}), ...patch } })); touch(); };
  const resetRow = (ds) => { setEdits((m) => { const n = { ...m }; delete n[ds]; return n; }); touch(); };
  const toggle = (ds) => {
    setPicked((p) => { const n = new Set(p); if (n.has(ds)) n.delete(ds); else n.add(ds); return n; });
    touch();
  };

  const chosen = days.filter((d) => picked.has(d.date) && dayGate(d).ok).map((d) => d.date);
  const totalMin = chosen.reduce((s, ds) => s + rowMinutes(rowFor(ds)), 0);
  const results = useMemo(() => Object.fromEntries((preview?.days || []).map((r) => [r.date, r])), [preview]);
  const willDo = (preview?.days || []).filter((r) => ['add', 'replace', 'clear'].includes(r.action));

  const payload = (dry) => ({
    employee_email: email, reason: reason.trim(), dry_run: dry, start: from, end: to,
    source_doc_path: doc?.path || '', source_doc_name: doc?.name || '',
    rows: recordRows(chosen, rowFor, (ds) => (byDate[ds]?.shifts || []).length > 0, inputToUtcTz, tzOffsetForInput),
  });
  const check = () => {
    if (rangeErr) return rangeErr;
    if (!chosen.length) return 'Pick at least one day.';
    const blank = chosen.find((ds) => { const r = rowFor(ds); return r.type !== 'Off' && (!r.in || !r.out); });
    if (blank) return `${weekday(blank)} ${formatDate(blank)} needs a clock-in and a clock-out time.`;
    if (reason.trim().length < 3) return 'Say why this time is being added - the employee reads it on every day.';
    return '';
  };
  const run = async (dry) => {
    const why = check();
    setErr(why);
    if (why) return;
    setBusy(true);
    try {
      const r = await api.timeDuplicateDay(payload(dry));
      if (dry) setPreview(r);
      else {
        setDone(r);
        if (r.batchId) toastOk?.(`Added time from the record to ${who || email}'s time sheet.`);
        onDone?.(r);
      }
    } catch (e) { const m = e?.message || 'Could not add the time.'; setErr(m); toastErr?.(m); }
    finally { setBusy(false); }
  };
  const undo = async () => {
    setBusy(true); setErr('');
    try { await api.timeDuplicateDayUndo(done.batchId); toastOk?.('The time added from the record was taken back.'); onDone?.(); onClose?.(); }
    catch (e) { const m = e?.message || 'Could not undo it.'; setErr(m); toastErr?.(m); }
    finally { setBusy(false); }
  };
  const attach = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type || '') && file.type !== 'application/pdf') { setErr('The source document is a picture or a PDF.'); return; }
    setUploading(true); setErr('');
    try { const r = await api.timeRecordSourceDoc(email, file); setDoc({ path: r.path, name: r.name || file.name }); touch(); }
    catch (e) { const m = e?.message || 'Could not upload the document.'; setErr(m); toastErr?.(m); }
    finally { setUploading(false); }
  };
  // A picture pasted anywhere in the popup is the source document (text pastes
  // into the boxes as usual - filesFromPaste only takes images).
  const onPaste = (e) => { const f = filesFromPaste(e); if (f.length) { e.preventDefault(); attach(f[0]); } };

  const zone = currentTzOption?.()?.label || '';
  const resultRows = (list) => list.map((r) => (
    <div key={r.date} data-rec-result={r.action} style={{ display: 'flex', gap: 10, padding: '7px 12px', borderTop: '1px solid var(--line)', fontSize: 13, alignItems: 'baseline' }}>
      <span style={{ width: 130, flexShrink: 0, fontWeight: 700 }}>{weekday(r.date)} {formatDate(r.date)}</span>
      <span style={{ flex: 1, color: r.action === 'skip' ? 'hsl(var(--color-red))' : r.action === 'replace' || r.action === 'clear' ? '#b45309' : 'var(--ink)' }}>{dupPlanText(r)}</span>
    </div>
  ));

  return (
    <div onClick={busy ? undefined : onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--wk-font)' }}>
      <div role="dialog" aria-modal="true" aria-label={`Add time from a record for ${who || email}`} onClick={(e) => e.stopPropagation()} onPaste={onPaste} className="nx-popup"
        style={{ background: 'var(--card)', color: 'var(--ink)', borderRadius: 16, display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.28)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <ClipboardList size={18} style={{ color: 'var(--wk-brand, #15803d)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Add Time From Record for {who || email}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>HR only. Key in a time sheet kept outside Nexus: set one day, lay it over the range, then adjust any row.{zone ? ` Times in ${zone}.` : ''}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={busy} style={{ padding: 6 }}><X size={16} /></button>
        </div>

        {done ? (
          <div style={{ padding: '22px 18px', overflow: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(0,162,91,0.12)', color: 'hsl(var(--color-green))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Check size={18} /></span>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                {done.batchId ? `Saved ${done.added} day${done.added === 1 ? '' : 's'} - ${hm(done.totalMin)} in all${done.cleared ? `, ${done.cleared} cleared` : ''}.` : 'Nothing was saved.'}
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
            <div style={{ padding: '14px 18px', overflow: 'auto', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* The range and which of its days */}
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div><span style={lab}>From</span><DateField value={from} onChange={(v) => { if (v) { setFrom(v); touch(); } }} style={{ ...field, minWidth: 130 }} title="First day of the record" /></div>
                <div><span style={lab}>To</span><DateField value={to} onChange={(v) => { if (v) { setTo(v); touch(); } }} style={{ ...field, minWidth: 130 }} title="Last day of the record" /></div>
                <div><span style={lab}>Days</span>
                  <ChoicePills label="Days" value={modeLabel} options={Object.keys(MODES)} onChange={pickMode} /></div>
              </div>

              {/* The template day */}
              <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div><span style={lab}>Every Day Starts As</span>
                  <ChoicePills label="Every day starts as" value={source} options={SOURCES} onChange={(s) => { setSource(s); touch(); }} /></div>
                {copying ? (
                  copyable.length ? (
                    <label style={{ display: 'block' }}><span style={lab}>Copy From</span>
                      <select data-source-day value={srcDay} onChange={(e) => { setSrcDate(e.target.value); touch(); }} style={{ ...field, minWidth: 220 }}>
                        {copyable.map((d) => <option key={d.date} value={d.date}>{weekday(d.date)} {formatDate(d.date)} - {hm(d.workedMin)}</option>)}
                      </select>
                    </label>
                  ) : <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No day in this range has complete punches to copy - fill one in instead.</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <label style={{ display: 'block' }}><span style={lab}>Clock In</span><TimeField ariaLabel="Clock In" value={inT} onChange={(v) => { setInT(v); touch(); }} style={field} step={5} /></label>
                      <label style={{ display: 'block' }}><span style={lab}>Clock Out</span><TimeField ariaLabel="Clock Out" value={outT} onChange={(v) => { setOutT(v); touch(); }} style={field} step={5} /></label>
                      <div><span style={lab}>Type</span>
                        <ChoicePills label="Type" value={type} options={TPL_TYPES} onChange={(t) => { setType(t); touch(); }} /></div>
                    </div>
                    {!LEAVE_TYPES.includes(type) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ ...lab, marginBottom: 0 }}>Unpaid Breaks</span>
                        {breaks.map((b, i) => (
                          <div key={i} data-break-row style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                            <TimeField ariaLabel={`Break ${i + 1} start`} value={b.start} onChange={(v) => { setBreaks((l) => l.map((x, j) => (j === i ? { ...x, start: v } : x))); touch(); }} style={small} step={5} />
                            <span style={{ color: 'var(--muted)' }}>to</span>
                            <TimeField ariaLabel={`Break ${i + 1} end`} value={b.end} onChange={(v) => { setBreaks((l) => l.map((x, j) => (j === i ? { ...x, end: v } : x))); touch(); }} style={small} step={5} />
                            <button type="button" className="icon-btn" aria-label={`Remove break ${i + 1}`} onClick={() => { setBreaks((l) => l.filter((_x, j) => j !== i)); touch(); }} style={{ padding: 4 }}><Trash2 size={13} /></button>
                          </div>
                        ))}
                        <button type="button" className="secondary-btn" onClick={() => { setBreaks((l) => [...l, { start: '15:00', end: '15:15' }]); touch(); }}
                          style={{ alignSelf: 'flex-start', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={12} /> Add Break</button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* The review grid - one row per day, each its own */}
              <div className="nx-fill" style={{ minHeight: 160 }}>
                <span style={lab}>Review The Days - {chosen.length} picked, {hm(totalMin)}</span>
                {rangeErr ? <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{rangeErr}</div>
                  : !ready ? <div style={{ padding: 16, display: 'flex', justifyContent: 'center' }}><Spinner /></div> : (
                    <div data-rec-grid className={`nx-rec-grid${india ? ' nx-rec-india' : ''}`} style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'auto', flex: 1, minHeight: 0 }}>
                      <div className="nx-rec-row nx-rec-head" aria-hidden="true">
                        <span>Day</span><span>Type</span><span>In</span><span>Out</span><span>Breaks</span><span>Hours</span>{india && <span>Credit</span>}<span>Status</span>
                      </div>
                      {days.map((d) => (
                        <RecordRowView key={d.date} d={d} on={picked.has(d.date)} row={rowFor(d.date)} edited={!!edits[d.date]}
                          result={results[d.date]} india={india} onToggle={() => toggle(d.date)} onEdit={(p) => editRow(d.date, p)} onReset={() => resetRow(d.date)} />
                      ))}
                    </div>
                  )}
              </div>

              {/* Reason and the record itself */}
              <div className="nx-rec-foot" style={{ display: 'grid', gap: 12 }}>
                <label style={{ display: 'block' }}>
                  <span style={lab}>Reason</span>
                  <textarea value={reason} onChange={(e) => { setReason(e.target.value); touch(); }} rows={2} maxLength={300}
                    placeholder="What this record is - the employee reads it on every day, e.g. paper time sheet for October, kept while the clock was down"
                    style={{ ...field, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
                </label>
                <div>
                  <span style={lab}>Source Document</span>
                  <div data-source-doc tabIndex={0} aria-label="Source document - choose a file or press Ctrl+V to paste a picture"
                    style={{ border: '1.5px dashed var(--line)', borderRadius: 10, padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
                    <input ref={fileRef} type="file" accept={DOC_TYPES} hidden aria-label="Choose the source document"
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; attach(f); }} />
                    {doc ? (
                      <>
                        <Paperclip size={14} style={{ color: 'var(--muted)' }} />
                        <span data-doc-name style={{ fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.name}</span>
                        <button type="button" className="secondary-btn" onClick={() => { setDoc(null); touch(); }} style={{ fontSize: 12 }}>Remove</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="secondary-btn" onClick={() => fileRef.current?.click()} disabled={uploading} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <Paperclip size={12} /> {uploading ? 'Uploading...' : 'Choose File'}
                        </button>
                        <span style={{ color: 'var(--muted)' }}>Optional - a picture or PDF of the paper time sheet, or press Ctrl+V to paste a picture. HR only; the employee sees the reason.</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              {err && <div role="alert" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{err}</div>}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
              {preview && (
                <span data-preview style={{ marginRight: 'auto', fontSize: 12.5, color: 'var(--muted)', fontWeight: 600 }}>
                  {willDo.length ? `${hm(preview.totalMin)} over ${willDo.length} day${willDo.length === 1 ? '' : 's'}${preview.replaced ? ` - ${preview.replaced} replaced` : ''}`
                    : 'Nothing to save - every day was skipped'}
                  {(preview.days || []).some((r) => r.action === 'skip') ? ' - see the rows in red' : ''}
                </span>
              )}
              <button type="button" className="secondary-btn" onClick={onClose} disabled={busy}>Cancel</button>
              {!preview ? (
                <button type="button" className="primary-btn" onClick={() => run(true)} disabled={busy || !ready || uploading}>
                  {busy ? 'Checking...' : `Check ${chosen.length} Day${chosen.length === 1 ? '' : 's'}`}
                </button>
              ) : (
                <button type="button" className="primary-btn" onClick={() => run(false)} disabled={busy || !willDo.length || uploading} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Check size={14} /> {busy ? 'Saving...' : `Save ${willDo.length} Day${willDo.length === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// One day of the grid. A picked day shows its own controls (tab through
// type, in, out, breaks); a day that is not picked is a single line. A day
// with punches already is Skip until picked - picked, it replaces them.
function RecordRowView({ d, on, row, edited, result, india, onToggle, onEdit, onReset }) {
  const gate = dayGate(d);
  const picked = on && gate.ok;
  const leave = LEAVE_TYPES.includes(row.type);
  const off = row.type === 'Off';
  const label = `${weekday(d.date)} ${formatDate(d.date)}`;
  const weekend = [0, 6].includes(new Date(`${d.date}T12:00:00`).getDay());
  const has = (d.shifts || []).length > 0;
  const mins = rowMinutes(row);
  const live = picked && india && d.india ? creditOf(row, india) : '';
  const credit = result?.credit ? CREDIT_WORD[result.credit] || '' : live;
  const note = !gate.ok ? { text: gate.text, tone: gate.tone || 'muted', title: gate.title }
    : has ? { text: `${picked ? 'Replaces' : 'Has'} ${hm(d.workedMin)}: ${shiftsText(d.shifts, utcToInputTz, t12)}`, tone: picked ? 'amber' : 'ink' }
      : d.holiday ? { text: `Holiday - ${d.holiday}`, tone: 'amber' }
        : d.timeOff ? { text: `Approved Time Off - ${d.timeOff.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`, tone: 'amber' }
          : d.leftOut ? { text: d.leftOut, tone: 'muted' } : null;
  const status = result
    ? { text: result.action === 'skip' ? result.reason || 'Skipped' : dupPlanText(result), tone: result.action === 'skip' ? 'red' : result.action === 'add' || result.action === 'off' ? 'green' : 'amber' }
    : null;
  const setBreak = (i, k, v) => onEdit({ breaks: (row.breaks || []).map((b, j) => (j === i ? { ...b, [k]: v } : b)) });
  return (
    <div className={`nx-rec-row${picked ? ' is-on' : ''}`} data-rec-day={d.date} data-state={d.state}
      style={{ background: picked ? 'var(--wk-brand-tint, rgba(21,128,61,0.06))' : weekend ? 'var(--wk-hover, var(--bg))' : undefined, opacity: gate.ok ? 1 : 0.6 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, cursor: gate.ok ? 'pointer' : 'not-allowed' }} title={gate.title || undefined}>
        <input type="checkbox" checked={picked} disabled={!gate.ok} onChange={onToggle} aria-label={`${has ? 'Replace' : 'Add'} ${label}`} style={{ margin: 0 }} />
        <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      </label>
      {picked ? (
        <>
          <select aria-label={`Type for ${label}`} value={row.type} onChange={(e) => onEdit({ type: e.target.value })} style={small}>
            {ROW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {off ? <span className="nx-rec-wide" style={{ gridColumn: 'span 3', fontSize: 12, color: 'var(--muted)' }}>{has ? 'Off - the punches on this day are cleared.' : 'Off - nothing is added.'}</span> : (
            <>
              <TimeField ariaLabel={`Clock in for ${label}`} value={row.in} onChange={(v) => onEdit({ in: v })} style={small} step={5} />
              <TimeField ariaLabel={`Clock out for ${label}`} value={row.out} onChange={(v) => onEdit({ out: v })} style={small} step={5} />
              <div className="nx-rec-breaks" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                {leave ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>No breaks on leave</span> : (
                  <>
                    {(row.breaks || []).map((b, i) => (
                      <span key={i} data-rec-break style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <TimeField ariaLabel={`Break ${i + 1} start for ${label}`} value={b.start} onChange={(v) => setBreak(i, 'start', v)} style={{ ...small, padding: '3px 4px', width: 'auto' }} step={5} />
                        <span style={{ color: 'var(--muted)', fontSize: 11 }}>to</span>
                        <TimeField ariaLabel={`Break ${i + 1} end for ${label}`} value={b.end} onChange={(v) => setBreak(i, 'end', v)} style={{ ...small, padding: '3px 4px', width: 'auto' }} step={5} />
                        <button type="button" className="icon-btn" aria-label={`Remove break ${i + 1} for ${label}`} onClick={() => onEdit({ breaks: row.breaks.filter((_x, j) => j !== i) })} style={{ padding: 2 }}><X size={12} /></button>
                      </span>
                    ))}
                    <button type="button" className="icon-btn" aria-label={`Add a break for ${label}`} title="Add Break"
                      onClick={() => onEdit({ breaks: [...(row.breaks || []), { start: '12:00', end: '12:30' }] })} style={{ padding: 3 }}><Plus size={13} /></button>
                  </>
                )}
              </div>
            </>
          )}
          <span data-rec-hours style={{ fontSize: 12.5, fontWeight: 700 }}>{off ? '-' : hm(result && result.action !== 'skip' && !leave ? result.workedMin : mins)}</span>
          {india && <span data-rec-credit style={{ fontSize: 12, fontWeight: 700, color: credit === 'Full' ? TONE.green : credit === 'Half' ? TONE.amber : credit === 'None' ? TONE.red : 'var(--muted)' }}>{d.india ? credit : '-'}</span>}
        </>
      ) : (
        <span className="nx-rec-skip" style={{ gridColumn: `span ${india ? 6 : 5}`, fontSize: 12, color: 'var(--muted)' }}>{gate.ok ? 'Skip' : ''}</span>
      )}
      <span className="nx-rec-wide" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 12 }}>
        <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
          {note && <span title={note.title || note.text} style={{ color: TONE[note.tone] || 'var(--muted)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{note.text}</span>}
          {status && <span data-rec-status={result.action} style={{ color: TONE[status.tone], fontWeight: 700 }}>{status.text}</span>}
        </span>
        {picked && edited && (
          <button type="button" className="icon-btn" aria-label={`Reset ${label} to the template`} title="Reset To The Template" onClick={onReset} style={{ padding: 3, marginLeft: 'auto' }}><RotateCcw size={12} /></button>
        )}
      </span>
    </div>
  );
}
