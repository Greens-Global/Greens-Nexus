// The Program table (Round Two, 11/05/2026): every job the person may see,
// one row each - the owner-builder's view, the same facility built many times,
// compared. It reads what the dashboard already holds (the overview rows with
// their health, and the money flags for managers with Accounting access) - no
// second read. Columns resize and the widths are kept per person; a row opens
// its job. Computers only - phones keep the cards.
import { useRef, useState } from 'react';
import { StatusLabel } from '../components/StatusLabel';
import { ColumnResizer } from '../components/accounting/reportControls';
import { cellStyle, headStyle } from '../components/accounting/columnStyles';
import { useTableValue } from '../tasks/tableCols';
import { formatDate } from '../lib/datetime';
import { HEALTH, daysWords, lastLogWords } from './lib/health';
import { JOB_TYPE } from './lib/job';
import { usd } from './lib/money';

const COLS = [
  { key: 'name', label: 'Job', width: 240 },
  { key: 'type', label: 'Type', width: 100 },
  { key: 'health', label: 'Health', width: 100 },
  { key: 'pct', label: '% Complete', width: 100, num: true },
  { key: 'target', label: 'Target Finish', width: 190 },
  { key: 'milestone', label: 'Next Milestone', width: 200 },
  { key: 'rfis', label: 'Overdue RFIs', width: 110, num: true },
  { key: 'inspection', label: 'Next Inspection', width: 190 },
  { key: 'log', label: 'Last Daily Log', width: 140 },
];
// Money shows only when the server gave this reader figures (managers with
// Accounting access to the job's entity, /construction/money/flags).
const MONEY = [
  { key: 'budget', label: 'Budget', width: 120, num: true },
  { key: 'actual', label: 'Actual to Date', width: 130, num: true },
  { key: 'forecast', label: 'Forecast', width: 120, num: true },
  { key: 'perSqFt', label: 'Cost / Sq Ft', width: 110, num: true },
  { key: 'perUnit', label: 'Cost / Unit', width: 110, num: true },
];
const clamp = (w) => Math.min(1200, Math.max(60, Math.round(Number(w) || 0)));

// Widths kept per person with the shared table preferences (tasks/tableCols).
function useWidths(cols) {
  const [saved, setSaved] = useTableValue('construction-program', 'colWidths', {});
  const [live, setLive] = useState(null);
  const liveRef = useRef(null);
  const width = (k) => (live?.key === k ? live.w : Number(saved?.[k]) || cols.find((c) => c.key === k)?.width);
  const resizer = (c) => ({
    label: `Resize the ${c.label} column`,
    onDrag: (w) => { liveRef.current = { key: c.key, w: clamp(w) }; setLive(liveRef.current); },
    onEnd: () => {
      const l = liveRef.current;
      liveRef.current = null;
      setLive(null);
      if (l) setSaved({ ...(saved || {}), [l.key]: l.w });
    },
    onFit: (w) => {
      const next = { ...(saved || {}) };
      if (w > 0) next[c.key] = clamp(w); else delete next[c.key];
      setSaved(next);
    },
  });
  return { width, resizer };
}

const dayGap = (fromISO, toISO) => {
  const a = Date.parse(`${String(fromISO || '').slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toISO || '').slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86400000);
};
const money = (v) => (v == null ? '-' : usd(v));
const red = { color: 'hsl(var(--color-red))', fontWeight: 600 };

export default function ProgramTable({ projects, flags = {}, onOpen }) {
  const withMoney = Object.values(flags || {}).some((f) => f && f.budget != null);
  const cols = withMoney ? [...COLS, ...MONEY] : COLS;
  const { width, resizer } = useWidths(cols);
  return (
    <div className="acct-module">
      <div className="acct-report-wrap" style={{ background: 'var(--bg-card)', maxHeight: 'none' }}>
        <table className="acct-report" aria-label="Program" data-program-table="" style={{ width: '100%' }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} scope="col" className={c.num ? 'acct-num' : undefined} style={headStyle(width(c.key))}>
                  {c.label}<ColumnResizer {...resizer(c)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const h = p.health || {};
              const f = flags?.[p.id] || {};
              const meta = HEALTH[h.state] || HEALTH.on_track;
              const days = p.targetFinishOn ? dayGap(p.today, p.targetFinishOn) : null;
              const moves = (p.targetMoves || []).length;
              const cell = (k, body, extra = null) => (
                <td key={k} className={cols.find((c) => c.key === k)?.num ? 'acct-num' : undefined} style={cellStyle(width(k), extra)}>{body}</td>
              );
              const cells = {
                name: <b>{p.name}</b>,
                type: (JOB_TYPE[p.jobType] || JOB_TYPE.project).label,
                health: <StatusLabel size="sm" label={meta.label} color={meta.color} />,
                pct: `${Math.round(p.percentComplete || 0)}%`,
                target: p.targetFinishOn ? (
                  <>
                    {formatDate(p.targetFinishOn, p.targetFinishOn)}
                    {days != null && h.state !== 'complete' && <span style={days < 0 ? { ...red, marginLeft: 6 } : { color: 'var(--text-secondary)', marginLeft: 6 }}>{days < 0 ? `${-days} day${days === -1 ? '' : 's'} past` : daysWords(days)}</span>}
                    {moves > 0 && <span title={(p.targetMoves || []).map((m) => `${formatDate(m.at, m.at)}: ${m.reason}`).join('\n')} style={{ color: 'var(--text-secondary)', marginLeft: 6 }}>moved {moves}x</span>}
                  </>
                ) : '-',
                milestone: h.nextMilestone ? `${h.nextMilestone.name || 'Milestone'} ${formatDate(h.nextMilestone.targetDate, h.nextMilestone.targetDate)}` : '-',
                rfis: h.overdueRfis > 0 ? <span style={red}>{h.overdueRfis}</span> : '-',
                inspection: p.nextInspection ? `${p.nextInspection.title} ${formatDate(p.nextInspection.dueOn, p.nextInspection.dueOn)}` : '-',
                log: lastLogWords(h),
                budget: money(f.budget),
                actual: money(f.actual),
                forecast: money(f.forecast),
                perSqFt: f.forecast != null && p.squareFeet > 0 ? usd(Math.round((f.forecast / p.squareFeet) * 100) / 100) : '-',
                perUnit: f.forecast != null && p.units > 0 ? usd(Math.round(f.forecast / p.units)) : '-',
              };
              return (
                <tr key={p.id} data-program-row={p.id} tabIndex={0} style={{ cursor: 'pointer' }}
                  onClick={() => onOpen(p.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p.id); } }}>
                  {cols.map((c) => cell(c.key, cells[c.key]))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {withMoney && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 8 }}>Budget is the contract value plus approved changes; Actual is posted to the job's Project-Job in the books; Forecast, Cost / Sq Ft and Cost / Unit are worked out. Open a job's Money tab for the ledger lines.</div>}
    </div>
  );
}
