// The one shift block (calm pass, Neil, Oct 30 2026). On the card's own
// background with a hairline border - no tint, no bar, no badge:
//   line 1  a dot in the shift type's color, the time ("8:30a - 5:30p",
//           "+1" when it ends the next day), the type's NAME at the right
//           in the type's color - never its code (Neil's Oct 28 walk-through,
//           c2db7392; reaffirmed Oct 30 2026).
//   line 2  only when something needs saying, in words: "New", "Edited
//           · was 8:00a - 4:30p" or "Removed" while a change is not shared
//           (the block is dashed until then); an attendance EXCEPTION
//           ("Late 14m", "Left Early 1h", "No-Show", "On Now" - never "On
//           Time"); the rule flags ("Overtime", "Outside Availability");
//           the shift's own label only when it differs from the type name.
// Everything else - the lunch, the note, the activities, the zone, every
// conflict sentence, what the clock said - is the hover title and the
// accessible name, and the panel. The time never truncates: the font
// shrinks with the block (container units) before anything is cut.
// Time off is ITS OWN soft rose block beside the shift, never in its place.
// An open shift says "N open" on its second line. On a touch screen - or
// always, with `tapActual` (My Shifts) - a tap on the attendance word opens
// a small sheet with the hover lines, since a phone has no hover.
import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { formatDate } from '../../lib/datetime';
import { timeOffLabel } from '../shiftScheduleLib';
import { DEFAULT_SHIFT_COLOR, OPEN_SHIFT_COLOR, shiftState, shiftTimeText, shiftShortText, shortTimeText, unpaidLabel, timeOffWhen, timeOffShort, isApprovedOff, isAllDayOff, zoneDiffers, actualLabel, actualColor, actualWord, actualException, flagOf, nextDay } from './shiftLib';
import { zoneOptionLabel, tzAbbrev } from '../../lib/worldClockZones';

// The time shrinks from 12px toward 9px as the block narrows (a share of
// the block's width in container units - set on the LINE, never on the
// block itself, since an element cannot measure against its own container),
// so a 7-column week at 1440px reads whole and a two-week view still shows
// every digit. A block that also carries a ×N, a zone or a warning shrinks
// a little more; the time itself never shrinks past 8.5px and never cuts.
const fit = (share, max = 12) => `clamp(8.5px, ${share}cqi, ${max}px)`;
const LINE = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };

const coarsePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches;

