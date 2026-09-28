// Schedule grid extras (Sep 29 2026, Teams Shifts parity - the last items on
// the QA gap list): the Shift Types row layout, Print, Excel import and
// adding time off straight from the grid. Kept out of ShiftSchedule.jsx,
// which is big enough already.
import { useEffect, useState } from 'react';
import { X, Upload, Loader2, Clock, Star, Pencil, Plus, CalendarOff, Palette, CalendarRange, Copy, ClipboardPaste, Trash2 } from 'lucide-react';
import { api } from '../api';
import { TIMEOFF_LABELS, timeOffLabel, parseScheduleSheet } from './shiftScheduleLib';
import { formatDate } from '../lib/datetime';

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

// ── Row avatar ──────────────────────────────────────────────────────────
// The person's profile photo (Neil, Sep 29), initials when there is none or
// it fails to load.
export function Avatar({ name, photoUrl, size = 26 }) {
  const [broken, setBroken] = useState(false);
  const base = { width: size, height: size, borderRadius: '50%', flexShrink: 0 };
  if (photoUrl && !broken) {
    return <img src={photoUrl} alt="" draggable={false} onError={() => setBroken(true)} style={{ ...base, objectFit: 'cover', border: '1px solid var(--line)' }} />;
  }
  return (
    <span style={{ ...base, background: 'var(--bg)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.38, fontWeight: 800, color: 'var(--muted)' }}>
      {(name || '').split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}
    </span>
  );
}

// ── Shift menu (Teams parity) ───────────────────────────────────────────
// Right-click a shift (or its ⋯ button), or an empty day: Edit Shift, Add
// Shift, Add Time Off, Color, Move to Open Shifts, Copy, Paste, Delete.
export function ShiftMenu({ menu, colors, canTimeOff, hasCopied, onAction, onClose }) {
  const [colorsOpen, setColorsOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const s = menu.shift;
  const item = (key, Icon, label, { hint, disabled, onClick } = {}) => (
    <button key={key} type="button" role="menuitem" disabled={disabled}
      onClick={onClick || (() => onAction(key))}
      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', border: 'none', background: 'none', padding: '7px 12px',
        fontSize: 12.5, fontFamily: 'inherit', color: disabled ? 'var(--muted)' : 'var(--ink)', cursor: disabled ? 'default' : 'pointer', textAlign: 'left', opacity: disabled ? 0.55 : 1 }}
      className="shift-menu-item">
      <Icon size={14} /> <span style={{ flex: 1 }}>{label}</span>
      {hint && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{hint}</span>}
    </button>
  );
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 232));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 340));
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1500 }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div role="menu" aria-label={s ? 'Shift options' : 'Day options'} onClick={e => e.stopPropagation()}
        style={{ position: 'fixed', left, top, width: 220, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10,
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: '4px 0', fontFamily: 'Inter,sans-serif' }}>
        {s && item('edit', Pencil, 'Edit Shift')}
        {item('add', Plus, 'Add Shift')}
        {canTimeOff && menu.email && item('timeoff', CalendarOff, 'Add Time Off')}
        {s && item('color', Palette, 'Color', { hint: colorsOpen ? '▾' : '▸', onClick: () => setColorsOpen(o => !o) })}
        {s && colorsOpen && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 12px 8px 35px' }}>
            <button type="button" aria-label="Preset color" onClick={() => onAction('color', '')}
              style={{ fontSize: 11, fontWeight: 700, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', padding: '1px 6px', fontFamily: 'inherit' }}>Preset</button>
            {colors.map(c => (
              <button key={c} type="button" aria-label={`Color ${c}`} onClick={() => onAction('color', c)}
                style={{ width: 18, height: 18, borderRadius: 5, background: c, cursor: 'pointer', border: s.ownColor === c ? '2px solid var(--ink)' : '2px solid transparent' }} />
            ))}
          </div>
        )}
        {s && s.email && item('toOpen', CalendarRange, 'Move to Open Shifts')}
        <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />
        {s && item('copy', Copy, 'Copy', { hint: 'Ctrl+C' })}
        {item('paste', ClipboardPaste, 'Paste', { hint: 'Ctrl+V', disabled: !hasCopied })}
        {s && item('delete', Trash2, 'Delete')}
      </div>
    </div>
  );
}

const short12 = (hhmm) => {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'p' : 'a'}`;
};

// ── Shift type palette ──────────────────────────────────────────────────
// Neil, Sep 29: "GSM is a shift time... I'm picking up a GSM shift and I'm
// giving it to Beth." Drag a shift type onto anyone's day to place it.
export function ShiftPalette({ presets, onStart }) {
  if (!presets?.length) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
      <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>Drag a shift onto someone's day:</span>
      {presets.map(p => (
        <span key={p.id} data-preset={p.code || p.name}
          title={`${p.name}${p.start ? ` · ${hm12(p.start)} - ${hm12(p.end)}` : ''}`}
          onMouseDown={(e) => onStart(e, p)}
          style={{ cursor: 'grab', userSelect: 'none', fontSize: 11.5, fontWeight: 800, color: '#334155', padding: '4px 10px', borderRadius: 6,
            background: (p.color || '#64748b') + '22', borderLeft: `3px solid ${p.color || '#64748b'}` }}>
          {`${p.code || p.name} ${p.start ? `${short12(p.start)}-${short12(p.end)}` : ''}`.trim()}
        </span>
      ))}
    </div>
  );
}

// ── Shift details (the magnifier on a shift, Teams parity) ─────────────
export function ShiftDetails({ at, shift: s, name, status, onEdit, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const left = Math.max(8, Math.min(at.x + 8, window.innerWidth - 300));
  const top = Math.max(8, Math.min(at.y + 8, window.innerHeight - 320));
  const row = (label, value) => value ? (
    <div style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
      <span style={{ width: 78, color: 'var(--muted)', flexShrink: 0 }}>{label}</span><span style={{ minWidth: 0 }}>{value}</span>
    </div>
  ) : null;
  const day = new Date(`${s.date}T00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1500 }} onClick={onClose}>
      <div role="dialog" aria-label="Shift Details" onClick={e => e.stopPropagation()}
        style={{ position: 'fixed', left, top, width: 290, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: 14, fontFamily: 'Inter,sans-serif', borderTop: `4px solid ${s.color || '#64748b'}` }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 800, flex: 1 }}>{s.code || s.label || 'Shift'}</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={15} /></button>
        </div>
        {row('Who', name)}
        {row('When', `${day}, ${formatDate(s.date)}`)}
        {row('Time', `${hm12(s.start)} - ${hm12(s.end)}`)}
        {row('Break', s.breakMin ? `${s.breakMin} min unpaid` : '')}
        {row('Label', s.label)}
        {row('Note', s.note)}
        {row('Activities', (s.activities || []).map(a => `${hm12(a.start)} - ${hm12(a.end)} ${a.label}`).join('; '))}
        {row('Status', status)}
        {s.conflicts?.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12, color: '#b45309' }}>{s.conflicts.map((c, i) => <div key={i}>{c}</div>)}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" className="primary-btn" onClick={onEdit} style={{ fontSize: 12.5 }}><Pencil size={12} /> Edit Shift</button>
        </div>
      </div>
    </div>
  );
}

