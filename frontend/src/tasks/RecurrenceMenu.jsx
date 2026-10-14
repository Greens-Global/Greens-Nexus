// Task Module - the Repeat menu (Oct 14 2026). One set of controls for every
// place a recurrence is picked: the task drawer's Recurrence row, and the
// Repeat button in the calendar of a due date (the drawer, the List view, the
// add-subtask row - Sagar: pick the date and how it repeats in one place, the
// way Asana's date picker has it).
//
// A subtask has three states, not two (Sagar, Oct 14 2026: "repeat with the
// main task, but it should be changeable"):
//   {} / null         repeats with its main task (backend _carry_subtasks)
//   { skip: true }    stays behind when the main task repeats
//   { freq, ... }     its own schedule; each copy lands under the main task's
//                     current occurrence (backend _spawn_next_occurrence)
import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { NX, FONT, btn, input as inputStyle } from './theme';
import { DateField } from './components';
import { DAYS, DAY_ABBR, recurrenceLabel, monthRuleOf, yearRuleOf, PERIODIC_PRESETS, clampDays, MAX_PERIODIC_DAYS, ruleFromDate } from './recurrence';
import { MonthDayControls, YearDayControls } from './RecurrenceParts';

/** A whole-number box for the Recurrence menu (Oct 13 2026). It used to save
 *  - clamped to at least 1 - on every keystroke: clearing "1" put it straight
 *  back, so typing "2" made "12", and each key sent a save and a "Changes
 *  saved" toast. Now the box holds what is typed and saves once, on Enter or
 *  leaving it, only a whole number >= `min`; Escape or anything else puts the
 *  saved value back. `allowEmpty` lets clearing it save `null` (no count). */
export function CommitNumberInput({ value, onCommit, min = 1, max = 9999, allowEmpty = false, style, ...rest }) {
  const shown = value == null ? '' : String(value);
  const [text, setText] = useState(shown);
  const [synced, setSynced] = useState(shown);
  if (synced !== shown) { setSynced(shown); setText(shown); }   // saved elsewhere
  const commit = () => {
    const raw = text.trim();
    if (raw === '' && allowEmpty) { if (value != null) onCommit(null); return; }
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < min) { setText(shown); return; }
    const v = Math.min(max, n);
    setText(String(v));
    if (v !== Number(value)) onCommit(v);
  };
  return (
    <input type="number" inputMode="numeric" min={min} max={max} step="1" value={text} {...rest}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.stopPropagation(); setText(shown); }
      }}
      style={style} />
  );
}

/** Toggling a day in or out of a recurrence's days - never down to none: a
 *  rule with no days has nothing to land on. */
const toggleDay = (days, i) => (days.includes(i)
  ? (days.length > 1 ? days.filter((x) => x !== i) : days)
  : [...days, i].sort((a, b) => a - b));

/** "On these days" - the S M T W T F S row Weekly and Custom(week) share.
 *  Multi-toggle, stays open (no close-on-pick) since more than one day is
 *  usually wanted. */
function RecurDayPicker({ value, onToggle }) {
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      {DAY_ABBR.map((d, i) => {
        const on = value.includes(i);
        return (
          <button key={d} type="button" title={DAYS[i]} onClick={() => onToggle(i)}
            style={{
              width: 24, height: 24, borderRadius: '50%', border: `1px solid ${on ? NX.primary : NX.border}`,
              background: on ? NX.primary : 'transparent', color: on ? '#fff' : NX.dim,
              fontSize: 10.5, fontWeight: 700, cursor: 'pointer', padding: 0, fontFamily: FONT,
            }}>{d[0]}</button>
        );
      })}
    </div>
  );
}

function Item({ onClick, on, more, children }) {
  return (
    <button type="button" className="nx-menu-row" onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px',
      borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: FONT, color: NX.ink, background: 'transparent',
    }}>
      <span style={{ width: 13, display: 'inline-flex', flexShrink: 0 }}>{on && <Check size={13} style={{ color: NX.blue }} />}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {more && <ChevronRight size={13} style={{ color: NX.faint, flexShrink: 0 }} />}
    </button>
  );
}

