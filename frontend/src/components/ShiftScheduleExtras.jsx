// Schedule grid extras (Sep 29 2026, Teams Shifts parity - the last items on
// the QA gap list): the Shift Types row layout, Print, Excel import and
// adding time off straight from the grid. Kept out of ShiftSchedule.jsx,
// which is big enough already.
import { useEffect, useState } from 'react';
import { X, Upload, Loader2, Clock, Star } from 'lucide-react';
import { api } from '../api';
import { TIMEOFF_LABELS, timeOffLabel, parseScheduleSheet } from './shiftScheduleLib';

const hm12 = (hhmm) => {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const MODAL_BACK = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' };
const MODAL_CARD = { background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 480, padding: 20, maxHeight: '92dvh', overflowY: 'auto' };
const LBL = { fontSize: 11, color: 'var(--muted)', marginBottom: 4 };
const CHECK = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' };

// ── Shift Types rows (Teams "view by shift") ─────────────────────────────
// Rows are the shift types instead of people; each cell lists who works it.
export function ShiftTypeWeek({ days, shifts, presets, names, onOpen }) {
  const rows = new Map((presets || []).map(p => [p.id, { key: p.id, name: p.name, code: p.code, color: p.color, items: [] }]));
  const custom = { key: '__custom', name: 'Custom Times', code: '', color: '#64748b', items: [] };
  (shifts || []).forEach(s => (rows.get(s.shiftId) || custom).items.push(s));
  const list = [...rows.values(), custom].filter(r => r.items.length);
  const GRID = { display: 'grid', gridTemplateColumns: '190px repeat(7, minmax(120px, 1fr))' };
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 12 }}>
      <div style={{ minWidth: 900 }}>
        <div style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}>
          <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Shift Type</div>
          {days.map((d, i) => (
            <div key={i} style={{ padding: '8px 10px', borderLeft: '1px solid var(--line)' }}>
              <span style={{ fontSize: 16, fontWeight: 800 }}>{d.getDate()}</span>{' '}
              <span style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
            </div>
          ))}
        </div>
        {list.length === 0 && <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>No shifts in this week.</div>}
        {list.map(r => (
          <div key={r.key} data-type-row={r.name} style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
            <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: r.color || '#64748b', flexShrink: 0 }} />
              <span style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.code ? `${r.code} · ${r.name}` : r.name}</div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{r.items.length} shift{r.items.length === 1 ? '' : 's'}</div>
              </span>
            </div>
            {days.map((d, i) => {
              const ds = isoOf(d);
              const items = r.items.filter(s => s.date === ds).sort((a, b) => a.start.localeCompare(b.start));
              return (
                <div key={i} style={{ borderLeft: '1px solid var(--line)', padding: 4, minHeight: 48 }}>
                  {items.map(s => (
                    <button key={s.id} type="button" onClick={() => onOpen(s)}
                      style={{ display: 'block', width: '100%', textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer', marginBottom: 3,
                        background: (s.color || '#64748b') + '1a', border: 'none', borderLeft: `3px solid ${s.color || '#64748b'}`, borderRadius: 6, padding: '4px 7px',
                        opacity: s.pendingDelete ? 0.5 : 1 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        {s.published === false && <Star size={10} fill="#f59e0b" color="#f59e0b" />}
                        {s.email ? (names[s.email] || s.email) : `Open${(s.openSlots || 1) > 1 ? ` ×${s.openSlots}` : ''}`}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 3 }}><Clock size={9} /> {hm12(s.start)} - {hm12(s.end)}</div>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Excel import ─────────────────────────────────────────────────────────
export function ImportModal({ employees, busy, onImport, onClose }) {
  const [parsed, setParsed] = useState(null);
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState(null);

  async function pick(file) {
    setParsed(null); setResult(null);
    if (!file) return;
    setReading(true);
    try {
      const XLSX = await import('xlsx');
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const aoa = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: '' });
      setParsed(parseScheduleSheet(aoa, employees));
    } catch {
      setParsed({ rows: [], problems: ["That file can't be read. Save it as .xlsx or .csv and try again."] });
    }
    setReading(false);
  }
  async function go() {
    const r = await onImport(parsed.rows);
    if (r) setResult(r);
  }
  const problems = [...(parsed?.problems || []), ...(result?.errors || [])];

  return (
    <div style={MODAL_BACK} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Import Schedule" style={MODAL_CARD}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Import Schedule</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Add shifts from an Excel or CSV file. Use the columns Export writes (Date, Email or Employee, Start, End, and optionally
          Shift Type, Unpaid Break (min), Label, Note, Open Spots) - exporting a week is the easiest way to get a template.
          Every shift comes in as a draft.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px dashed var(--line)', borderRadius: 10, padding: '12px 14px', cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>
          <Upload size={15} /> Choose a File
          <input type="file" aria-label="Schedule file" accept=".xlsx,.xls,.csv" onChange={e => pick(e.target.files?.[0])} style={{ display: 'none' }} />
          {reading && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginLeft: 'auto' }} />}
        </label>
        {parsed && !result && (
          <div style={{ fontSize: 12.5, marginTop: 12, fontWeight: 700 }}>
            {parsed.rows.length} shift{parsed.rows.length === 1 ? '' : 's'} ready to import
            {parsed.problems.length > 0 && ` · ${parsed.problems.length} row${parsed.problems.length === 1 ? '' : 's'} can't be read`}
          </div>
        )}
        {result && (
          <div style={{ fontSize: 12.5, marginTop: 12, fontWeight: 700 }}>
            Added {result.created} shift{result.created === 1 ? '' : 's'} as drafts · {result.errorCount} skipped
          </div>
        )}
        {problems.length > 0 && (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: '#b91c1c', maxHeight: 160, overflowY: 'auto' }}>
            {problems.slice(0, 50).map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
          {!result && (
            <button className="primary-btn" onClick={go} disabled={busy || !parsed?.rows.length}
              style={{ opacity: busy || !parsed?.rows.length ? 0.55 : 1 }}>{busy ? '…' : 'Import Shifts'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Time off from the grid ──────────────────────────────────────────────
// Files a request on the person's behalf (the same /timeoff/on-behalf the
// Time Off screen uses, so they are told), and approves it right away unless
// unticked - the usual "I'm adding this for you" case.
export function TimeOffModal({ email, name, date, busy, onSave, onClose }) {
  const [types, setTypes] = useState(null);
  useEffect(() => {
    let live = true;
    api.timeOffTypes().then(r => { if (live) setTypes(r); })
      .catch(() => { if (live) setTypes({ builtIn: Object.keys(TIMEOFF_LABELS), custom: [] }); });
    return () => { live = false; };
  }, []);
  const [f, setF] = useState({ type: 'vacation', start: date, end: date, allDay: true, startTime: '09:00', endTime: '13:00', note: '', approve: true });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const partial = !f.allDay;
  const problem = !f.start || !f.end ? 'Pick the days.'
    : f.end < f.start ? 'The last day is before the first.'
      : partial && f.start !== f.end ? 'Part of a day must start and end on the same day.'
        : partial && f.endTime <= f.startTime ? 'The end time has to be after the start time.' : '';

  function submit() {
    if (problem) return;
    onSave({ employee_email: email, type: f.type, start_date: f.start, end_date: f.end,
      start_time: partial ? f.startTime : '', end_time: partial ? f.endTime : '', note: f.note.trim() }, f.approve);
  }
  const opts = types ? [...types.builtIn.map(t => [t, timeOffLabel(t)]), ...types.custom.map(t => [t, t])] : [];
  return (
    <div style={MODAL_BACK} onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Add Time Off" style={MODAL_CARD}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Add Time Off</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>For {name || email}. They get a notification.</div>
        <div style={{ display: 'grid', gap: 12 }}>
          <label><div style={LBL}>Type</div>
            <select className="form-input" aria-label="Time-off type" value={f.type} onChange={e => set('type', e.target.value)} style={{ width: '100%', fontSize: 13 }}>
              {opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>First day</div>
              <input type="date" className="form-input" aria-label="First day" value={f.start} onChange={e => setF(p => ({ ...p, start: e.target.value, end: p.allDay ? p.end : e.target.value }))} style={{ width: '100%', fontSize: 13 }} /></label>
            <label style={{ flex: 1 }}><div style={LBL}>Last day</div>
              <input type="date" className="form-input" aria-label="Last day" value={f.end} disabled={partial} onChange={e => set('end', e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
          </div>
          <label style={CHECK}><input type="checkbox" checked={f.allDay} onChange={e => setF(p => ({ ...p, allDay: e.target.checked, end: e.target.checked ? p.end : p.start }))} /> All day</label>
          {partial && (
            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ flex: 1 }}><div style={LBL}>From</div><input type="time" className="form-input" aria-label="From" value={f.startTime} onChange={e => set('startTime', e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
              <label style={{ flex: 1 }}><div style={LBL}>To</div><input type="time" className="form-input" aria-label="To" value={f.endTime} onChange={e => set('endTime', e.target.value)} style={{ width: '100%', fontSize: 13 }} /></label>
            </div>
          )}
          <input className="form-input" placeholder="Note (optional)" aria-label="Note" value={f.note} onChange={e => set('note', e.target.value)} style={{ fontSize: 13 }} />
          <label style={CHECK}><input type="checkbox" checked={f.approve} onChange={e => set('approve', e.target.checked)} /> Approve it now</label>
          {problem && <div style={{ fontSize: 11.5, color: '#b91c1c' }}>{problem}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" onClick={submit} disabled={busy || !!problem || !types} style={{ opacity: busy || problem ? 0.55 : 1 }}>{busy ? '…' : 'Add Time Off'}</button>
        </div>
      </div>
    </div>
  );
}
