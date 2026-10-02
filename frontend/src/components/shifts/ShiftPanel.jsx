// The schedule's editor (Oct 2026): a RIGHT SIDE PANEL that keeps the grid in
// view, the way Teams Shifts edits - not a centered modal over it. One panel
// for a person's shift, an open shift and time off, with a Shift | Time Off
// switch at the top. Save with Ctrl+Enter.
import { useEffect, useRef, useState } from 'react';
import { X, Plus, Trash2, Copy, CalendarRange, RotateCcw, AlertTriangle, Lock, Check } from 'lucide-react';
import { api } from '../../api';
import { formatDate, formatWeekday, formatHHMM } from '../../lib/datetime';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../UnsavedChangesPrompt';
import { TIMEOFF_LABELS, timeOffLabel } from '../shiftScheduleLib';
import { Spinner } from '../AsyncState';
import { SHIFT_COLORS, DEFAULT_SHIFT_COLOR, alpha, durMin, sameTime, fmtHrs, minutesText, shiftTimeText } from './shiftLib';

const SAME_TIME_MSG = "Start and end can't be the same time.";
const LBL = { fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600 };
const INPUT = { width: '100%', fontSize: 13 };
const LINK_BTN = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0, fontFamily: 'inherit' };
const CHECK = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' };

export default function ShiftPanel({ cell, initialMode = 'shift', presets = [], quickPicks = [], groups = [], people = [], nameOf, teamZone = '', busy = false,
  canTimeOff = true, onSave, onAssign, onDelete, onDiscard, onCopy, onToOpen, onSaveTimeOff, onClose }) {
  const ex = cell.existing || null;
  const isOpen = !cell.email;
  const [mode, setMode] = useState(initialMode === 'timeoff' && !isOpen ? 'timeoff' : 'shift');
  const who = cell.email ? (nameOf ? nameOf(cell.email) : cell.email) : 'Open Shift';
  const heading = mode === 'timeoff' ? 'Add Time Off' : ex ? (isOpen ? 'Edit Open Shift' : 'Edit Shift') : (isOpen ? 'Add Open Shift' : 'Add Shift');
  const panelRef = useRef(null);
  // Focus lands in the panel, and Ctrl+Enter saves from anywhere in it.
  useEffect(() => { panelRef.current?.querySelector('input, select, button[data-primary]')?.focus?.(); }, [mode]);

  return (
    <aside ref={panelRef} role="dialog" aria-label={heading} aria-modal="false" className="m-panel"
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(460px, 100vw)', background: 'var(--card)', borderLeft: '1px solid var(--line)',
        boxShadow: '-12px 0 36px rgba(0,0,0,0.14)', zIndex: 1400, display: 'flex', flexDirection: 'column', fontFamily: 'Inter,sans-serif' }}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 800, flex: 1 }}>{heading}</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex' }}><X size={18} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
          {formatWeekday(cell.date)}, {formatDate(cell.date)}{cell.email ? ` · ${who}` : ''}
        </div>
        {cell.email && canTimeOff && !ex && (
          <div role="tablist" aria-label="What to add" style={{ display: 'inline-flex', marginTop: 10, border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            {[['shift', 'Shift'], ['timeoff', 'Time Off']].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)}
                style={{ border: 'none', padding: '5px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                  background: mode === k ? 'var(--wk-brand-tint)' : 'transparent', color: mode === k ? 'var(--wk-brand)' : 'var(--muted)' }}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {mode === 'timeoff' ? (
        <TimeOffForm email={cell.email} name={who} date={cell.date} busy={busy} onSave={onSaveTimeOff} onClose={onClose} />
      ) : (
        <ShiftForm cell={cell} ex={ex} isOpen={isOpen} presets={presets} quickPicks={quickPicks} groups={groups} people={people} nameOf={nameOf} teamZone={teamZone} busy={busy}
          onSave={onSave} onAssign={onAssign} onDelete={onDelete} onDiscard={onDiscard} onCopy={onCopy} onToOpen={onToOpen} onClose={onClose}
          onTimeOff={cell.email && canTimeOff ? () => setMode('timeoff') : undefined} />
      )}
    </aside>
  );
}

// Shift type chips: the presets, then Custom.
function TypeChips({ presets, value, onPick, quickPicks = [], pickedQuick = '', onQuick }) {
  const chip = (on, color, label, onClick, key) => (
    <button key={key} type="button" aria-pressed={on} onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
        border: `1.5px solid ${on ? color : 'var(--line)'}`, background: on ? alpha(color, 0.14) : 'var(--card)', color: 'var(--ink)' }}>
      <span style={{ width: 9, height: 9, borderRadius: 3, background: color, flexShrink: 0 }} /> {label}
    </button>
  );
  return (
    <div>
      <div style={LBL}>Shift Type</div>
      <div role="group" aria-label="Shift type" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {presets.map((p) => chip(value === p.id, p.color || DEFAULT_SHIFT_COLOR, `${p.name || p.code}${p.start ? ` ${formatHHMM(p.start)} - ${formatHHMM(p.end)}` : ''}`, () => onPick(p.id), p.id))}
        {quickPicks.map((q) => chip(!value && pickedQuick === q.key, q.color || DEFAULT_SHIFT_COLOR, `${q.label} ${formatHHMM(q.start)} - ${formatHHMM(q.end)}`, () => onQuick(q), `q|${q.key}`))}
        {chip(!value && !pickedQuick, DEFAULT_SHIFT_COLOR, 'Custom', () => onPick(''), '__custom')}
      </div>
    </div>
  );
}

