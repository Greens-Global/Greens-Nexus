// The one shift block (Oct 2026): a 4px color bar, the time in bold, the
// label, then "Lunch 30m" from the unpaid activities. The manager grid, My
// Shifts and the team grid all draw this, so a shift looks the same wherever
// it is seen. A draft is dashed with a "Draft" dot; an unshared edit gets a
// striped corner; a removal is struck through. Time off is ITS OWN block
// beside the shift, never in its place (a 2-4 PM appointment used to wipe a
// 9-5 off two of the three grids).
import { AlertTriangle, CalendarOff, Lock, PartyPopper } from 'lucide-react';
import { formatDate } from '../../lib/datetime';
import { timeOffLabel } from '../shiftScheduleLib';
import { alpha, DEFAULT_SHIFT_COLOR, OPEN_SHIFT_COLOR, shiftState, shiftTimeText, unpaidLabel, timeOffWhen, isApprovedOff, isAllDayOff } from './shiftLib';
import { zoneOptionLabel, tzAbbrev } from '../../lib/worldClockZones';

const STRIPES = 'repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 5px)';

export function ShiftBlock({ shift: s, open = false, compact = false, teamZone = '', onOpen, onContextMenu, dragProps = {}, tools = null,
  tabIndex, showConflicts = true, dragging = false, children, style, ...rest }) {
  const color = s.color || (open ? OPEN_SHIFT_COLOR : DEFAULT_SHIFT_COLOR);
  const st = shiftState(s);
  const zone = s.timeZone || s.timezone || '';
  const otherZone = !!zone && !!teamZone && zone !== teamZone;
  const unpaid = unpaidLabel(s);
  const label = [s.code, s.label].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ');
  const draft = s.published === false && !s.hasChanges && !s.pendingDelete;
  const title = [`${shiftTimeText(s)}${label ? ` · ${label}` : ''}`, st.title, unpaid, s.note,
    ...(s.activities || []).map((a) => `${a.start && a.end ? `${shiftTimeText(a)} ` : ''}${a.label || 'Activity'}${a.paid === false ? ' (unpaid)' : ''}`),
    otherZone ? `Times in ${zoneOptionLabel(zone)}` : '', ...(s.conflicts || [])].filter(Boolean).join('\n');
  const interactive = !!onOpen;
  return (
    <div data-shift={s.id} role={interactive ? 'button' : undefined} tabIndex={interactive ? (tabIndex ?? 0) : undefined}
      aria-label={interactive ? `${open ? 'Open shift' : 'Shift'} ${shiftTimeText(s)}${label ? ` ${label}` : ''}${st.tag ? `, ${st.tag}` : ''}` : undefined}
      title={title} className="sched-chip"
      onClick={interactive ? (e) => { e.stopPropagation(); onOpen(e, s); } : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpen(e, s); } } : undefined}
      onContextMenu={onContextMenu}
      {...dragProps} {...rest}
      style={{ position: 'relative', background: alpha(color, 0.14), borderLeft: `4px solid ${color}`, borderRadius: 6,
        padding: compact ? '3px 5px' : '5px 26px 5px 8px', marginBottom: 3, minHeight: compact ? 0 : 46, minWidth: 0, overflow: 'hidden',
        cursor: interactive ? 'pointer' : 'default', userSelect: 'none', color: 'var(--ink)', fontFamily: 'inherit', textAlign: 'left',
        outline: draft || open ? `1.5px dashed ${color}` : 'none', outlineOffset: -2,
        opacity: dragging ? 0.4 : s.pendingDelete ? 0.55 : 1, textDecoration: s.pendingDelete ? 'line-through' : 'none', ...style }}>
      {s.hasChanges && !s.pendingDelete && (
        <span aria-hidden="true" title="Edited, not shared" style={{ position: 'absolute', top: 0, right: 0, width: 14, height: 14, color, opacity: 0.55,
          backgroundImage: STRIPES, clipPath: 'polygon(100% 0, 0 0, 100% 100%)' }} />
      )}
      {tools}
      <div style={{ fontSize: compact ? 10.5 : 12, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
        {draft && <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{compact ? shiftTimeText(s).replace(/:00/g, '').replace(/ (AM|PM)/g, (m, ap) => ap.toLowerCase()[0]) : shiftTimeText(s)}</span>
        {open && (s.openSlots || 1) > 1 && <span style={{ fontSize: 10, fontWeight: 800, background: color, color: '#fff', borderRadius: 10, padding: '0 6px', flexShrink: 0 }}>×{s.openSlots}</span>}
        {showConflicts && s.conflicts?.length > 0 && (
          <span title={s.conflicts.join('\n')} aria-label={`Warning: ${s.conflicts.join(' ')}`} style={{ display: 'inline-flex', flexShrink: 0, color: 'hsl(var(--color-orange))' }}>
            <AlertTriangle size={11} />
          </span>
        )}
      </div>
      {!compact && (
        <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label || (open ? 'Open Shift' : 'Shift')}</span>
          {st.tag && <span style={{ fontSize: 9.5, fontWeight: 800, color: st.tag === 'Draft' ? color : 'hsl(var(--color-orange))', flexShrink: 0 }}>{st.tag}</span>}
          {otherZone && <span title={`Times in ${zoneOptionLabel(zone)}`} style={{ fontSize: 9.5, fontWeight: 700, border: '1px solid var(--line)', borderRadius: 6, padding: '0 4px', flexShrink: 0 }}>{tzAbbrev(zone)}</span>}
        </div>
      )}
      {!compact && unpaid && <div style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{unpaid}</div>}
      {children}
    </div>
  );
}

