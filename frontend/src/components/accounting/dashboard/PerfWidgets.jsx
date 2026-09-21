import { useMemo } from 'react';
import { incomeStatement, isPl, isRevenue, plGroup } from '../../../accounting/dashboard/model/ledger';
import { monthLabel, monthsBetween, mShort, shiftKey } from '../../../accounting/dashboard/model/months';
import { pctTxt } from '../../../accounting/dashboard/model/money';
import { Dot, EmptyBox, Eyebrow, Footnote, LoadingBox, Meter, mono, num, seriesColor, toneColor } from './Bits';
import { Bars, Donut } from './Charts';
import { useDash } from './DashContext';
import { usePerf, useTrend } from './hooks';

// Performance widgets: revenue vs expense bars, NOI by entity, budget
// variances (month and year to date), and the income / expense breakdowns.

export function RevExpWidget() {
  const { loading } = useDash();
  const trend = useTrend();
  if (loading) return <LoadingBox />;
  const data = trend.slice(-6).map((t) => ({ label: monthLabel(t.month), revenue: Math.round(t.revenue), expense: Math.round(t.expense) }));
  if (!data.length) return <EmptyBox title="No activity in this period" />;
  return (
    <div>
      <Bars data={data} series={[{ key: 'revenue', label: 'Revenue', color: 'var(--wk-brand, #2b45e1)' }, { key: 'expense', label: 'Expense', color: '#d97706' }]} height={170} />
      <div style={{ marginTop: 8, display: 'flex', gap: 16, fontSize: '0.7rem', color: 'var(--text-muted)' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="var(--wk-brand, #2b45e1)" />Revenue</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="#d97706" />Expense</span></div>
    </div>
  );
}

export function NoiPropWidget() {
  const { noiRows, m, loading } = useDash();
  if (loading) return <LoadingBox />;
  const rows = noiRows.filter((r) => r.revenue > 0);
  if (!rows.length) return <EmptyBox title="No operating entities in this scope" body="Entities with revenue this month appear here with their NOI." />;
  const mx = Math.max(...rows.map((r) => Math.abs(r.noi)), 1);
  const total = rows.reduce((t, r) => t + r.noi, 0);
  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><Eyebrow>Total NOI</Eyebrow><span style={{ fontSize: '1.05rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: toneColor(total >= 0) }}>{m(total)}</span></div>
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.slice(0, 10).map((r) => (
          <div key={r.code} style={{ fontSize: '0.84rem', color: r.isPartner ? 'var(--text-muted)' : 'inherit' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}{r.assetType ? <span style={{ marginLeft: 6, fontSize: '0.7rem', color: 'var(--text-muted)' }}>{r.assetType}</span> : null}</span>
              <span style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 8, fontVariantNumeric: 'tabular-nums' }}><span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{r.revenue ? pctTxt(r.noi / r.revenue, 0) : '-'} margin</span><span style={{ fontWeight: 600, color: toneColor(r.noi >= 0) }}>{m(r.noi, { compact: true })}</span></span>
            </div>
            <Meter height={6} style={{ marginTop: 4 }} segments={[{ share: Math.abs(r.noi) / mx, color: r.noi >= 0 ? 'var(--wk-brand, #2b45e1)' : '#dc2626' }]} />
          </div>
        ))}
      </div>
      {rows.length > 10 ? <Footnote>Top 10 of {rows.length} entities by NOI.</Footnote> : null}
    </div>
  );
}

export function VarianceWidget() {
  const { m, loading } = useDash();
  const perf = usePerf();
  if (loading || !perf) return <LoadingBox />;
  const rows = perf.variances.filter((v) => v.budget).slice(0, 6);
  if (!rows.length) return <EmptyBox title="No budget for this month" body="Post a budget journal in Nexus Accounting covering this month to see variances." />;
  return (
    <div className="req-table-wrapper">
      <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr><th>Account</th><th style={num}>Actual</th><th style={num}>Budget</th><th style={num}>Variance</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><span style={mono}>{r.gl}</span>{r.name}</td>
              <td style={num}>{m(r.actual, { paren: true })}</td>
              <td style={{ ...num, color: 'var(--text-muted)' }}>{m(r.budget, { paren: true })}</td>
              <td style={{ ...num, fontWeight: 600, color: toneColor(r.good) }}>{m(r.v, { paren: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function YtdVarianceWidget() {
  const { m, loading } = useDash();
  const perf = usePerf();
  if (loading || !perf) return <LoadingBox />;
  const y = perf.ytd;
  if (!y.lines.length) return <EmptyBox title="No activity this year" />;
  const hasBudget = y.lines.some((l) => l.budget);
  const row = (label, a, b, up = true) => {
    const v = a - b;
    const good = up ? v >= 0 : v <= 0;
    return (
      <tr key={label} style={label === 'Net income' ? { fontWeight: 700, borderTop: '2px solid var(--border-color)' } : undefined}>
        <td>{label}</td>
        <td style={num}>{m(a, { paren: true })}</td>
        <td style={{ ...num, color: 'var(--text-muted)' }}>{hasBudget ? m(b, { paren: true }) : '-'}</td>
        <td style={{ ...num, color: hasBudget ? toneColor(good) : undefined }}>{hasBudget ? m(v, { paren: true }) : '-'}</td>
        <td style={{ ...num, fontSize: '0.76rem', color: hasBudget ? toneColor(good) : undefined }}>{hasBudget && b ? pctTxt(v / Math.abs(b)) : '-'}</td>
      </tr>
    );
  };
  return (
    <div>
      <div className="req-table-wrapper">
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th /><th style={num}>Actual</th><th style={num}>Budget</th><th style={num}>Variance</th><th style={num}>%</th></tr></thead>
          <tbody>{row('Revenue', y.revenue.a, y.revenue.b)}{row('Expenses', -y.expense.a, -y.expense.b, false)}{row('Net income', y.net.a, y.net.b)}</tbody>
        </table>
      </div>
      {hasBudget ? (
        <div style={{ marginTop: 12 }}>
          <Eyebrow>Largest variances</Eyebrow>
          <div style={{ marginTop: 4 }}>
            {y.largest.map((l, i) => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: '0.84rem', borderTop: i ? '1px solid var(--border-color)' : 'none' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={mono}>{l.gl}</span>{l.name}</span><span style={{ flexShrink: 0, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: toneColor(l.v >= 0) }}>{m(l.v, { paren: true })}</span></div>
            ))}
          </div>
        </div>
      ) : <Footnote>No budget journal covers this year yet, so only actuals are shown.</Footnote>}
    </div>
  );
}

function useBreakdown(kind) {
  const { ledger, period } = useDash();
  return useMemo(() => {
    if (!ledger) return null;
    const pick = (ls) => (kind === 'income' ? ls.filter((l) => l.actual > 0) : ls.filter((l) => l.actual < 0));
    const cur = incomeStatement(ledger, period);
    const pk = shiftKey(period, 1);
    const prevMap = new Map(ledger.months.includes(pk) ? incomeStatement(ledger, pk).map((l) => [l.id, l.actual]) : []);
    const rows = pick(cur).map((l) => ({ ...l, amt: Math.abs(l.actual), prev: Math.abs(prevMap.get(l.id) ?? 0) })).sort((a, b) => b.amt - a.amt);
    const tot = rows.reduce((t, r) => t + r.amt, 0);
    const ptot = rows.reduce((t, r) => t + r.prev, 0);
    const keys = monthsBetween(shiftKey(period, 5), period).filter((k) => ledger.months.includes(k));
    const top = rows.slice(0, 6);
    const trend = keys.map((k) => {
      const ls = new Map(incomeStatement(ledger, k).map((l) => [l.id, Math.abs(l.actual)]));
      const o = { label: monthLabel(k) };
      let other = 0;
      for (const [id, v] of ls.entries()) { const a = ledger.accounts.get(id); if (!a || !isPl(a)) continue; if ((kind === 'income') !== isRevenue(a)) continue; if (!top.some((t) => t.id === id)) other += v; }
      for (const t of top) o[t.id] = ls.get(t.id) ?? 0;
      o.other = other;
      return o;
    });
    return { rows, tot, ptot, ch: ptot ? (tot - ptot) / ptot : null, top, trend, pk: ledger.months.includes(pk) ? pk : null };
  }, [ledger, period, kind]);
}

function Breakdown({ kind }) {
  const { m, period, noiRows } = useDash();
  const d = useBreakdown(kind);
  if (!d) return <LoadingBox />;
  if (!d.rows.length) return <EmptyBox title={kind === 'income' ? 'No income for this scope and month.' : 'No expenses for this scope and month.'} />;
  const inc = kind === 'income';
  const chGood = d.ch == null ? true : inc ? d.ch >= 0 : d.ch <= 0;
  const mx = d.rows[0].amt || 1;
  const groups = ['Cost of Revenue', 'Operating Expenses', 'Other'].map((g) => ({ g: g === 'Other' ? 'Interest & Depreciation' : g, v: d.rows.filter((r) => plGroup(r.account) === g).reduce((t, r) => t + r.amt, 0) })).filter((x) => x.v > 0);
  const diffCell = (cur, prev) => {
    if (!prev) return <td style={{ ...num, color: 'var(--text-muted)' }}>-</td>;
    const diff = cur - prev;
    return <td style={{ ...num, color: toneColor(inc ? diff >= 0 : diff <= 0) }}>{`${diff >= 0 ? '+' : '-'}${m(Math.abs(diff))}`}</td>;
  };
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
        <Donut rows={d.rows.slice(0, 8).map((r, i) => ({ name: r.name, value: r.amt, color: seriesColor(i) }))} total={d.tot} label={inc ? 'Total income' : 'Total expenses'}
          sub={d.ch == null ? undefined : `${d.ch >= 0 ? '▲' : '▼'} ${pctTxt(Math.abs(d.ch))} vs ${d.pk ? monthLabel(d.pk) : 'prior'}`} subColor={toneColor(chGood)} />
        <div style={{ minWidth: 0, flex: 1 }}>
          {inc ? (
            <>
              <Eyebrow>Six-month trend</Eyebrow>
              <Bars data={d.trend} series={[...d.top.map((t, i) => ({ key: t.id, label: t.name, color: seriesColor(i) })), { key: 'other', label: 'Other', color: '#b9c4c7' }]} stacked height={150} />
            </>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {groups.map((g) => <div key={g.g} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem' }}><span>{g.g}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}><span style={{ fontWeight: 600 }}>{m(g.v)}</span><span style={{ marginLeft: 8, fontSize: '0.7rem', color: 'var(--text-muted)' }}>{pctTxt(g.v / d.tot, 0)}</span></span></div>)}
            </div>
          )}
        </div>
      </div>
      <div className="req-table-wrapper">
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th>{inc ? 'Income source' : 'Expense'}</th><th style={{ width: 110 }} /><th style={num}>{mShort(period)}</th><th style={num}>% of total</th><th style={num}>{d.pk ? mShort(d.pk) : 'Prior'}</th><th style={num}>Change</th></tr></thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={r.id}>
                <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginRight: 6 }}><Dot color={seriesColor(i)} /><span style={{ ...mono, marginRight: 0 }}>{r.gl}</span></span>{r.name}</td>
                <td><Meter height={6} segments={[{ share: r.amt / mx, color: seriesColor(i) }]} /></td>
                <td style={num}>{m(r.amt)}</td>
                <td style={{ ...num, fontSize: '0.76rem', color: 'var(--text-muted)' }}>{pctTxt(r.amt / d.tot, 0)}</td>
                <td style={{ ...num, color: 'var(--text-muted)' }}>{r.prev ? m(r.prev) : '-'}</td>
                {diffCell(r.amt, r.prev)}
              </tr>
            ))}
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border-color)' }}><td>{inc ? 'Total income' : 'Total expenses'}</td><td /><td style={num}>{m(d.tot)}</td><td /><td style={num}>{d.ptot ? m(d.ptot) : '-'}</td>{diffCell(d.tot, d.ptot)}</tr>
          </tbody>
        </table>
      </div>
      {inc && noiRows.length ? (
        <div>
          <Eyebrow>Income by entity</Eyebrow>
          <Meter height={10} style={{ marginTop: 6 }} segments={noiRows.filter((r) => r.revenue > 0).map((r, i) => ({ share: d.tot ? r.revenue / d.tot : 0, color: seriesColor(i), title: `${r.name}: ${m(r.revenue)}` }))} />
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {noiRows.filter((r) => r.revenue > 0).slice(0, 8).map((r, i) => <span key={r.code} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color={seriesColor(i)} />{r.name} <span style={{ fontVariantNumeric: 'tabular-nums' }}>{m(r.revenue, { compact: true })}</span></span>)}
          </div>
        </div>
      ) : null}
      <Footnote>{inc ? 'Entity figures are revenue posted against each Intacct location; income with no location is corporate.' : 'Includes cost of revenue, operating expenses, interest and depreciation. Increases show in red.'}</Footnote>
    </div>
  );
}

export const IncomeWidget = () => <Breakdown kind="income" />;
export const ExpensesWidget = () => <Breakdown kind="expenses" />;