// `onSelect` (the week grid, Oct 28 2026 - Excel-style): a click selects the
// block and draws a box round it; a double-click or Enter opens it.
export function ShiftBlock({ shift: s, open = false, compact = false, teamZone = '', onOpen, onSelect = null, selected = false, onContextMenu, dragProps = {},
  tabIndex, showConflicts = true, dragging = false, className = '', actual = null, tapActual = null, children, style, ...rest }) {
  const color = s.color || (open ? OPEN_SHIFT_COLOR : DEFAULT_SHIFT_COLOR);
  const act = actual && actual.status && actual.status !== 'upcoming' ? actual : null;
  const actText = act ? actualLabel(act) : '';
  const exc = act ? actualException(act) : null;
  const tappable = !!exc && (tapActual ?? coarsePointer());
  const [sheet, setSheet] = useState(null);   // { x, y } while the actual sheet is open
  const showSheet = (e) => { e.stopPropagation(); e.preventDefault(); setSheet({ x: e.clientX, y: e.clientY }); };
  const st = shiftState(s);
  const zone = s.timeZone || s.timezone || '';
  const otherZone = zoneDiffers(zone, teamZone);
  const unpaid = unpaidLabel(s);
  // The label (hover and accessible name): the shift's own, else its shift
  // type's name. Codes stay off the grid (Neil, Oct 28 / Oct 30 2026).
  const ownLabel = s.label || '';
  const typeName = s.shiftName || '';
  const label = ownLabel || typeName;
  // On the block only a label that says something the type does not.
  const shownLabel = ownLabel && ownLabel !== typeName ? ownLabel : '';
  const state = s.pendingDelete ? 'removed' : s.hasChanges ? 'edited' : s.published === false ? 'new' : '';
  const was = state === 'edited' && s.was?.start && s.was?.end && (s.was.start !== s.start || s.was.end !== s.end) ? shortTimeText(s.was.start, s.was.end) : '';
  const stateWord = state === 'removed' ? 'Removed' : state === 'edited' ? `Edited${was ? ` · was ${was}` : ''}` : state === 'new' ? 'New' : '';
  // Weather Call (Oct 2026): a cancelled day stays on the grid, struck
  // through and unpaid; a delayed, shortened or moved shift says so on hover.
  const weather = s.weatherStatus === 'cancelled' ? 'Cancelled for weather (unpaid)' : s.weatherStatus === 'delayed' ? 'Start delayed for weather'
    : s.weatherStatus === 'shortened' ? 'Ending early for weather' : s.weatherStatus === 'moved' ? 'Moved for weather' : s.weatherStatus === 'kept' ? 'Weather call: going ahead' : '';
  const cancelled = s.weatherStatus === 'cancelled';
  const title = [`${shiftTimeText(s)}${label ? ` · ${label}` : ''}`, actText, weather, st.title, was ? `Team sees ${shiftTimeText(s.was)}` : '', unpaid, s.note,
    ...(s.activities || []).map((a) => `${a.start && a.end ? `${shiftTimeText(a)} ` : ''}${a.label || 'Activity'}${a.paid === false ? ' (unpaid)' : ''}`),
    otherZone ? `Times in ${zoneOptionLabel(zone)}` : '', ...(s.conflicts || [])].filter(Boolean).join('\n');
  const interactive = !!onOpen;
  const slots = open ? Math.max(1, Number(s.openSlots) || 1) : 0;
  const warn = showConflicts && s.conflicts?.length > 0;
  // One word per kind of flag, at most two on the block ("+1" says more).
  const flags = [];
  if (warn) for (const c of s.conflicts) { const f = flagOf(c); if (!flags.some((x) => x.kind === f.kind)) flags.push(f); }
  const share = (compact ? 11 : 9.5) - (otherZone ? 1.3 : 0) - (typeName ? 0.8 : 0);
  const overnight = nextDay(s);
  const sep = <span aria-hidden="true" style={{ color: 'var(--muted)' }}> · </span>;
  const parts = [];
  if (stateWord) parts.push(<span key="st" data-state={state} style={{ fontWeight: 700, color: 'var(--ink)' }}>{stateWord}</span>);
  if (slots && !compact) parts.push(<span key="open" data-open-slots={slots} style={{ fontWeight: 700, color: 'hsl(var(--color-green))' }}>{slots} open</span>);
  if (exc) parts.push(
    <span key="act" data-actual={act.status} onClick={tappable ? showSheet : undefined} aria-hidden="true"
      style={{ fontWeight: 700, color: exc.color, cursor: tappable ? 'pointer' : undefined, ...(tappable ? { padding: '4px 0', margin: '-4px 0' } : {}) }}>{exc.word}</span>);
  if (cancelled) parts.push(<span key="wx" style={{ fontWeight: 700, color: 'hsl(var(--color-orange))' }}>Weather - unpaid</span>);
  flags.slice(0, compact ? 1 : 2).forEach((f, i) => parts.push(<span key={`f${i}`} data-flag={f.kind} style={{ fontWeight: 600, color: 'hsl(var(--color-orange))' }}>{f.word}</span>));
  if (flags.length > (compact ? 1 : 2)) parts.push(<span key="more" style={{ color: 'var(--muted)' }}>+{flags.length - (compact ? 1 : 2)}</span>);
  if (shownLabel && !compact) parts.push(<span key="lb" style={{ color: 'var(--muted)', textDecoration: cancelled ? 'line-through' : undefined }}>{shownLabel}</span>);
  const unshared = !!state;
  return (
    <div data-shift={s.id} data-conflict={warn ? '' : undefined} data-unshared={state || undefined} data-weather-status={s.weatherStatus || undefined} role={interactive ? 'button' : undefined} tabIndex={interactive ? (tabIndex ?? 0) : undefined}
      aria-label={interactive ? `${open ? 'Open shift' : 'Shift'} ${shiftTimeText(s)}${label ? ` ${label}` : ''}${st.tag ? `, ${st.tag}` : ''}${act ? `, ${actualWord(act.status)}` : ''}${weather ? `, ${weather.toLowerCase()}` : ''}${warn ? `, ${s.conflicts.length === 1 ? '1 warning' : `${s.conflicts.length} warnings`}: ${s.conflicts.join('; ')}` : ''}` : undefined}
      title={title} className={`sched-chip${className ? ` ${className}` : ''}`}
      onClick={interactive ? (e) => { e.stopPropagation(); (onSelect || onOpen)(e, s); } : undefined}
      onDoubleClick={interactive && onSelect ? (e) => { e.stopPropagation(); onOpen(e, s); } : undefined}
      data-selected={selected ? '' : undefined} aria-pressed={onSelect ? selected : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpen(e, s); } } : undefined}
      onContextMenu={onContextMenu}
      {...dragProps} {...rest}
      style={{ position: 'relative', containerType: 'inline-size', background: 'var(--card)', borderRadius: 6,
        border: `1px ${unshared ? 'dashed' : 'solid'} ${unshared ? 'var(--muted)' : 'var(--line)'}`,
        padding: compact ? '2px 4px' : '4px 7px', marginBottom: 3, minWidth: 0, overflow: 'hidden',
        cursor: interactive ? 'pointer' : 'default', userSelect: 'none', color: 'var(--ink)', fontFamily: 'inherit', textAlign: 'left',
        opacity: dragging ? 0.4 : s.pendingDelete || cancelled ? 0.6 : 1,
        ...(selected ? { outline: '2px solid var(--wk-brand)', outlineOffset: 1 } : {}), ...style }}>
      <div data-shift-time="" style={{ ...LINE, display: 'flex', alignItems: 'center', gap: 5, fontSize: fit(share, compact ? 11 : 12), fontWeight: 700, lineHeight: 1.35 }}>
        <span aria-hidden="true" data-type-dot="" style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ whiteSpace: 'nowrap', flexShrink: 0, textDecoration: s.pendingDelete || cancelled ? 'line-through' : undefined }}>{shiftShortText(s)}{overnight && <span style={{ fontSize: '0.8em', color: 'var(--muted)', fontWeight: 600 }}> +1</span>}</span>
        {otherZone && <span title={`Times in ${zoneOptionLabel(zone)}`} style={{ fontSize: '0.8em', fontWeight: 600, color: 'var(--muted)', flexShrink: 0 }}>{tzAbbrev(zone)}</span>}
        {typeName && <span data-type-name="" style={{ marginLeft: 'auto', fontSize: '0.82em', fontWeight: 600, color, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{typeName}</span>}
      </div>
      {parts.length > 0 && (
        <div data-shift-words="" style={{ ...LINE, fontSize: compact ? 10 : 10.5, lineHeight: 1.35, marginTop: 1 }}>
          {parts.map((p, i) => <span key={i}>{i > 0 && sep}{p}</span>)}
        </div>
      )}
      {sheet && act && <ActualSheet at={sheet} shift={s} actual={act} text={actText} onClose={() => setSheet(null)} />}
      {children}
    </div>
  );
}

