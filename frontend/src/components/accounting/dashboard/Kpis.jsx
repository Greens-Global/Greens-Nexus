import { change, pctTxt } from '../../../accounting/dashboard/model/money';
import { fmtMD, mEnd } from '../../../accounting/dashboard/model/months';
import { sumLines } from '../../../accounting/dashboard/model/ledger';
import { Chip, Delta, LoadingBox } from './Bits';
import { Sparkline } from './Charts';
import { useDash } from './DashContext';
import { useHoldings, usePerf, useRecon, useRunway, useTrend } from './hooks';

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
  const { lines, m, loading } = useDash();
  const trend = useTrend();
  if (loading) return <LoadingBox height={80} />;
  const a = sumLines(lines);
  const p = sumLines(lines, () => true, 'prior');
  return <Kpi value={m(a, { compact: true })} note="vs prior month" delta={<Delta v={p ? (a - p) / Math.abs(p) : null} />} spark={trend.map((t) => t.net)} sparkColor="#0998c3" />;
}

export function KpiMarginWidget() {
  const { lines, loading } = useDash();
  if (loading) return <LoadingBox height={80} />;
  const rev = sumLines(lines, (l) => l.group === 'Revenue');
  const op = sumLines(lines, (l) => l.group !== 'Other');
  return <Kpi value={pctTxt(rev ? op / rev : 0)} note="before interest and depreciation" />;
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
  const { rows, reconciled, behind, isLoading } = useRecon();
  if (isLoading) return <LoadingBox height={80} />;
  return <Kpi value={`${reconciled} of ${rows.length}`} note={`through ${fmtMD(mEnd(period))}`} delta={behind ? <Chip tone="bad">{behind} behind</Chip> : <Chip tone="ok">On track</Chip>} />;
}

export function KpiRunwayWidget() {
  const { m, loading } = useDash();
  const { fixed, liquid, months } = useRunway();
  if (loading) return <LoadingBox height={80} />;
  return <Kpi value={fixed ? `${months.toFixed(1)} mo` : '-'} note={`${m(liquid, { compact: true })} liquid vs ${m(fixed, { compact: true })}/mo fixed`} delta={fixed ? <Chip tone={months < 6 ? 'bad' : months < 12 ? 'wait' : 'ok'}>{months < 6 ? 'Tight' : months < 12 ? 'Adequate' : 'Strong'}</Chip> : null} />;
}

export function KpiYtdWidget() {
  const { m, loading } = useDash();
  const perf = usePerf();
  if (loading || !perf) return <LoadingBox height={80} />;
  const { a, b } = perf.ytd.net;
  return <Kpi value={m(a, { compact: true })} note={`budget ${m(b, { compact: true })} year to date`} delta={<Delta v={b ? (a - b) / Math.abs(b) : null} />} />;
}