// Time off beside a shift. A partial day shows its hours; a pending request
// reads "Requested"; confidential time off keeps a neutral tint and no note.
export function TimeOffBlock({ off: t, compact = false, showReason = true, style }) {
  const approved = isApprovedOff(t);
  const type = t.confidential ? 'Time Off' : (t.type ? timeOffLabel(t.type) : 'Time Off');
  const when = timeOffWhen(t);
  const range = t.startDate && t.endDate && t.startDate !== t.endDate ? `${formatDate(t.startDate)} - ${formatDate(t.endDate)}` : '';
  const title = [type, approved ? 'Approved' : 'Requested', range || when, showReason && !t.confidential ? t.note : ''].filter(Boolean).join('\n');
  return (
    <div data-timeoff={t.id || undefined} title={title}
      style={{ background: 'hsla(var(--color-red),0.08)', borderLeft: `4px ${approved ? 'solid' : 'dashed'} hsl(var(--color-red))`, borderRadius: 6,
        padding: compact ? '3px 5px' : '5px 8px', marginBottom: 3, minWidth: 0, overflow: 'hidden', color: 'hsl(var(--color-red))', ...style }}>
      <div style={{ fontSize: compact ? 10.5 : 11.5, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <CalendarOff size={10} style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{compact ? (isAllDayOff(t) ? 'Off' : when) : type}</span>
        {t.confidential && <Lock size={10} aria-label="Confidential" style={{ flexShrink: 0 }} />}
      </div>
      {!compact && <div style={{ fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{approved ? '' : 'Requested · '}{range || when}</div>}
      {!compact && showReason && t.note && !t.confidential && <div style={{ fontSize: 10.5, opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.note}</div>}
    </div>
  );
}

export function HolidayBlock({ holiday: h, compact = false, style }) {
  const name = h?.name || h?.title || 'Holiday';
  return (
    <div title={name} style={{ background: 'hsla(var(--color-blue),0.1)', borderLeft: '4px solid hsl(var(--color-blue))', borderRadius: 6,
      padding: compact ? '3px 5px' : '5px 8px', marginBottom: 3, minWidth: 0, overflow: 'hidden', color: 'hsl(var(--color-blue))', ...style }}>
      <div style={{ fontSize: compact ? 10.5 : 11.5, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <PartyPopper size={10} style={{ flexShrink: 0 }} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{compact ? 'Hol' : (h?.type === 'half_day' ? 'Half-Day Holiday' : 'Holiday')}</span>
      </div>
      {!compact && <div style={{ fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>}
    </div>
  );
}

// A person's usual hours on a day with nothing placed - a reminder, never a
// shift, and never counted.
export function UsualHint({ start, end, compact = false }) {
  if (compact) return null;
  return (
    <div title="Usual hours (their shift type). Nothing is on the schedule for this day until a shift is placed."
      style={{ fontSize: 10.5, color: 'var(--muted)', padding: '4px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      Usual {shiftTimeText({ start, end })}
    </div>
  );
}