// The actual, readable without a hover (a phone): a small fixed card by
// the tap with the status word and the hover lines, closed by a tap
// anywhere else or Escape.
export function ActualSheet({ at, shift: s, actual: a, text, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown); };
  }, [onClose]);
  const w = 240;
  const left = Math.max(8, Math.min(at.x - w / 2, (window.innerWidth || 1000) - w - 8));
  const top = Math.max(8, Math.min(at.y + 12, (window.innerHeight || 800) - 160));
  const lines = String(text || '').split('\n').filter(Boolean);
  return (
    <div role="dialog" aria-label={`${actualWord(a.status)} - ${shiftTimeText(s)}`} data-actual-sheet={a.status} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left, top, width: w, zIndex: 1500, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '10px 12px', fontFamily: 'inherit', textAlign: 'left', cursor: 'default', whiteSpace: 'normal' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: actualColor(a.status, s.color || DEFAULT_SHIFT_COLOR), flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--ink)' }}>{actualWord(a.status)}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>{shiftTimeText(s)}</span>
      </div>
      {lines.map((ln, i) => <div key={i} style={{ fontSize: 12, color: 'var(--ink)', lineHeight: 1.4 }}>{ln}</div>)}
      <button type="button" onClick={onClose} style={{ marginTop: 8, fontSize: 11.5, fontWeight: 700, color: 'var(--wk-brand)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>Close</button>
    </div>
  );
}

