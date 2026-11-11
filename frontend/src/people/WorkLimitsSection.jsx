import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { SkeletonBlocks, ErrorBanner } from '../components/AsyncState';
import { useTabDraft } from './useTabDraft';
import { Row, SectionHead, Field, EditButton, TabSaveRow } from './shared';
import { BOX, GRID, HINT } from './lib';

// Work Limits (Neil, 11/11/2026, Deputy's "stress profile"): limits HR sets
// for ONE person - a student on 20 hours a week, a minor, a part-timer on
// three shifts. The planner warns past the tighter of these and the
// company's own rules (shift_rules.py), salaried people included; it never
// blocks. Blank or 0 = no limit of their own. A manager reads them.

const LIMITS = [
  ['maxHoursDay', 'Hours a Day', 'Most scheduled hours in one day.', 24],
  ['maxHoursWeek', 'Hours a Week', 'Most scheduled hours in one week.', 168],
  ['maxShiftsWeek', 'Shifts a Week', 'Most shifts in one week.', 21],
  ['minRestHours', 'Rest Between Shifts', 'Fewest hours off between one workday and the next.', 24],
  ['maxDaysInRow', 'Days in a Row', 'Most days worked in a row.', 14],
];
const UNIT = { maxHoursDay: 'hour', maxHoursWeek: 'hour', minRestHours: 'hour', maxShiftsWeek: 'shift', maxDaysInRow: 'day' };
const shown = (k, v) => {
  const n = Number(v) || 0;
  return n > 0 ? `${n} ${UNIT[k]}${n === 1 ? '' : 's'}` : 'No limit';
};

export default function WorkLimitsSection({ employee, toastOk, toastErr }) {
  const eid = employee?.id;
  const [data, setData] = useState(null);      // { limits, canEdit }
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!eid) return undefined;
    let live = true;
    setError('');
    api.hrWorkLimits(eid).then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e?.message || 'Could not load the work limits.'); });
    return () => { live = false; };
  }, [eid, tick]);

  const saved = useMemo(() => Object.fromEntries(LIMITS.map(([k]) => [k, String(Number(data?.limits?.[k]) || '')])), [data]);
  const t = useTabDraft(saved, {
    label: 'Work Limits',
    onSave: async (draft) => {
      const out = {};
      for (const [k] of LIMITS) out[k] = Number(draft[k]) || 0;
      try {
        const r = await api.saveHrWorkLimits(eid, out);
        setData((d) => ({ ...d, ...r }));
        toastOk?.('Work limits saved. The planner warns on them from now on.');
        return true;
      } catch (e) { toastErr?.(e?.message || 'Could not save the work limits.'); return false; }
    },
  });
  const d = t.draft || saved;
  const bad = LIMITS.find(([k, , , max]) => d[k] !== '' && !(Number.isInteger(Number(d[k])) && Number(d[k]) >= 0 && Number(d[k]) <= max));

  const head = (
    <SectionHead title="Work Limits">
      {data?.canEdit && !t.editing && <EditButton onClick={t.startEdit} />}
    </SectionHead>
  );
  if (error) return <div>{head}<ErrorBanner message={error} onRetry={() => setTick((n) => n + 1)} /></div>;
  if (!data) return <div>{head}<SkeletonBlocks count={1} height={18} /></div>;

  return (
    <div data-work-limits>
      {head}
      {t.editing ? (
        <>
          <div style={GRID}>
            {LIMITS.map(([k, label, hint, max]) => (
              <Field key={k} label={label} htmlFor={`wl-${k}`} hint={hint}>
                <input id={`wl-${k}`} type="number" min="0" max={max} step="1" inputMode="numeric" className="form-input" style={BOX}
                  placeholder="No limit" value={d[k]} onChange={(e) => t.patch({ [k]: e.target.value })} />
              </Field>
            ))}
          </div>
          {bad && <div style={{ fontSize: 12, color: 'hsl(var(--color-red))', marginTop: 8 }}>{bad[1]} is a whole number from 0 to {bad[3]}.</div>}
          <TabSaveRow t={t} saveDisabled={!!bad} />
        </>
      ) : (
        <>
          {LIMITS.map(([k, label]) => <Row key={k} label={label} value={shown(k, data.limits?.[k])} />)}
          <div style={HINT}>The planner warns when a shift goes past one of these or the company's own rules - it never blocks.</div>
        </>
      )}
    </div>
  );
}