function ColorPick({ value, presetColor, onChange }) {
  return (
    <div>
      <div style={LBL}>Color</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => onChange('')} aria-pressed={!value}
          style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
            border: !value ? '2px solid var(--ink)' : '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: presetColor || DEFAULT_SHIFT_COLOR }} /> Shift Type
        </button>
        {SHIFT_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => onChange(c)} aria-label={`Color ${c}`} aria-pressed={value === c} title={`Color ${c}`}
            style={{ width: 22, height: 22, borderRadius: 6, cursor: 'pointer', background: c, border: value === c ? '2px solid var(--ink)' : '2px solid transparent', boxShadow: '0 0 0 1px var(--line)' }} />
        ))}
      </div>
    </div>
  );
}

function ShiftForm({ cell, ex, isOpen, presets, quickPicks = [], groups, people, nameOf, teamZone, busy, onSave, onAssign, onDelete, onDiscard, onCopy, onToOpen, onClose, onTimeOff }) {
  const firstGroupOf = (email) => groups.find((g) => (g.members || []).includes(email))?.id || '';
  const [shiftId, setShiftId] = useState(ex ? (ex.shiftId || '') : (presets[0]?.id || ''));
  const [start, setStart] = useState(ex?.start || '');
  const [end, setEnd] = useState(ex?.end || '');
  const [groupId, setGroupId] = useState(ex?.groupId ?? (cell.groupId || (isOpen ? (groups[0]?.id || '') : firstGroupOf(cell.email))));
  const [label, setLabel] = useState(ex?.label || '');
  const [note, setNote] = useState(ex?.note || '');
  const [color, setColor] = useState(ex?.ownColor || '');
  const [slots, setSlots] = useState(ex?.openSlots || 1);
  const [brk, setBrk] = useState(ex ? String(ex.breakMin ?? 0) : '');   // '' = the shift type's
  const [acts, setActs] = useState(() => (ex?.activities || []).map((a) => ({ ...a, paid: a.paid !== false })));
  const [assignee, setAssignee] = useState('');
  const [warnings, setWarnings] = useState(ex?.conflicts || []);
  const preset = presets.find((p) => p.id === shiftId);
  const effStart = start || preset?.start || '';
  const effEnd = end || preset?.end || '';
  const badTimes = sameTime(effStart, effEnd);
  const unpaidActs = acts.filter((a) => !a.paid && a.start && a.end);
  const unpaidFromActs = unpaidActs.reduce((n, a) => n + durMin(a.start, a.end), 0);
  const effBreak = unpaidActs.length ? unpaidFromActs : (brk === '' ? (preset?.breakMin || 0) : Math.max(0, Number(brk) || 0));
  const paid = Math.max(0, (effStart && effEnd ? durMin(effStart, effEnd) : 0) - effBreak);
  const zone = ex?.timeZone || preset?.timezone || teamZone;

  // Custom keeps the times on screen (it used to blank them when the shift
  // already had its own times); a shift type takes its own times.
  const quickKey = (q) => q.key;
  const [pickedQuick, setPickedQuick] = useState(() => {
    if (!ex || ex.shiftId || !ex.label) return '';
    return quickPicks.find((q) => q.label === ex.label && q.start === ex.start && q.end === ex.end)?.key || '';
  });
  const pickType = (id) => { setPickedQuick(''); if (id) { setShiftId(id); setStart(''); setEnd(''); setBrk(''); } else { setShiftId(''); setStart(effStart); setEnd(effEnd); } };
  // A saved custom shift (e.g. "All Properties", from Teams): no shift type,
  // its times, label and color.
  const pickQuick = (q) => { setShiftId(''); setStart(q.start); setEnd(q.end); setLabel(q.label); setColor(q.color || ''); setBrk(''); setPickedQuick(quickKey(q)); };

  // Live warnings as the day and times change (overlap, time off, holiday) -
  // the same check the grid's warning icon comes from. Never blocks Save.
  useEffect(() => {
    if (!cell.email || !effStart || !effEnd) return undefined;
    let live = true;
    const t = setTimeout(() => {
      api.timeSchedCheck({ email: cell.email, date: cell.date, start: effStart, end: effEnd, exclude_id: ex?.id || '' })
        .then((r) => { if (live) setWarnings(r?.warnings || []); })
        .catch(() => { if (live) setWarnings([]); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [cell.email, cell.date, effStart, effEnd, ex?.id]);

  const payload = () => ({
    id: ex?.id, employee_email: cell.email || '', work_date: cell.date, shift_id: shiftId,
    start_hhmm: effStart, end_hhmm: effEnd, label, note, break_min: effBreak, color, group_id: groupId,
    activities: acts.filter((a) => a.start && a.end).map((a) => ({ start: a.start, end: a.end, label: (a.label || '').trim(), paid: a.paid !== false })),
    ...(isOpen ? { open_slots: Math.max(1, Number(slots) || 1) } : {}),
  });
  function submit() {
    if (badTimes || !effStart || !effEnd || busy) return;
    if (isOpen && !groupId && groups.length) return;
    onSave(payload());
  }
  // The first render's values ARE the baseline (a fresh panel mounts per cell).
  const current = JSON.stringify({ shiftId, start, end, groupId, label, note, color, slots: String(slots), brk, acts });
  const [baseline] = useState(current);
  const dirty = current !== baseline;
  const guard = useUnsavedGuard(dirty, onClose, submit);
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } };
  const setAct = (i, patch) => setActs((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const groupName = (id) => groups.find((g) => g.id === id)?.name || '';
  const noPresets = presets.length === 0;

  return (
    <>
      <div onKeyDown={onKey} style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'grid', gap: 14, alignContent: 'start' }}>
        {noPresets && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No shift types yet. Add them under Settings &gt; Global Settings &gt; Shifts, or set the times here.</div>}
        {(!noPresets || quickPicks.length > 0) && <TypeChips presets={presets} value={shiftId} onPick={pickType} quickPicks={quickPicks} pickedQuick={pickedQuick} onQuick={pickQuick} />}
        <div style={{ display: 'flex', gap: 10 }}>
          <label style={{ flex: 1 }}><div style={LBL}>Start</div><input type="time" className="form-input" aria-label="Start" value={effStart} onChange={(e) => setStart(e.target.value)} style={INPUT} /></label>
          <label style={{ flex: 1 }}><div style={LBL}>End</div><input type="time" className="form-input" aria-label="End" value={effEnd} onChange={(e) => setEnd(e.target.value)} style={INPUT} /></label>
          {isOpen && <label style={{ width: 86 }}><div style={LBL}>People</div><input type="number" min={1} max={50} className="form-input" aria-label="People needed" value={slots} onChange={(e) => setSlots(e.target.value)} style={INPUT} /></label>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span><b style={{ color: 'var(--ink)' }}>{fmtHrs(paid)}</b> paid{effBreak ? ` · ${minutesText(effBreak)} unpaid` : ''}</span>
          {zone && <span>· Times in {zone}</span>}
        </div>
        {badTimes && <div role="alert" style={{ fontSize: 12, color: 'hsl(var(--color-red))' }}>{SAME_TIME_MSG}</div>}
        {(groups.length > 0) && (
          <label><div style={LBL}>Group{isOpen ? '' : ' (optional)'}</div>
            <select className="form-input" aria-label="Group" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={INPUT}>
              {!isOpen && <option value="">No group</option>}
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
        <ColorPick value={color} presetColor={preset?.color} onChange={setColor} />
        <label><div style={LBL}>Label</div><input className="form-input" aria-label="Label" placeholder="e.g. Front Desk" value={label} onChange={(e) => setLabel(e.target.value)} style={INPUT} /></label>
        {!isOpen && <label><div style={LBL}>Note</div><input className="form-input" aria-label="Note" placeholder="Anything they should know" value={note} onChange={(e) => setNote(e.target.value)} style={INPUT} /></label>}

        {/* Activities (Teams parity): named blocks inside the shift, each paid
            or unpaid. The unpaid ones set the break and come off the hours. */}
        <div>
          <div style={{ ...LBL, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>Activities</span>
            {unpaidActs.length > 0 && <span>Unpaid {minutesText(unpaidFromActs)}</span>}
          </div>
          {acts.map((a, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8 }}>
              <input className="form-input" aria-label={`Activity ${i + 1} name`} placeholder="e.g. Lunch" maxLength={40} value={a.label || ''}
                onChange={(e) => setAct(i, { label: e.target.value })} style={{ fontSize: 13, gridColumn: '1 / -1' }} />
              <input type="time" className="form-input" aria-label={`Activity ${i + 1} start`} value={a.start || ''} onChange={(e) => setAct(i, { start: e.target.value })} style={{ fontSize: 13 }} />
              <input type="time" className="form-input" aria-label={`Activity ${i + 1} end`} value={a.end || ''} onChange={(e) => setAct(i, { end: e.target.value })} style={{ fontSize: 13 }} />
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div role="group" aria-label={`Activity ${i + 1} pay`} style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 7, overflow: 'hidden' }}>
                  {[[true, 'Paid'], [false, 'Unpaid']].map(([v, text]) => (
                    <button key={text} type="button" aria-pressed={a.paid === v} onClick={() => setAct(i, { paid: v })}
                      style={{ border: 'none', padding: '3px 10px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                        background: a.paid === v ? 'var(--wk-brand-tint)' : 'transparent', color: a.paid === v ? 'var(--wk-brand)' : 'var(--muted)' }}>{text}</button>
                  ))}
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', flex: 1 }}>{a.start && a.end ? minutesText(durMin(a.start, a.end)) : ''}</span>
                <button type="button" onClick={() => setActs((xs) => xs.filter((_, j) => j !== i))} aria-label={`Remove activity ${i + 1}`}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}><X size={14} /></button>
              </div>
            </div>
          ))}
          {acts.length < 12 && (
            <button type="button" onClick={() => setActs((xs) => [...xs, { start: effStart ? addMinutes(effStart, 180) : '12:00', end: effStart ? addMinutes(effStart, 210) : '12:30', label: '', paid: false }])}
              style={{ ...LINK_BTN, color: 'var(--wk-brand)' }}><Plus size={13} /> Add Activity</button>
          )}
          {!unpaidActs.length && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12, color: 'var(--muted)' }} title="Unpaid minutes inside the shift when there is no unpaid activity, e.g. a 30-minute lunch.">
              Unpaid break (min)
              <input type="number" min={0} max={480} step={5} className="form-input" aria-label="Unpaid break minutes" value={brk === '' ? String(preset?.breakMin || 0) : brk}
                onChange={(e) => setBrk(e.target.value)} style={{ width: 90, fontSize: 13 }} />
            </label>
          )}
        </div>

        {warnings.length > 0 && (
          <div role="alert" style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'hsla(var(--color-orange),0.1)', border: '1px solid hsla(var(--color-orange),0.4)', color: 'var(--ink)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, marginBottom: 2 }}><AlertTriangle size={13} /> Check before saving</div>
            {warnings.map((w) => <div key={w}>{w}</div>)}
            <div style={{ marginTop: 4, color: 'var(--muted)' }}>You can still save this shift.</div>
          </div>
        )}
        {(ex?.pendingDelete || ex?.hasChanges) && (
          <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12, background: 'hsla(var(--color-orange),0.1)', border: '1px solid hsla(var(--color-orange),0.4)', color: 'var(--ink)' }}>
            {ex.pendingDelete ? 'This shift will be removed when you share. Until then the team still sees it.' : 'Unshared changes. The team sees the previous version of this shift until you share.'}
          </div>
        )}
        {isOpen && ex && people.length > 0 && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <div style={LBL}>Assign To A Person</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="form-input" aria-label="Assign to" value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ flex: 1, fontSize: 13 }}>
                <option value="">Pick someone</option>
                {people.map((p) => <option key={p.email} value={p.email}>{nameOf ? nameOf(p.email, p.name) : (p.name || p.email)}</option>)}
              </select>
              <button type="button" className="secondary-btn" onClick={() => assignee && onAssign(ex.id, assignee)} disabled={!assignee || busy}>Assign</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>Gives this shift to the person{groupId ? ` in ${groupName(groupId)}` : ''} and drops the open count by one.</div>
          </div>
        )}
      </div>
      <div style={{ padding: '10px 18px', borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {ex && onCopy && !ex.pendingDelete && <button type="button" onClick={() => onCopy(ex)} disabled={busy} title="Copy this shift to place on another person or day" style={{ ...LINK_BTN, color: 'var(--muted)' }}><Copy size={13} /> Copy</button>}
        {ex && ex.email && onToOpen && !ex.pendingDelete && <button type="button" onClick={() => onToOpen(ex)} disabled={busy} style={{ ...LINK_BTN, color: 'var(--muted)' }}><CalendarRange size={13} /> Move To Open Shifts</button>}
        {ex && !ex.pendingDelete && <button type="button" onClick={() => onDelete(ex.id)} disabled={busy} style={{ ...LINK_BTN, color: 'hsl(var(--color-red))' }}><Trash2 size={13} /> Delete</button>}
        {onDiscard && (ex?.pendingDelete || ex?.hasChanges) && <button type="button" onClick={() => onDiscard(ex.id)} disabled={busy} title="Go back to the version the team sees" style={{ ...LINK_BTN, color: 'var(--muted)' }}><RotateCcw size={13} /> Discard Changes</button>}
        {!ex && onTimeOff && <button type="button" onClick={onTimeOff} style={{ ...LINK_BTN, color: 'var(--muted)' }}>Time Off Instead</button>}
        <div style={{ flex: 1 }} />
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" data-primary className="primary-btn" onClick={submit} disabled={busy || badTimes || !effStart || !effEnd}
          title={badTimes ? SAME_TIME_MSG : 'Ctrl+Enter'} style={{ opacity: badTimes ? 0.55 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Spinner size={13} /> : <Check size={14} />} Save
        </button>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={onClose} onSave={guard.saveAndClose} saving={guard.saving || busy} />
      )}
    </>
  );
}