// Time off beside a shift (a partial day; whole days are the grid's
// spanning pill): a soft rose block, one line -
// "Vacation" or "2:00p - 4:00p Medical". The reason, the dates and whether
// it is still only requested (dashed) are the hover title. Confidential
// time off reads plain "Time Off" with a lock.
export function TimeOffBlock({ off: t, compact = false, showReason = true, style }) {
  const approved = isApprovedOff(t);
  const type = t.confidential ? 'Time Off' : (t.type ? timeOffLabel(t.type) : 'Time Off');
  const when = timeOffWhen(t);
  const range = t.startDate && t.endDate && t.startDate !== t.endDate ? `${formatDate(t.startDate)} - ${formatDate(t.endDate)}` : '';
  const title = [type, approved ? 'Approved' : 'Requested', range || when, showReason && !t.confidential ? t.note : ''].filter(Boolean).join('\n');
  const short = timeOffShort(t);
  // The hours never cut; a long custom type ("Medical Appointment") may.
  return (
    <div data-timeoff={t.id || undefined} title={title} aria-label={`${approved ? '' : 'Requested '}${type}, ${range || when}`}
      style={{ containerType: compact ? undefined : 'inline-size', border: `1px ${approved ? 'solid' : 'dashed'} hsla(var(--color-red),0.32)`, borderRadius: 6, background: 'hsla(var(--color-red),0.08)',
        padding: compact ? '2px 4px' : '3px 7px', marginBottom: 3, minWidth: 0, overflow: 'hidden', color: 'hsl(var(--color-red))', ...style }}>
      <div style={{ ...LINE, display: 'flex', alignItems: 'center', gap: 4, fontSize: compact ? 10.5 : fit(short ? 8.5 : 9.5, 11.5), fontWeight: 700, lineHeight: 1.3 }}>
        {compact ? <span style={LINE}>{isAllDayOff(t) ? 'Off' : short}</span> : (
          <>
            {short && <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{short} </span>}
            <span style={{ ...LINE, flexShrink: 1 }}>{type}</span>
          </>
        )}
        {t.confidential && <Lock size={10} aria-label="Confidential" style={{ flexShrink: 0 }} />}
      </div>
    </div>
  );
}

export function HolidayBlock({ holiday: h, compact = false, style }) {
  const name = h?.name || h?.title || 'Holiday';
  return (
    <div title={`${h?.type === 'half_day' ? 'Half-day holiday' : 'Holiday'} · ${name}`}
      style={{ border: '1px solid hsla(var(--color-blue),0.5)', borderRadius: 6, padding: compact ? '2px 4px' : '3px 7px', marginBottom: 3, minWidth: 0,
        color: 'hsl(var(--color-blue))', fontSize: compact ? 10 : 11, fontWeight: 700, lineHeight: 1.3, ...LINE, ...style }}>
      {compact ? 'Hol' : name}
    </div>
  );
}
