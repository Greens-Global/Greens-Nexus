// The Calendar widget on a phone (Neil, 11/17/2026: "it should work like
// iPhone outlook calendar widget where it is tight and helpful").
//
// The month grid and the day stepper are the web's - on a phone the tile is
// a glance, the way the Outlook widget is: today's date on the left (the
// weekday in blue over a big day number) and, beside it, what is still ahead
// today - all-day items first, then each meeting with its start time and how
// long it runs, its title on one line and where it is under it. A meeting
// that has ended leaves the list. When today has room, tomorrow follows under
// its own label. A Teams meeting gets a Join button from ten minutes before
// it starts until it ends - the one thing a phone is opened for. Tapping a
// row opens the event in Outlook; the date opens the day in Outlook.
//
// No rectangles (Neil, 11/17/2026): rows split by hairlines; each event
// carries a small dot in its calendar color, never a colored bar beside it.
import { formatHHMM, formatWeekday } from '../lib/datetime';
import { WidgetSkeleton, WidgetError } from './listParts.jsx';
import { stillAhead, durationText, joinableNow } from './agendaModel';

// Today shows up to four items; tomorrow follows when today leaves room, and
// then always with at least two (one row of a trip says little).
export const PHONE_AGENDA_ROWS = 4;
const TOMORROW_MIN = 2;
export const OUTLOOK_DAY_URL = 'https://outlook.office.com/calendar/view/day';

const open = (url) => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); };

const dotColor = (ev) => (ev.isHoliday ? 'hsl(var(--color-red))' : ev.isBirthday ? 'hsl(var(--color-gold))' : 'hsl(var(--color-blue))');
const whereText = (ev) => (ev.isHoliday ? 'Company Holiday' : ev.isBirthday ? 'Birthday'
  : ev.location || (ev.joinUrl ? 'Microsoft Teams Meeting' : ''));

function Row({ ev, first, nowMs }) {
  const join = joinableNow(ev, nowMs);
  const where = whereText(ev);
  const dur = ev.isAllDay ? '' : durationText(ev.start, ev.end);
  const clickable = !!ev.webLink;
  return (
    <div role={clickable ? 'link' : undefined} tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `${ev.subject}${ev.isAllDay ? ', all day' : `, ${formatHHMM((ev.start || '').slice(11, 16))}`}` : undefined}
      onClick={clickable ? () => open(ev.webLink) : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter') open(ev.webLink); } : undefined}
      style={{ display: 'grid', gridTemplateColumns: '68px 8px minmax(0, 1fr)', alignItems: 'start', columnGap: 8,
        padding: '8px 0', borderTop: first ? 'none' : '1px solid var(--line)', cursor: clickable ? 'pointer' : 'default', minWidth: 0 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', lineHeight: '18px' }}>
          {ev.isAllDay ? 'All Day' : formatHHMM((ev.start || '').slice(11, 16))}
        </div>
        {dur && <div style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', lineHeight: '16px' }}>{dur}</div>}
      </div>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 99, background: dotColor(ev), marginTop: 5 }} />
      <div style={{ minWidth: 0 }}>
        <div title={ev.subject} style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.subject}</div>
        {(where || join) && (
          <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, fontSize: 12, color: 'var(--muted)', lineHeight: '16px' }}>
            {/* Join leads the second line, so the title keeps the row's width;
                its padding is the touch target, the negative margin keeps
                the line its height. */}
            {join && (
              <button type="button" onClick={(e) => { e.stopPropagation(); open(ev.joinUrl); }}
                style={{ flexShrink: 0, border: 'none', background: 'none', margin: '-10px 0', padding: '10px 8px 10px 0', fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: 'hsl(var(--color-blue))', cursor: 'pointer' }}>
                Join Now
              </button>
            )}
            {where && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{join ? `· ${where}` : where}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function Rows({ list, nowMs }) {
  return list.map((ev, k) => <Row key={`${ev.subject}-${ev.start || ''}-${k}`} ev={ev} first={k === 0} nowMs={nowMs} />);
}

const note = { fontSize: 13, color: 'var(--muted)', padding: '8px 0', lineHeight: 1.4 };

// `today` / `tomorrow`: the day's items (holidays and birthdays included),
// all-day first. `todayKey`: 'YYYY-MM-DD'. `nowMs`: the minute the caller last ticked.
export default function PhoneAgenda({ todayKey, today = [], tomorrow = [], nowMs, loading = false, error = false, onRetry }) {
  const date = new Date(`${todayKey}T00:00:00`);
  const ahead = stillAhead(today, nowMs);
  const shown = ahead.slice(0, PHONE_AGENDA_ROWS);
  const more = ahead.length - shown.length;
  const room = PHONE_AGENDA_ROWS - shown.length;
  const next = room > 0 ? tomorrow.slice(0, Math.max(TOMORROW_MIN, room)) : [];
  const nextMore = room > 0 ? tomorrow.length - next.length : 0;

  let body;
  if (loading) body = <WidgetSkeleton rows={2} rowHeight={34} />;
  else if (error) body = <WidgetError message="Couldn't load your calendar." onRetry={onRetry} />;
  else body = (
    <>
      {shown.length > 0
        ? <Rows list={shown} nowMs={nowMs} />
        : <div style={note}>{today.length ? 'Nothing else today.' : 'Nothing scheduled today.'}</div>}
      {more > 0 && (
        <button type="button" className="link-btn" onClick={() => open(OUTLOOK_DAY_URL)}
          style={{ display: 'block', margin: 0, padding: '8px 0 2px 76px', minHeight: 36, fontSize: 13, fontWeight: 600, textAlign: 'left' }}>
          {more} more today
        </button>
      )}
      {next.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', padding: '10px 0 0', marginTop: 2, borderTop: '1px solid var(--line)' }}>Tomorrow</div>
          <Rows list={next} nowMs={nowMs} />
          {nextMore > 0 && <div style={{ ...note, padding: '2px 0 0 76px', fontSize: 12 }}>{nextMore} more tomorrow</div>}
        </>
      )}
    </>
  );

  // The layout is style.css's "Phone agenda" block: the date beside the list,
  // or over it when the card is narrower than a 360px phone's.
  return (
    <div className="dash-card nx-agenda" aria-label="Calendar" style={{ height: '100%', boxSizing: 'border-box', minWidth: 0 }}>
      <div className="nx-agenda-in">
        <button type="button" className="nx-agenda-date" onClick={() => open(OUTLOOK_DAY_URL)} aria-label={`${formatWeekday(date)} ${date.getDate()} - open the day in Outlook`}>
          <span className="nx-agenda-wd">{formatWeekday(date)}</span>
          <span className="nx-agenda-day">{date.getDate()}</span>
        </button>
        <div className="nx-agenda-list">{body}</div>
      </div>
    </div>
  );
}
