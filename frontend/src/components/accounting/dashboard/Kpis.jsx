import { change, pctTxt } from '../../../accounting/dashboard/model/money';
import { fmtMD, mEnd } from '../../../accounting/dashboard/model/months';
import { sumLines } from '../../../accounting/dashboard/model/ledger';
import { Chip, Delta, LoadingBox } from './Bits';
import { Sparkline } from './Charts';
import { RUNWAY_TARGET_MONTHS, useDash } from './DashContext';
import { useHoldings, usePerf, useRecon, useRunway, useTrend } from './hooks';

const signed = (n, digits = 1) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(digits)}`;

// Headline-number widgets: one figure, a note, a change pill and, where a
// history exists, a sparkline.

function Kpi({ value, note, delta, spark, sparkColor }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8, height: '100%' }}>
      <div>
        <div style={{ fontSize: '1.6rem', fontWeight: 700, lineHeight: 1, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          <span>{note}</span>
          {delta}
        </div>
      </div>
      {spark && spark.length > 1 ? <Sparkline values={spark} color={sparkColor} /> : null}
    </div>
  );
}

export function KpiCashWidget() {
  const { cashSplit, m, loading } = useDash();
  const trend = useTrend();
  if (loading) return <LoadingBox height={80} />;
  const prev = trend.length > 1 ? trend[trend.length - 2].ctlCash : null;
  return <Kpi value={m(cashSplit.ctl, { compact: true })} note={cashSplit.nc ? `+ ${m(cashSplit.nc, { compact: true })} non-controllable` : `${cashSplit.ctlEntities.length} ${cashSplit.ctlEntities.length === 1 ? 'entity' : 'entities'}`} delta={<Delta v={prev ? change(cashSplit.ctl, prev) : null} suffix="vs last month" />} spark={trend.map((t) => t.ctlCash)} />;
}

export function KpiCashNcWidget() {
  const { cashSplit, m, loading } = useDash();
  if (loading) return <LoadingBox height={80} />;
  const k = cashSplit.ncEntities.length;
  return <Kpi value={m(cashSplit.nc, { compact: true })} note={k ? `${k} partner ${k > 1 ? 'entities' : 'entity'}` : 'None in this scope'} delta={<Chip tone="fyi">Not available</Chip>} />;
}

export function KpiNiWidget() {
  const { lines, m, loading, isRange, periodLabel } = useDash();
  const trend = useTrend();
  if (loading) return <LoadingBox height={80} />;
  const a = sumLines(lines);
  const p = sumLines(lines, () => true, 'prior');
  return <Kpi value={m(a, { compact: true })} note={isRange ? `${periodLabel} · vs prior period` : 'vs prior month'} delta={<Delta v={p ? (a - p) / Math.abs(p) : null} />} spark={trend.map((t) => t.net)} sparkColor="#0998c3" />;
}

export function KpiMarginWidget() {
  const { lines, loading, isRange } = useDash();
  if (loading) return <LoadingBox height={80} />;
  const rev = sumLines(lines, (l) => l.group === 'Revenue');
  const op = sumLines(lines, (l) => l.group !== 'Other');
  const margin = rev ? op / rev : 0;
  // Same margin over the preceding run of months (Priyanka, Sep 23: every card carries a comparison).
  const prevRev = sumLines(lines, (l) => l.group === 'Revenue', 'prior');
  const prevOp = sumLines(lines, (l) => l.group !== 'Other', 'prior');
  const prevMargin = prevRev ? prevOp / prevRev : null;
  const pts = prevMargin == null ? null : (margin - prevMargin) * 100;
  return <Kpi value={pctTxt(margin)} note="before interest and depreciation" delta={<Delta v={pts} text={pts == null ? undefined : `${signed(pts)} pts`} suffix={isRange ? 'vs prior period' : 'vs prior month'} />} />;
}

export function KpiInvestWidget() {
  const { m } = useDash();
  const { holdings, mv, cost, prior, isLoading } = useHoldings();
  if (isLoading) return <LoadingBox height={80} />;
  if (!holdings.length) return <Kpi value="-" note="No investment accounts in this scope" />;
  return <Kpi value={m(mv, { compact: true })} note={`Unrealized ${mv >= cost ? '+' : '-'}${m(Math.abs(mv - cost), { compact: true })}`} delta={<Delta v={prior ? (mv - prior) / prior : null} suffix="this month" />} />;
}

export function KpiReconWidget() {
  const { period } = useDash();
  const { rows, reconciled, remaining, behind, isLoading } = useRecon();
  if (isLoading) return <LoadingBox height={80} />;
  // "Reconciliations: 3/5 completed | 2 remaining" (Priyanka, Sep 24).
  return <Kpi value={`${reconciled} of ${rows.length}`} note={rows.length ? `${remaining} remaining · through ${fmtMD(mEnd(period))}` : `through ${fmtMD(mEnd(period))}`} delta={behind ? <Chip tone="bad">{behind} behind</Chip> : rows.length ? <Chip tone="ok">On track</Chip> : null} />;
}

export function KpiRunwayWidget() {
  const { m, loading } = useDash();
  const { fixed, liquid, months } = useRunway();
  if (loading) return <LoadingBox height={80} />;
  const gap = months - RUNWAY_TARGET_MONTHS;
  return (
    <Kpi value={fixed ? `${months.toFixed(1)} mo` : '-'} note={`target ${RUNWAY_TARGET_MONTHS} months · ${m(liquid, { compact: true })} liquid vs ${m(fixed, { compact: true })}/mo fixed`}
      delta={fixed ? (<>
        <Delta v={gap} text={`${signed(gap)} mo`} suffix="vs target" />
        <Chip tone={months < RUNWAY_TARGET_MONTHS ? 'bad' : months < 12 ? 'wait' : 'ok'}>{months < RUNWAY_TARGET_MONTHS ? 'Tight' : months < 12 ? 'Adequate' : 'Strong'}</Chip>
      </>) : null} />
  );
}

export function KpiYtdWidget() {
  const { m, loading } = useDash();
  const perf = usePerf();
  if (loading || !perf) return <LoadingBox height={80} />;
  const { a, b } = perf.ytd.net;
  const py = perf.ytd.prior?.net ?? null;
  // Against the budget and against the same months last year (Priyanka, Sep 23).
  return (
    <Kpi value={m(a, { compact: true })} note={`budget ${m(b, { compact: true })}${py != null ? ` · prior year ${m(py, { compact: true })}` : ''}`}
      delta={<><Delta v={b ? (a - b) / Math.abs(b) : null} suffix="vs budget" /><Delta v={py ? (a - py) / Math.abs(py) : null} suffix="vs prior year" /></>} />
  );
}