const followsMain = (value, subtask, mainRule) => !!subtask && !!mainRule?.freq && !value?.freq && !value?.skip;

/** What the control says now: the rule, "with the main task", or nothing. */
export function repeatSummary(value, { subtask = false, mainRule = null } = {}) {
  if (value?.freq) return recurrenceLabel(value);
  if (followsMain(value, subtask, mainRule)) return `Repeats with the main task - ${recurrenceLabel(mainRule)}`;
  if (subtask && mainRule?.freq) return 'Not repeating with the main task';
  return 'Does not repeat';
}

/**
 * The menu itself: a root list (with the main task / does not repeat / the
 * frequencies) and a step per frequency. `close` is called after a final
 * pick; without one (the calendar panel) a pick returns to the root list,
 * which then shows the Ends controls (`ends`).
 */
export function RecurrenceMenu({ value, seedDate, onChange, close, subtask = false, mainRule = null, ends = false }) {
  const [step, setStep] = useState('root');
  const done = () => (close ? close() : setStep('root'));
  // Pick a frequency, carrying any existing end condition over.
  const pickFreq = (base) => {
    const cur = value || {};
    const r = { ...base };
    if (cur.until) r.until = cur.until;
    if (cur.count != null) r.count = cur.count;
    onChange(r);
  };
  const recSel = { ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 12, cursor: 'pointer' };
  const back = <Item onClick={() => setStep('root')}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ChevronLeft size={14} /> Back</span></Item>;
  const freq = value?.freq;
  const canFollow = subtask && !!mainRule?.freq;

  if (step === 'weekly') {
    const cur = freq === 'weekly' ? value : {};
    const days = cur.daysOfWeek ?? (cur.dayOfWeek != null ? [cur.dayOfWeek] : [1]);
    const toggle = (i) => { const next = toggleDay(days, i); if (next !== days) pickFreq({ freq: 'weekly', daysOfWeek: next }); };
    return (<>
      {back}
      <div style={{ padding: '4px 10px 8px' }}>
        <div style={{ fontSize: 11, color: NX.faint, marginBottom: 6 }}>On these days</div>
        <RecurDayPicker value={days} onToggle={toggle} />
      </div>
    </>);
  }
  // Monthly and Yearly name their day with the shared controls
  // (recurrence.js): "Day 15" / "Last Day", or "the Fourth Friday" - applied
  // as each one changes.
  if (step === 'monthly') {
    const cur = freq === 'monthly' ? monthRuleOf(value) : { dayOfMonth: 1 };
    return (<>
      {back}
      <div style={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, color: NX.faint }}>Every month on</div>
        <MonthDayControls value={cur} seedDate={seedDate} selectStyle={recSel}
          onChange={(v) => pickFreq({ freq: 'monthly', ...v })} />
      </div>
    </>);
  }
  if (step === 'yearly') {
    const cur = freq === 'yearly' ? yearRuleOf(value) : {};
    return (<>
      {back}
      <div style={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, color: NX.faint }}>Every year on</div>
        <YearDayControls value={cur} seedDate={seedDate} selectStyle={recSel}
          onChange={(v) => pickFreq({ freq: 'yearly', ...v })} />
      </div>
    </>);
  }
  if (step === 'periodic') {
    const cur = freq === 'periodic' ? Number(value.daysAfterCompletion) || 1 : null;
    return (<>
      {back}
      {/* Any number of days: type one, Enter or Set. */}
      <form onSubmit={(e) => { e.preventDefault(); const n = clampDays(e.currentTarget.days.value); pickFreq({ freq: 'periodic', daysAfterCompletion: n }); done(); }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 8px', fontSize: 12 }}>
        <input name="days" type="number" min="1" max={MAX_PERIODIC_DAYS} step="1" defaultValue={cur ?? ''} placeholder="Other"
          aria-label="Days after completion" style={{ ...inputStyle, width: 72, padding: '4px 6px', fontSize: 12 }} />
        <span style={{ color: NX.faint, flex: 1 }}>days after completion</span>
        <button type="submit" style={{ ...btn('outline'), padding: '3px 9px', fontSize: 12 }}>Set</button>
      </form>
      <div className="nx-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
        {PERIODIC_PRESETS.map((d) => (
          <Item key={d} on={cur === d} onClick={() => { pickFreq({ freq: 'periodic', daysAfterCompletion: d }); done(); }}>
            {d} day{d === 1 ? '' : 's'} after completion
          </Item>
        ))}
      </div>
    </>);
  }
  if (step === 'custom') {
    const cur = freq === 'custom' ? value : {};
    const unit = cur.unit || 'week';
    const interval = cur.interval || 1;
    const days = cur.daysOfWeek ?? (cur.dayOfWeek != null ? [cur.dayOfWeek] : [1]);
    const applyCustom = (partial) => {
      const next = { unit, interval, ...partial };
      const rec = { freq: 'custom', unit: next.unit, interval: next.interval };
      if (next.unit === 'week') rec.daysOfWeek = next.daysOfWeek ?? days;
      // The day a month / year unit names - kept across an interval change,
      // dropped when the unit changes.
      const sameUnit = next.unit === unit;
      if (next.unit === 'month') Object.assign(rec, next.monthRule ?? (sameUnit ? monthRuleOf(cur) : { dayOfMonth: ruleFromDate(seedDate).dayOfMonth }));
      if (next.unit === 'year') Object.assign(rec, next.yearRule ?? (sameUnit ? yearRuleOf({ ...cur, unit: 'year' }) : {}));
      pickFreq(rec);
    };
    return (<>
      {back}
      <div style={{ padding: '4px 10px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span style={{ color: NX.faint }}>Every</span>
          <CommitNumberInput value={interval} min={1} max={365} aria-label="Repeat every"
            onCommit={(n) => applyCustom({ interval: n })}
            style={{ ...inputStyle, width: 50, padding: '4px 6px', fontSize: 12 }} />
          <select value={unit} onChange={(e) => applyCustom({ unit: e.target.value })} style={recSel}>
            <option value="day">Day{interval === 1 ? '' : 's'}</option>
            <option value="week">Week{interval === 1 ? '' : 's'}</option>
            <option value="month">Month{interval === 1 ? '' : 's'}</option>
            <option value="year">Year{interval === 1 ? '' : 's'}</option>
          </select>
        </div>
        {unit === 'week' && (<>
          <div style={{ fontSize: 11, color: NX.faint }}>On these days</div>
          <RecurDayPicker value={days} onToggle={(i) => { const next = toggleDay(days, i); if (next !== days) applyCustom({ unit: 'week', daysOfWeek: next }); }} />
        </>)}
        {unit === 'month' && (<>
          <div style={{ fontSize: 11, color: NX.faint }}>On</div>
          <MonthDayControls value={monthRuleOf(cur)} seedDate={seedDate} selectStyle={recSel}
            onChange={(v) => applyCustom({ monthRule: v })} />
        </>)}
        {unit === 'year' && (<>
          <div style={{ fontSize: 11, color: NX.faint }}>On</div>
          <YearDayControls value={yearRuleOf({ ...cur, unit: 'year' })} seedDate={seedDate} selectStyle={recSel}
            onChange={(v) => applyCustom({ yearRule: v })} />
        </>)}
      </div>
    </>);
  }

  const off = canFollow ? !!value?.skip && !freq : !freq;
  return (<>
    {canFollow && (
      <Item on={followsMain(value, subtask, mainRule)} onClick={() => { onChange({}); done(); }}>
        With the Main Task
        <span style={{ display: 'block', fontSize: 11.5, color: NX.faint }}>{recurrenceLabel(mainRule)}</span>
      </Item>
    )}
    <Item on={off} onClick={() => { onChange(canFollow ? { skip: true } : (subtask ? {} : null)); done(); }}>Does not repeat</Item>
    <Item on={freq === 'daily'} onClick={() => { pickFreq({ freq: 'daily' }); done(); }}>Daily</Item>
    <Item on={freq === 'weekly'} more onClick={() => setStep('weekly')}>Weekly</Item>
    <Item on={freq === 'monthly'} more onClick={() => setStep('monthly')}>Monthly</Item>
    <Item on={freq === 'yearly'} more onClick={() => setStep('yearly')}>Yearly</Item>
    <Item on={freq === 'periodic'} more onClick={() => setStep('periodic')}>Periodically</Item>
    <Item on={freq === 'custom'} more onClick={() => setStep('custom')}>Custom</Item>
    {subtask && freq && (
      <div style={{ padding: '4px 10px', fontSize: 11.5, color: NX.faint }}>Its own schedule - each copy goes under the main task.</div>
    )}
    {ends && freq && (
      <div style={{ borderTop: `1px solid ${NX.border2}`, marginTop: 6, padding: '8px 6px 2px' }}>
        <RecurrenceEnds value={value} onChange={onChange} />
      </div>
    )}
  </>);
}

/** "Ends" - Never / On date / After occurrences. Local mode so "On date" and
 *  "After" stay selected before a value is entered (an empty until/count is
 *  falsy and would otherwise read back as "Never"). */
export function RecurrenceEnds({ value, onChange }) {
  const [mode, setMode] = useState(() => (value?.until ? 'on' : value?.count != null ? 'after' : 'never'));
  // Replace the end condition (strips until+count first).
  const patchEnd = (changes) => {
    const base = { ...(value || {}) };
    delete base.until; delete base.count;
    onChange({ ...base, ...changes });
  };
  const pick = (m) => {
    setMode(m);
    if (m === 'never') patchEnd({});
    else if (m === 'on') patchEnd(value?.until ? { until: value.until } : {});
    else if (m === 'after') patchEnd(value?.count != null ? { count: value.count } : {});
  };
  const sel = { ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 12, cursor: 'pointer' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 12, color: NX.dim }}>
      <span style={{ color: NX.faint }}>Ends</span>
      <select value={mode} onChange={(e) => pick(e.target.value)} style={sel}>
        <option value="never">Never</option>
        <option value="on">On date</option>
        <option value="after">After occurrences</option>
      </select>
      {mode === 'on' && (
        <DateField value={value.until || ''} onChange={(v) => patchEnd(v ? { until: v } : {})}
          placeholder="Pick a date" style={{ ...inputStyle, width: 'auto', padding: '5px 8px', fontSize: 12 }} />
      )}
      {mode === 'after' && (
        <>
          <CommitNumberInput value={value.count ?? null} min={1} allowEmpty placeholder="e.g. 10" aria-label="Occurrences"
            onCommit={(n) => patchEnd(n == null ? {} : { count: n })}
            style={{ ...inputStyle, width: 72, padding: '5px 8px', fontSize: 12 }} />
          <span style={{ color: NX.faint }}>times</span>
        </>
      )}
    </div>
  );
}

/** The `repeat` prop for a due date's DateField: a Repeat button in its
 *  calendar footer that opens this menu in the calendar's place. */
export function repeatOption({ value, seedDate, onChange, subtask = false, mainRule = null }) {
  const own = !!value?.freq;
  const following = followsMain(value, subtask, mainRule);
  return {
    on: own || following,
    label: own ? recurrenceLabel(value) : following ? 'With Main Task' : 'Repeat',
    render: () => <RecurrenceMenu value={value} seedDate={seedDate} onChange={onChange} subtask={subtask} mainRule={mainRule} ends />,
  };
}
