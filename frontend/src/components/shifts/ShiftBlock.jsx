// The one shift block (Oct 2026, "less clutter" - Visesh, Charmi, Neil):
// ONE calm line, "8:30a - 5:30p" in the ink with the shift type's code in
// the type's color beside a 3px bar of the same color. A second line only
// when the shift has a label. Everything else - the lunch, the note, the
// activities, the zone, the conflicts - is the hover title and the panel.
// A draft is dashed; an edit that is not shared yet gets a small corner
// mark; a removal is struck through. The time never truncates: the font
// shrinks with the block (container units) before anything is cut.
// Time off is ITS OWN soft rose block beside the shift, never in its place.
// An open shift is the same block with a hollow (double) bar and a ×N.
import { AlertTriangle, Lock } from 'lucide-react';
import { formatDate } from '../../lib/datetime';
import { timeOffLabel } from '../shiftScheduleLib';
import { alpha, DEFAULT_SHIFT_COLOR, OPEN_SHIFT_COLOR, shiftState, shiftTimeText, shiftShortText, unpaidLabel, timeOffWhen, timeOffShort, isApprovedOff, isAllDayOff, zoneDiffers } from './shiftLib';
import { zoneOptionLabel, tzAbbrev } from '../../lib/worldClockZones';

// The time shrinks from 12px toward 9px as the block narrows (a share of
// the block's width in container units - set on the LINE, never on the
// block itself, since an element cannot measure against its own container),
// so a 7-column week at 1440px reads whole and a two-week view still shows
// every digit. A block that also carries a ×N, a zone or a warning shrinks
// a little more; the time itself never shrinks past 8.5px and never cuts.
const fit = (share, max = 12) => `clamp(8.5px, ${share}cqi, ${max}px)`;
const LINE = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };

export function ShiftBlock({ shift: s, open = false, compact = false, teamZone = '', onOpen, onContextMenu, dragProps = {},
  tabIndex, showConflicts = true, dragging = false, children, style, ...rest }) {
  const color = s.color || (open ? OPEN_SHIFT_COLOR : DEFAULT_SHIFT_COLOR);
  const st = shiftState(s);
  const zone = s.timeZone || s.timezone || '';
  const otherZone = zoneDiffers(zone, teamZone);
  const unpaid = unpaidLabel(s);
  const code = s.code || '';
  const label = s.label && s.label !== code ? s.label : '';
  const draft = s.published === false && !s.hasChanges && !s.pendingDelete;
  const title = [`${shiftTimeText(s)}${code ? ` · ${code}` : ''}${label ? ` · ${label}` : ''}`, st.title, unpaid, s.note,
    ...(s.activities || []).map((a) => `${a.start && a.end ? `${shiftTimeText(a)} ` : ''}${a.label || 'Activity'}${a.paid === false ? ' (unpaid)' : ''}`),
    otherZone ? `Times in ${zoneOptionLabel(zone)}` : '', ...(s.conflicts || [])].filter(Boolean).join('\n');
  const interactive = !!onOpen;
  const slots = open && (s.openSlots || 1) > 1 ? s.openSlots : 0;
  const warn = showConflicts && s.conflicts?.length > 0;
  const share = (compact ? 11 : 9.5) - (slots ? 1.3 : 0) - (otherZone ? 1.3 : 0) - (warn ? 0.6 : 0);
  return (
    <div data-shift={s.id} role={interactive ? 'button' : undefined} tabIndex={interactive ? (tabIndex ?? 0) : undefined}
      aria-label={interactive ? `${open ? 'Open shift' : 'Shift'} ${shiftTimeText(s)}${code ? ` ${code}` : ''}${label ? ` ${label}` : ''}${st.tag ? `, ${st.tag}` : ''}` : undefined}
      title={title} className="sched-chip"
      onClick={interactive ? (e) => { e.stopPropagation(); onOpen(e, s); } : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpen(e, s); } } : undefined}
      onContextMenu={onContextMenu}
      {...dragProps} {...rest}
      style={{ position: 'relative', containerType: 'inline-size', background: alpha(color, open ? 0.08 : 0.12), borderRadius: 6,
        border: `1px ${draft ? 'dashed' : 'solid'} ${draft ? color : 'transparent'}`, borderLeft: `3px ${open ? 'double' : 'solid'} ${color}`,
        padding: compact ? '2px 4px' : '4px 8px', marginBottom: 3, minWidth: 0, overflow: 'hidden',
        cursor: interactive ? 'pointer' : 'default', userSelect: 'none', color: 'var(--ink)', fontFamily: 'inherit', textAlign: 'left',
        opacity: dragging ? 0.4 : s.pendingDelete ? 0.55 : 1, textDecoration: s.pendingDelete ? 'line-through' : 'none', ...style }}>
      {s.hasChanges && !s.pendingDelete && (
        <span aria-hidden="true" title="Edited, not shared" style={{ position: 'absolute', top: 0, right: 0, width: 8, height: 8, background: color, clipPath: 'polygon(100% 0, 0 0, 100% 100%)' }} />
      )}
      <div style={{ ...LINE, display: 'flex', alignItems: 'baseline', gap: 4, fontSize: fit(share, compact ? 11 : 12), fontWeight: 700, lineHeight: 1.3 }}>
        <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{shiftShortText(s)}</span>
        {code && <span style={{ ...LINE, color, fontSize: '0.85em', fontWeight: 800, letterSpacing: '.02em', flexShrink: 1 }}>{code}</span>}
        {slots > 0 && <span style={{ fontSize: '0.75em', fontWeight: 800, background: color, color: '#fff', borderRadius: 10, padding: '0 4px', flexShrink: 0, alignSelf: 'center' }}>×{slots}</span>}
        {warn && (
          <span title={s.conflicts.join('\n')} aria-label={`Warning: ${s.conflicts.join(' ')}`} style={{ display: 'inline-flex', flexShrink: 0, color: 'hsl(var(--color-orange))', alignSelf: 'center' }}>
            <AlertTriangle size={10} />
          </span>
        )}
        {otherZone && <span title={`Times in ${zoneOptionLabel(zone)}`} style={{ fontSize: '0.78em', fontWeight: 700, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 4, padding: '0 3px', flexShrink: 0, alignSelf: 'center' }}>{tzAbbrev(zone)}</span>}
      </div>
      {label && !compact && <div style={{ ...LINE, fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.3 }}>{label}</div>}
      {children}
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
