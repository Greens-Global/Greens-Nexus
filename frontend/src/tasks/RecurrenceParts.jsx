// The recurrence controls the Create Task form and the task drawer share -
// see recurrence.js for the rule shapes. Each takes the day-naming part of a
// rule and hands back a replacement for it.
import { useState } from 'react';
import { DAYS, MONTHS, WEEKS_OF_MONTH, PERIODIC_PRESETS, MAX_PERIODIC_DAYS, clampDays, ruleFromDate } from './recurrence';
import { NX } from './theme';

const row = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
// The mode select takes its own line; the day parts share the next one
// ("Fourth" "Friday"), whatever width the caller's select style asks for.
const whole = (st) => ({ ...st, flex: '1 1 100%', minWidth: 0 });
const part = (st) => ({ ...st, width: 'auto', flex: '1 1 0', minWidth: 0 });

function WeekdaySelects({ value, onChange, selectStyle }) {
  return (
    <>
      <select aria-label="Which week" value={value.weekOfMonth} style={part(selectStyle)}
        onChange={(e) => onChange({ ...value, weekOfMonth: Number(e.target.value) })}>
        {WEEKS_OF_MONTH.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
      </select>
      <select aria-label="Weekday" value={value.weekday} style={part(selectStyle)}
        onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}>
        {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
      </select>
    </>
  );
}

/** Monthly: "Day 15" / "Last Day", or "the Fourth Friday". `seedDate` (the
 *  task's due date) is what switching modes starts from, so a task due on
 *  the 4th Friday offers exactly that. */
export function MonthDayControls({ value, onChange, seedDate = '', selectStyle }) {
  const byWeekday = value?.weekOfMonth != null;
  const seed = ruleFromDate(seedDate);
  return (
    <div style={row}>
      <select aria-label="Repeat on" value={byWeekday ? 'weekday' : 'day'} style={whole(selectStyle)}
        onChange={(e) => onChange(e.target.value === 'weekday'
          ? { weekOfMonth: seed.weekOfMonth, weekday: seed.weekday }
          : { dayOfMonth: seed.dayOfMonth })}>
        <option value="day">Day of Month</option>
        <option value="weekday">Day of Week</option>
      </select>
      {byWeekday
        ? <WeekdaySelects value={value} onChange={onChange} selectStyle={selectStyle} />
        : (
          <select aria-label="Day of month" value={value?.dayOfMonth ?? 1} style={whole(selectStyle)}
            onChange={(e) => onChange({ dayOfMonth: Number(e.target.value) })}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Day {d}</option>)}
            <option value={-1}>Last Day</option>
          </select>
        )}
    </div>
  );
}

/** Yearly: the same date every year, or "the Fourth Thursday of November". */
export function YearDayControls({ value, onChange, seedDate = '', selectStyle }) {
  const byWeekday = value?.weekOfMonth != null;
  const seed = ruleFromDate(seedDate);
  return (
    <div style={row}>
      <select aria-label="Repeat on" value={byWeekday ? 'weekday' : 'date'} style={whole(selectStyle)}
        onChange={(e) => onChange(e.target.value === 'weekday'
          ? { weekOfMonth: seed.weekOfMonth, weekday: seed.weekday, monthOfYear: seed.monthOfYear }
          : {})}>
        <option value="date">Same Date Each Year</option>
        <option value="weekday">Day of Week</option>
      </select>
      {byWeekday && (
        <>
          <WeekdaySelects value={value} onChange={onChange} selectStyle={selectStyle} />
          <span style={{ fontSize: 12, color: NX.faint }}>of</span>
          <select aria-label="Month" value={value.monthOfYear || 1} style={part(selectStyle)}
            onChange={(e) => onChange({ ...value, monthOfYear: Number(e.target.value) })}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </>
      )}
    </div>
  );
}

/** Periodically: a preset count, or "Other..." for any number of days. */
export function PeriodicDaysControl({ value, onChange, selectStyle, inputStyle }) {
  const n = Number(value) || 1;
  const [other, setOther] = useState(!PERIODIC_PRESETS.includes(n));
  // The box holds what is typed; the rule only takes a whole number of days.
  const [text, setText] = useState(String(n));
  const [shown, setShown] = useState(n);
  if (shown !== n) { setShown(n); setText(String(n)); }   // a new value from outside
  return (
    <div style={row}>
      <select aria-label="Days after completion" value={other ? 'other' : n} style={whole(selectStyle)}
        onChange={(e) => {
          if (e.target.value === 'other') { setOther(true); return; }
          setOther(false);
          onChange(Number(e.target.value));
        }}>
        {PERIODIC_PRESETS.map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
        <option value="other">Other…</option>
      </select>
      {other && (
        <>
          <input type="number" min="1" max={MAX_PERIODIC_DAYS} step="1" aria-label="Number of days" value={text}
            onChange={(e) => { setText(e.target.value); if (Number(e.target.value) >= 1) onChange(clampDays(e.target.value)); }}
            onBlur={() => setText(String(clampDays(text)))}
            style={{ ...inputStyle, width: 84 }} />
          <span style={{ fontSize: 12, color: NX.faint }}>days</span>
        </>
      )}
    </div>
  );
}
