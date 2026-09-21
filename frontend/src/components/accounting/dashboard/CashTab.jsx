import { useMemo, useState } from 'react';
import { CASH_CATS, cashPlan, SCENARIOS } from '../../../accounting/dashboard/model/cash-plan';
import { monthLabel, monthLong, mShort } from '../../../accounting/dashboard/model/months';
import { pctTxt } from '../../../accounting/dashboard/model/money';
import { Chip, Dot, EmptyBox, Footnote, LoadingBox, Panel, SectionTabs, Tile, num, pill, toneColor } from './Bits';
import { AreaTrend } from './Charts';
import { useDash } from './DashContext';
import { Toolbar } from './Filters';
import { useCashPlan, useHoldings, useLoans, useRunway } from './hooks';
import { WidgetPanel } from './registry';

// Cash tab: consolidated cash position, the monthly cash plan by category
// (twelve actual months, six forecast), scenario chart, forecast accuracy,
// and the cash widgets. One section at a time; the tiles stay on top.

const SECTIONS = [
  { id: 'position', label: 'Position' },
  { id: 'plan', label: 'Cash Plan' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'entities', label: 'Entities & Investments' },
];

export default function CashTab() {
  const { m, cashSplit, scenarioId, setScenario, loading, ledger, period } = useDash();
  const { loans } = useLoans();
  const { mv } = useHoldings();
  const { fixed, months: run } = useRunway();
  const plan = useCashPlan();
  const S = SCENARIOS[scenarioId];
  const debt = loans.reduce((t, l) => t + l.balance, 0);
  const [section, setSection] = useState('position');

  const band = useMemo(() => (ledger ? { down: cashPlan(ledger, loans, period, SCENARIOS.down), up: cashPlan(ledger, loans, period, SCENARIOS.up) } : null), [ledger, loans, period]);
  const chart = useMemo(() => {
    if (!plan || !band) return [];
    const hist = plan.hist.map((h) => ({ label: monthLabel(h.k), actual: h.end, forecast: null, down: null, up: null }));
    if (hist.length) { const last = hist[hist.length - 1]; last.forecast = last.actual; last.down = last.actual; last.up = last.actual; }
    const fc = plan.fc.map((f, i) => ({ label: monthLabel(f.k), actual: null, forecast: f.end, down: band.down.fc[i]?.end ?? null, up: band.up.fc[i]?.end ?? null }));
    return [...hist, ...fc];
  }, [plan, band]);
  const last = plan?.last;
  const six = plan ? plan.fc[5] : null;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 14 };
  const half = { gridColumn: 'span 12' };
  const halfWide = typeof window !== 'undefined' && window.innerWidth >= 1000 ? { gridColumn: 'span 6' } : half;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Toolbar right={
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }} aria-label="Scenario">
          {Object.values(SCENARIOS).map((s) => <button key={s.id} type="button" style={{ ...pill(scenarioId === s.id), padding: '4px 10px', fontSize: '0.74rem' }} onClick={() => setScenario(s.id)} title={s.note}>{s.name}</button>)}
        </div>
      } />
      {loading || !plan ? <LoadingBox height={84} /> : (
        <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Tile label="Cash on hand" value={m(cashSplit.ctl, { compact: true })} sub={cashSplit.nc ? `+ ${m(cashSplit.nc, { compact: true })} non-controllable` : 'controllable'} />
          <Tile label="Investments" value={m(mv, { compact: true })} sub="stocks and bonds" />
          <Tile label="Net debt" value={m(debt - cashSplit.ctl - mv, { compact: true })} sub="debt less cash and investments" />
          <Tile label="Runway" value={fixed ? `${run.toFixed(1)} mo` : '-'} sub="vs fixed obligations" />
          <Tile label="Total cash in 6 months" value={six ? m(six.end, { compact: true }) : '-'} sub={six && last ? `${S.name} · ${six.end >= last.end ? '+' : ''}${m(six.end - last.end, { compact: true })} vs today` : undefined} subColor={six && last ? toneColor(six.end >= last.end) : undefined} />
        </div>
      )}
      <SectionTabs tabs={SECTIONS} value={section} onChange={setSection} />

      {section === 'position' ? (
        <Panel title="Total cash - 12 months actual, 6 months forecast" right={<Chip>{S.name}: {S.note}</Chip>}>
          {loading || !plan ? <LoadingBox /> : chart.length < 2 ? <EmptyBox title="Not enough history for a forecast" /> : (
            <>
              <AreaTrend data={chart} height={230} zero={false} series={[
                { key: 'up', label: 'Upside', color: '#8a9a9f', dashed: true },
                { key: 'down', label: 'Downside', color: '#8a9a9f', dashed: true },
                { key: 'actual', label: 'Actual month-end cash', color: 'var(--wk-brand, #2b45e1)' },
                { key: 'forecast', label: `${S.name} forecast`, color: '#0998c3', dashed: true },
              ]} />
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--wk-brand, #2b45e1)" />Actual month-end cash (all bank accounts in scope)</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="#0998c3" />{S.name} forecast</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="#8a9a9f" />Downside to upside range</span>
              </div>
            </>
          )}
        </Panel>
      ) : null}

      {section === 'plan' ? (
        <Panel title="Cash plan by category" sub={`Six months actual · six months ${S.name.toLowerCase()} forecast (shaded)`} bodyStyle={{ padding: 0, overflowX: 'auto' }}>
          {loading || !plan ? <LoadingBox /> : <PlanTable hist={plan.hist.slice(-6)} fc={plan.fc} />}
        </Panel>
      ) : null}

      {section === 'forecast' ? (
        <div style={grid}>
          <div style={half}><WidgetPanel id="cashForecast" /></div>
          <Panel title={`Forecast accuracy - ${last ? monthLong(last.k) : ''}`} style={halfWide}>{loading || !plan || !last ? <LoadingBox /> : <Accuracy last={last} fcLast={plan.fcLast} />}</Panel>
          <div style={halfWide}><WidgetPanel id="maturity" style={{ height: '100%' }} /></div>
        </div>
      ) : null}

      {section === 'entities' ? (
        <div style={grid}>
          <div style={halfWide}><WidgetPanel id="entityCash" style={{ height: '100%' }} /></div>
          <div style={halfWide}><WidgetPanel id="invest" style={{ height: '100%' }} /></div>
          <div style={half}><WidgetPanel id="debt" /></div>
        </div>
      ) : null}
    </div>
  );
}

