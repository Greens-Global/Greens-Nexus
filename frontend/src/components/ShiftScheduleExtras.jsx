// Schedule grid extras: the Shift Types row layout, Excel import, the row
// avatar, the context menus and the details card. Kept out of
// ShiftSchedule.jsx, which is the container; the grid itself is
// components/shifts/WeekGrid.jsx (Oct 2026 rebuild, redesigned 10/02).
import { useEffect, useState } from 'react';
import { X, Upload, Pencil, Plus, CalendarOff, Palette, CalendarRange, Copy, ClipboardPaste, Trash2, Search, Clock, CalendarDays } from 'lucide-react';
import { parseScheduleSheet } from './shiftScheduleLib';
import { formatDate, formatWeekday } from '../lib/datetime';
import { Spinner } from './AsyncState';
import { ShiftBlock } from './shifts/ShiftBlock';
import { ContextMenu, MenuItem, MenuSep, MenuHead } from './shifts/Menu';
import { isoDate, dayHeading, shiftTimeText, minutesText, unpaidMinutes, SHIFT_COLORS, DEFAULT_SHIFT_COLOR } from './shifts/shiftLib';

const MODAL_BACK = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter,sans-serif' };
const MODAL_CARD = { background: 'var(--card)', borderRadius: 14, width: '100%', maxWidth: 480, padding: 20, maxHeight: '92dvh', overflowY: 'auto' };