function addMinutes(hhmm, n) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = ((h * 60 + m + n) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// Time off on a person's behalf (the same /timeoff/on-behalf the Time Off
// screen uses, so they are told), approved right away unless unticked.
function TimeOffForm({ email, name, date, busy, onSave, onClose }) {
  const [types, setTypes] = useState(null);
  useEffect(() => {
    let live = true;
    api.timeOffTypes().then((r) => { if (live) setTypes(r); })
      .catch(() => { if (live) setTypes({ builtIn: Object.keys(TIMEOFF_LABELS), custom: [] }); });
    return () => { live = false; };
  }, []);
  const [f, setF] = useState({ type: 'vacation', start: date, end: date, allDay: true, startTime: '09:00', endTime: '13:00', note: '', approve: true, confidential: false });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const partial = !f.allDay;
  const problem = !f.start || !f.end ? 'Pick the days.'
    : f.end < f.start ? 'The last day is before the first.'
      : partial && f.start !== f.end ? 'Part of a day must start and end on the same day.'
        : partial && f.endTime <= f.startTime ? 'The end time has to be after the start time.' : '';
  function submit() {
    if (problem || busy) return;
    onSave({ employee_email: email, type: f.type, start_date: f.start, end_date: f.end,
      start_time: partial ? f.startTime : '', end_time: partial ? f.endTime : '', note: f.note.trim(), confidential: f.confidential }, f.approve);
  }
  const opts = types ? [...(types.builtIn || []).map((t) => [t, timeOffLabel(t)]), ...(types.custom || []).map((t) => [t, t])] : [];
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } };
  return (
    <>
      <div onKeyDown={onKey} style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'grid', gap: 12, alignContent: 'start' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>For {name}. They get a notification.</div>
        <label><div style={LBL}>Type</div>
          <select className="form-input" aria-label="Time-off type" value={f.type} onChange={(e) => set('type', e.target.value)} style={INPUT}>
            {opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 10 }}>
          <label style={{ flex: 1 }}><div style={LBL}>First Day</div>
            <input type="date" className="form-input" aria-label="First day" value={f.start} onChange={(e) => setF((p) => ({ ...p, start: e.target.value, end: p.allDay ? p.end : e.target.value }))} style={INPUT} /></label>
          <label style={{ flex: 1 }}><div style={LBL}>Last Day</div>
            <input type="date" className="form-input" aria-label="Last day" value={f.end} disabled={partial} onChange={(e) => set('end', e.target.value)} style={INPUT} /></label>
        </div>
        <label style={CHECK}><input type="checkbox" checked={f.allDay} onChange={(e) => setF((p) => ({ ...p, allDay: e.target.checked, end: e.target.checked ? p.end : p.start }))} /> All day</label>
        {partial && (
          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ flex: 1 }}><div style={LBL}>From</div><input type="time" className="form-input" aria-label="From" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} style={INPUT} /></label>
            <label style={{ flex: 1 }}><div style={LBL}>To</div><input type="time" className="form-input" aria-label="To" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} style={INPUT} /></label>
          </div>
        )}
        <label><div style={LBL}>Reason</div>
          <input className="form-input" placeholder="Why they are off" aria-label="Reason" value={f.note} maxLength={400} onChange={(e) => set('note', e.target.value)} style={INPUT} /></label>
        <label style={{ ...CHECK, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={f.confidential} onChange={(e) => set('confidential', e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={12} /> Keep this confidential</span>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Only they and their approver see the type and reason. Everyone else sees plain time off.</div>
          </span>
        </label>
        <label style={CHECK}><input type="checkbox" checked={f.approve} onChange={(e) => set('approve', e.target.checked)} /> Approve it now</label>
        {problem && <div style={{ fontSize: 11.5, color: 'hsl(var(--color-red))' }}>{problem}</div>}
      </div>
      <div style={{ padding: '10px 18px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" data-primary className="primary-btn" onClick={submit} disabled={busy || !!problem || !types} style={{ opacity: busy || problem ? 0.55 : 1 }}>{busy ? <Spinner size={13} /> : 'Add Time Off'}</button>
      </div>
    </>
  );
}

export { shiftTimeText };