function PlanTable({ hist, fc }) {
  const { m } = useDash();
  const cols = [...hist, ...fc];
  if (!cols.length) return <EmptyBox title="No months to plan" style={{ margin: 16 }} />;
  const cell = (v) => (v == null ? '-' : v ? m(v, { compact: true, paren: true }) : '-');
  const total = (dir, c) => CASH_CATS.filter((x) => x.dir === dir).reduce((t, x) => t + c.v[x.id], 0);
  const net = (c) => CASH_CATS.reduce((t, x) => t + c.v[x.id], 0) + c.v.other;
  const head = (label) => <tr style={{ background: 'var(--bg-secondary)' }}><td colSpan={cols.length + 1} style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '6px 10px' }}>{label}</td></tr>;
  const row = (label, f, o = {}) => (
    <tr key={label} style={o.strong ? { fontWeight: 700, borderTop: '1px solid var(--border-color)' } : undefined}>
      <td style={{ position: 'sticky', left: 0, background: 'var(--bg-card)', color: o.muted ? 'var(--text-muted)' : undefined, paddingLeft: !o.strong && !o.muted ? 20 : undefined }}>{label}</td>
      {cols.map((c) => { const v = f(c); return <td key={c.k} style={{ ...num, background: !c.actual ? 'var(--bg-secondary)' : undefined, color: o.signed && v != null ? toneColor(v >= 0) : undefined }}>{cell(v)}</td>; })}
    </tr>
  );
  return (
    <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
      <thead><tr><th style={{ position: 'sticky', left: 0, background: 'var(--bg-card)' }}>Category</th>{cols.map((c) => <th key={c.k} style={{ ...num, background: !c.actual ? 'var(--bg-secondary)' : undefined }}>{mShort(c.k)}{!c.actual ? <div style={{ fontSize: '0.6rem', fontWeight: 500, color: 'var(--text-muted)' }}>forecast</div> : null}</th>)}</tr></thead>
      <tbody>
        {row('Opening cash', (c) => c.beg, { strong: true })}
        {head('Cash in')}
        {CASH_CATS.filter((x) => x.dir === 'in').map((x) => row(x.label, (c) => c.v[x.id]))}
        {row('Total cash in', (c) => total('in', c), { strong: true })}
        {head('Cash out')}
        {CASH_CATS.filter((x) => x.dir === 'out').map((x) => row(x.label, (c) => c.v[x.id]))}
        {row('Total cash out', (c) => total('out', c), { strong: true })}
        {row('Timing and other', (c) => c.v.other, { muted: true })}
        {row('Net cash flow', net, { strong: true, signed: true })}
        {row('Ending cash', (c) => c.end, { strong: true })}
      </tbody>
      <tfoot><tr><td colSpan={cols.length + 1}><Footnote style={{ padding: '0 10px 10px' }}>Actual months come from the ledger and month-end bank balances for every account in scope, including non-controllable entities; "Timing and other" is the difference between ledger activity and the bank movement (accruals, deposits in transit, working capital). Forecast months apply the scenario to the trailing three-month run rate.</Footnote></td></tr></tfoot>
    </table>
  );
}

function Accuracy({ last, fcLast }) {
  const { m } = useDash();
  const rows = CASH_CATS.map((c) => { const f = fcLast[c.id] ?? 0; const a = last.v[c.id]; return { ...c, f, a, v: a - f }; }).sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
  const sumV = rows.reduce((t, r) => t + r.v, 0);
  const sumA = rows.reduce((t, r) => t + r.a, 0);
  return (
    <div>
      <div className="req-table-wrapper">
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th>Category</th><th style={num}>Forecast</th><th style={num}>Actual</th><th style={num}>Variance</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.id}><td>{r.label}</td><td style={{ ...num, color: 'var(--text-muted)' }}>{m(r.f, { compact: true, paren: true })}</td><td style={num}>{m(r.a, { compact: true, paren: true })}</td><td style={{ ...num, fontWeight: 600, color: toneColor(r.v >= 0) }}>{m(r.v, { compact: true, paren: true })}</td></tr>)}
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border-color)' }}><td>Net</td><td style={num}>{m(rows.reduce((t, r) => t + r.f, 0), { compact: true, paren: true })}</td><td style={num}>{m(sumA, { compact: true, paren: true })}</td><td style={{ ...num, color: toneColor(sumV >= 0) }}>{m(sumV, { compact: true, paren: true })}</td></tr>
          </tbody>
        </table>
      </div>
      <Footnote>Forecast is what the plan showed for this month one month earlier. Accuracy {pctTxt(1 - Math.abs(sumV) / (Math.abs(sumA) || 1), 0)}.</Footnote>
    </div>
  );
}