// ── Shift Types rows (Teams "view by shift") ─────────────────────────────
// Rows are the shift types instead of people; each cell lists who works it.
export function ShiftTypeWeek({ days, shifts, presets, names, teamZone, onOpen }) {
  const rows = new Map((presets || []).map((p) => [p.id, { key: p.id, name: p.name, code: p.code, color: p.color, items: [] }]));
  const custom = { key: '__custom', name: 'Custom Times', code: '', color: DEFAULT_SHIFT_COLOR, items: [] };
  (shifts || []).forEach((s) => (rows.get(s.shiftId) || custom).items.push(s));
  const list = [...rows.values(), custom].filter((r) => r.items.length);
  const GRID = { display: 'grid', gridTemplateColumns: `230px repeat(${days.length}, minmax(128px, 1fr))` };
  const today = isoDate(new Date());
  return (
    <div style={{ overflow: 'auto', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--card)' }}>
      <div style={{ minWidth: 230 + days.length * 128 }}>
        <div style={{ ...GRID, borderBottom: '1px solid var(--line)', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 2 }}>
          <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em', alignSelf: 'end' }}>Shift Type</div>
          {days.map((d) => {
            const ds = isoDate(d);
            return (
              <div key={ds} style={{ padding: '8px 10px', borderLeft: '1px solid var(--line)', background: ds === today ? 'var(--wk-brand-tint)' : 'transparent' }}>
                <span style={{ fontSize: 17, fontWeight: 800, color: ds === today ? 'var(--wk-brand)' : 'var(--ink)' }}>{d.getDate()}</span>{' '}
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>{dayHeading(d).replace(/ \d+$/, '')}</span>
              </div>
            );
          })}
        </div>
        {list.length === 0 && <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>No shifts in this week.</div>}
        {list.map((r) => (
          <div key={r.key} data-type-row={r.name} style={{ ...GRID, borderBottom: '1px solid var(--line)' }}>
            <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, position: 'sticky', left: 0, background: 'var(--card)', borderRight: '1px solid var(--line)' }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: r.color || DEFAULT_SHIFT_COLOR, flexShrink: 0 }} />
              <span style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.code ? `${r.code} · ${r.name}` : r.name}</div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{r.items.length} shift{r.items.length === 1 ? '' : 's'}</div>
              </span>
            </div>
            {days.map((d) => {
              const ds = isoDate(d);
              const items = r.items.filter((s) => s.date === ds).sort((a, b) => a.start.localeCompare(b.start));
              return (
                <div key={ds} style={{ borderLeft: '1px solid var(--line)', padding: 4, minHeight: 60, background: ds === today ? 'var(--wk-brand-tint)' : undefined }}>
                  {items.map((s) => (
                    <ShiftBlock key={s.id} shift={s} open={!s.email} teamZone={teamZone} onOpen={() => onOpen(s)}>
                      <div style={{ fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.email ? (names[s.email] || '') : `Open${(s.openSlots || 1) > 1 ? ` ×${s.openSlots}` : ''}`}
                      </div>
                    </ShiftBlock>
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
    <div style={MODAL_BACK} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Import Schedule" style={MODAL_CARD}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>Import Schedule</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Add shifts from an Excel or CSV file. Use the columns Export writes (Date, Email or Employee, Start, End, and optionally
          Shift Type, Group, Unpaid Break (min), Label, Note, Open Spots) - exporting a week is the easiest way to get a template.
          Every shift comes in as a draft.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px dashed var(--line)', borderRadius: 10, padding: '12px 14px', cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>
          <Upload size={15} /> Choose a File
          <input type="file" aria-label="Schedule file" accept=".xlsx,.xls,.csv" onChange={(e) => pick(e.target.files?.[0])} style={{ display: 'none' }} />
          {reading && <Spinner size={14} style={{ marginLeft: 'auto' }} />}
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
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'hsl(var(--color-red))', maxHeight: 160, overflowY: 'auto' }}>
            {problems.slice(0, 50).map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="secondary-btn" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
          {!result && (
            <button type="button" className="primary-btn" onClick={go} disabled={busy || !parsed?.rows.length}
              style={{ opacity: busy || !parsed?.rows.length ? 0.55 : 1 }}>{busy ? '…' : 'Import Shifts'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Row avatar ──────────────────────────────────────────────────────────
// The person's profile photo, initials when there is none or it fails.
export function Avatar({ name, photoUrl, size = 26 }) {
  const [broken, setBroken] = useState(false);
  const base = { width: size, height: size, borderRadius: '50%', flexShrink: 0 };
  if (photoUrl && !broken) {
    return <img src={photoUrl} alt="" draggable={false} onError={() => setBroken(true)} style={{ ...base, objectFit: 'cover', border: '1px solid var(--line)' }} />;
  }
  return (
    <span style={{ ...base, background: 'var(--bg)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.38, fontWeight: 800, color: 'var(--muted)' }}>
      {(name || '').split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}
    </span>
  );
}

// ── Shift menu (right-click, long-press or Shift+F10) ───────────────────
// On a shift: Edit, Details, Color, Move To Open Shifts, Copy, Delete. On an
// empty day: Add Shift, the shift types to place in one click, Add Time Off,
// Paste. Keyboard: arrows, Enter, Escape.
export function ShiftMenu({ menu, presets = [], canTimeOff, hasCopied, onAction, onClose }) {
  const [colorsOpen, setColorsOpen] = useState(false);
  const s = menu.shift;
  return (
    <ContextMenu x={menu.x} y={menu.y} label={s ? 'Shift options' : 'Day options'} onClose={onClose}>
      {s && <MenuItem Icon={Pencil} label="Edit Shift" onClick={() => onAction('edit')} />}
      {s && <MenuItem Icon={Search} label="Details" onClick={() => onAction('details')} />}
      {!s && <MenuItem Icon={Plus} label={menu.email ? 'Add Shift' : 'Add Open Shift'} onClick={() => onAction('add')} />}
      {!s && presets.length > 0 && (
        <>
          <MenuHead>Place Shift Type</MenuHead>
          {presets.slice(0, 8).map((p) => (
            <MenuItem key={p.id} label={`${p.code || p.name} · ${shiftTimeText(p)}`} onClick={() => onAction('place', p)}
              Icon={() => <span style={{ width: 10, height: 10, borderRadius: 3, background: p.color || DEFAULT_SHIFT_COLOR, display: 'inline-block' }} />} />
          ))}
          <MenuSep />
        </>
      )}
      {canTimeOff && menu.email && <MenuItem Icon={CalendarOff} label="Add Time Off" onClick={() => onAction('timeoff')} />}
      {s && <MenuItem Icon={Palette} label="Color" hint={colorsOpen ? '▾' : '▸'} onClick={() => setColorsOpen((o) => !o)} />}
      {s && colorsOpen && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 12px 8px 35px' }}>
          <button type="button" aria-label="Shift type color" onClick={() => onAction('color', '')}
            style={{ fontSize: 11, fontWeight: 700, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', padding: '1px 6px', fontFamily: 'inherit' }}>Shift Type</button>
          {SHIFT_COLORS.map((c) => (
            <button key={c} type="button" aria-label={`Color ${c}`} onClick={() => onAction('color', c)}
              style={{ width: 18, height: 18, borderRadius: 5, background: c, cursor: 'pointer', border: s.ownColor === c ? '2px solid var(--ink)' : '2px solid transparent' }} />
          ))}
        </div>
      )}
      {s && s.email && <MenuItem Icon={CalendarRange} label="Move To Open Shifts" onClick={() => onAction('toOpen')} />}
      <MenuSep />
      {s && <MenuItem Icon={Copy} label="Copy" hint="Ctrl+C" onClick={() => onAction('copy')} />}
      {!s && <MenuItem Icon={ClipboardPaste} label="Paste" hint="Ctrl+V" disabled={!hasCopied} onClick={() => onAction('paste')} />}
      {s && <MenuItem Icon={Trash2} label="Delete" danger onClick={() => onAction('delete')} />}
    </ContextMenu>
  );
}

// ── Person menu (the ⋯ on a row) ────────────────────────────────────────
// Add Shift, Add Time Off, and the person's usual hours (their shift type).
export function PersonMenu({ menu, presets = [], usualId = '', canTimeOff, onAction, onClose }) {
  return (
    <ContextMenu x={menu.x} y={menu.y} label={`Options for ${menu.emp.name}`} onClose={onClose} width={250}>
      <MenuItem Icon={Plus} label="Add Shift" onClick={() => onAction('add')} />
      <MenuItem Icon={CalendarDays} label="Fill Usual Hours" disabled={!usualId} onClick={() => onAction('fill')} />
      {canTimeOff && <MenuItem Icon={CalendarOff} label="Add Time Off" onClick={() => onAction('timeoff')} />}
      <MenuSep />
      <MenuHead>Usual Hours</MenuHead>
      <MenuItem role="menuitemradio" checked={!usualId} label="No Usual Hours" onClick={() => onAction('usual', '')} />
      {presets.map((p) => (
        <MenuItem key={p.id} role="menuitemradio" checked={usualId === p.id} label={`${p.name} · ${shiftTimeText(p)}`} onClick={() => onAction('usual', p.id)} />
      ))}
    </ContextMenu>
  );
}

// ── Shift details (the menu's Details, and what a read-only viewer gets) ──
export function ShiftDetails({ at, shift: s, name, status, onEdit, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const left = Math.max(8, Math.min(at.x + 8, (window.innerWidth || 1000) - 300));
  const top = Math.max(8, Math.min(at.y + 8, (window.innerHeight || 800) - 320));
  const row = (label, value) => (value ? (
    <div style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
      <span style={{ width: 78, color: 'var(--muted)', flexShrink: 0 }}>{label}</span><span style={{ minWidth: 0 }}>{value}</span>
    </div>
  ) : null);
  const unpaid = unpaidMinutes(s);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1500 }} onClick={onClose}>
      <div role="dialog" aria-label="Shift Details" onClick={(e) => e.stopPropagation()}
        style={{ position: 'fixed', left, top, width: 290, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)', padding: 14, fontFamily: 'Inter,sans-serif', borderTop: `4px solid ${s.color || DEFAULT_SHIFT_COLOR}` }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 800, flex: 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={13} /> {s.code || s.label || 'Shift'}</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={15} /></button>
        </div>
        {row('Who', name)}
        {row('When', `${formatWeekday(s.date)}, ${formatDate(s.date)}`)}
        {row('Time', shiftTimeText(s))}
        {row('Unpaid', unpaid ? minutesText(unpaid) : '')}
        {row('Label', s.label)}
        {row('Note', s.note)}
        {row('Activities', (s.activities || []).map((a) => `${shiftTimeText(a)} ${a.label}${a.paid === false ? ' (unpaid)' : ''}`).join('; '))}
        {row('Zone', s.timeZone || s.timezone)}
        {row('Status', status)}
        {s.conflicts?.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'hsl(var(--color-orange))' }}>{s.conflicts.map((c) => <div key={c}>{c}</div>)}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          {onEdit && <button type="button" className="primary-btn" onClick={onEdit} style={{ fontSize: 12.5 }}><Pencil size={12} /> Edit Shift</button>}
        </div>
      </div>
    </div>
  );
}
