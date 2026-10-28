// The "Add Holidays From" list (Holiday policies, Oct 29 2026): one country's
// holidays for one year from GET /hr/public-holidays, grouped by scope
// (Federal / Common Company / Some States Only; National / Gazetted /
// Restricted), each with its REAL date and weekday. A holiday on a Saturday or
// Sunday gets an Observe On select, preset from the weekend rule - nothing is
// moved unless someone chose it. The policy editor and a company's own
// holidays both use it; what "checked" means is the caller's (`chosen`).
import { useEffect, useState } from 'react';
import { COUNTRIES } from '../lib/countries';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { StatusLabel } from '../components/StatusLabel';
import { api } from '../api';
import {
  groupByScope, stateCodes, dateWithWeekday, isWeekend, observedFor, observeOptions,
  NO_DAY_OFF, holidayTypeLabel, HINT,
} from './holidayLib';


// A quiet chip: a company, a country, a policy.
export function Chip({ children, title, onRemove, removeLabel }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--paper, transparent)', border: '1px solid var(--line)',
      borderRadius: 999, padding: '2px 9px', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap', maxWidth: '100%',
    }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel} title={removeLabel}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', fontSize: 13, lineHeight: 1 }}>
          ×
        </button>
      )}
    </span>
  );
}

export const TentativeChip = () => (
  <StatusLabel label="Tentative" color="#b45309" size="sm" title="A lunar date that may move - confirm it nearer the time" />
);

export function CountrySelect({ value, onChange, label = 'Add Holidays From', disabled = false }) {
  return (
    <select className="form-input" aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} style={{ width: 230 }}>
      {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
    </select>
  );
}

// chosen(s) -> the holiday already made from this source row, or null.
// onAdd(s, day) / onRemove(s, row) / onMove(s, row, day): what a check, an
// uncheck and a new Observe On choice do. blocked(s) -> a reason the row
// cannot be added (e.g. a policy already brings it), shown instead of a box.
export default function HolidaySourcePicker({ country, year, rule = 'keep', chosen, onAdd, onRemove, onMove, blocked, disabled = false }) {
  // The answer for the list asked for last; `tries` re-asks after an error.
  const [tries, setTries] = useState(0);
  const want = `${country}|${year}|${tries}`;
  const [state, setState] = useState({ for: '', error: '', noData: false, data: null });
  const [observe, setObserve] = useState({});   // source row -> the day picked before checking it
  useEffect(() => {
    let live = true;
    api.getPublicHolidays(country, year)
      .then(data => { if (live) setState({ for: want, error: '', noData: false, data: data || { holidays: [] } }); })
      .catch(e => {
        if (!live) return;
        if (e?.status === 404) setState({ for: want, error: '', noData: true, data: null });
        else setState({ for: want, error: e?.message || 'The holiday list could not be loaded.', noData: false, data: null });
      });
    return () => { live = false; };
  }, [country, year, want]);
  const load = () => setTries(t => t + 1);

  if (state.for !== want) return <SkeletonBlocks count={4} height={34} borderRadius={8} />;
  if (state.error) return <ErrorBanner message={state.error} onRetry={load} />;
  if (state.noData) return <p style={HINT}>There is no holiday list for this country yet - add holidays by hand instead.</p>;
  const rows = state.data?.holidays || [];
  const groups = groupByScope(rows);
  const rowId = (s) => `${s.date}|${s.name}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {(state.data?.partial || state.data?.note) && (
        <p style={{ ...HINT, color: state.data?.partial ? '#b45309' : 'var(--muted)' }} role="note">
          {state.data?.note || `Partial list for ${year} - confirm dates nearer the time.`}
        </p>
      )}
      {rows.length === 0 && <p style={HINT}>No holidays found for {year}.</p>}
      {groups.map(g => (
        <section key={g.id} aria-label={g.label} style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
          <h5 style={{ margin: 0, padding: '7px 12px', fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', background: 'var(--paper, transparent)', borderBottom: '1px solid var(--line)' }}>
            {g.label}
          </h5>
          {g.rows.map(s => {
            const row = chosen(s);
            const reason = !row && blocked ? blocked(s) : '';
            const weekend = isWeekend(s.date);
            const day = row ? row.date : (observe[rowId(s)] ?? observedFor(s.date, rule));
            const noDay = !row && day === NO_DAY_OFF;
            const pick = (v) => {
              if (row) { if (v === NO_DAY_OFF) onRemove(s, row); else onMove(s, row, v); }
              else setObserve(m => ({ ...m, [rowId(s)]: v }));
            };
            return (
              <div key={rowId(s)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderBottom: '1px solid var(--line)', fontSize: 12.5, flexWrap: 'wrap' }}>
                <input type="checkbox" aria-label={`Add ${s.name}`} checked={!!row}
                  disabled={disabled || !!reason || noDay}
                  title={reason || (noDay ? 'No day off when it falls on a weekend - pick a day to add it' : undefined)}
                  onChange={() => (row ? onRemove(s, row) : onAdd(s, day))} />
                <span style={{ flex: '1 1 180px', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                  {s.tentative && <TentativeChip />}
                  {stateCodes(s.scope) && <Chip title="Only in these states">{stateCodes(s.scope)}</Chip>}
                  {reason && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{reason}</span>}
                </span>
                <span style={{ minWidth: 150, color: 'var(--muted)' }}>{dateWithWeekday(s.date)}</span>
                <span style={{ minWidth: 70, fontSize: 11, color: 'var(--muted)' }}>{holidayTypeLabel(s.suggestedType)}</span>
                {weekend && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)' }}>
                    Observe On
                    <select className="form-input" aria-label={`Observe ${s.name} On`} value={day} disabled={disabled || !!reason}
                      onChange={e => pick(e.target.value)} style={{ width: 'auto', fontSize: 11.5, padding: '3px 6px' }}>
                      {observeOptions(s.date).concat(row && !observeOptions(s.date).some(o => o.value === row.date)
                        ? [{ value: row.date, label: `Another Day - ${dateWithWeekday(row.date)}` }] : [])
                        .map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
