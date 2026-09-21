import { fmtMDY, fmtNumMD, monthLabel } from '../../../accounting/dashboard/model/months';
import { holdingClass } from '../../../accounting/dashboard/model/capital';
import { pctTxt } from '../../../accounting/dashboard/model/money';
import { BAD, Chip, Delta, Dot, EmptyBox, Eyebrow, Footnote, LoadingBox, Meter, mono, num, seriesColor, toneColor } from './Bits';
import { AreaTrend, Lines } from './Charts';
import { useDash } from './DashContext';
import { useFeed, useForecast13, useHoldings, useTrend } from './hooks';

// Cash and banking widgets: investment portfolio, cash trend, cash by
// entity, bank lines to code, and the 13-week forecast.

export function InvestWidget() {
  const { m, cashSplit } = useDash();
  const { holdings, mv, cost, prior, isLoading } = useHoldings();
  if (isLoading) return <LoadingBox />;
  if (!holdings.length) return <EmptyBox title="No investment accounts in this scope" body="Add brokerage and money-market holdings under the Data tab." />;
  const groups = ['Stocks', 'Bonds'].map((g, i) => {
    const hs = holdings.filter((h) => holdingClass(h.asset_class) === g);
    const gmv = hs.reduce((t, h) => t + h.market_value, 0);
    return { g, color: seriesColor(i), mv: gmv, cost: hs.reduce((t, h) => t + h.cost, 0), prior: hs.reduce((t, h) => t + h.prior_value, 0), share: mv ? gmv / mv : 0 };
  }).filter((x) => x.mv > 0);
  const stat = (label, value, color) => (<div><Eyebrow>{label}</Eyebrow><div style={{ marginTop: 4, fontSize: '1.05rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color }}>{value}</div></div>);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {stat('Total market value', m(mv))}
        {stat('Month', <Delta v={prior ? (mv - prior) / prior : null} style={{ fontSize: '1rem' }} />)}
        {stat('Unrealized gain', m(mv - cost, { paren: true }), toneColor(mv - cost >= 0))}
        {stat('Controllable cash + investments', m(cashSplit.ctl + mv, { compact: true }))}
      </div>
      <Meter segments={groups.map((g) => ({ share: g.share, color: g.color, title: `${g.g}: ${m(g.mv)}` }))} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {groups.map((g) => (
          <div key={g.g} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.86rem', fontWeight: 600 }}><Dot color={g.color} />{g.g}</span><span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{pctTxt(g.share, 0)} of total</span></div>
            <div style={{ marginTop: 4, fontSize: '1.05rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{m(g.mv)}</div>
            <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              <span>Unrealized <span style={{ color: toneColor(g.mv - g.cost >= 0) }}>{m(g.mv - g.cost, { paren: true })}</span></span>
              <Delta v={g.prior ? (g.mv - g.prior) / g.prior : null} />
            </div>
          </div>
        ))}
      </div>
      <Footnote>Bonds include Treasury funds and money market funds. Market values come from the brokerage; the ledger carries book value until the month-end adjustment.</Footnote>
    </div>
  );
}

export function CashTrendWidget() {
  const { loading, scope } = useDash();
  const trend = useTrend();
  if (loading) return <LoadingBox />;
  const last12 = trend.slice(-12);
  if (last12.length < 2) return <EmptyBox title="Not enough history for this period." />;
  const hasNc = last12.some((t) => t.ncCash > 0);
  const hasCtl = last12.some((t) => t.ctlCash > 0);
  const data = last12.map((t) => ({ label: monthLabel(t.month), ctl: Math.round(t.ctlCash), total: Math.round(t.cash), nc: Math.round(t.ncCash) }));
  const series = hasCtl
    ? [{ key: 'ctl', label: 'Controllable', color: 'var(--wk-brand, #2b45e1)' }, ...(hasNc && scope === 'ALL' ? [{ key: 'total', label: 'Total incl. non-controllable (FYI)', color: '#8a9a9f', dashed: true }] : [])]
    : [{ key: 'nc', label: 'Non-controllable only (FYI)', color: '#8a9a9f' }];
  return (
    <div>
      <AreaTrend data={data} series={series} height={170} />
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
        {series.map((s) => <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color={s.color} />{s.label}</span>)}
      </div>
    </div>
  );
}

export function EntityCashWidget() {
  const { cashSplit, m, loading, ix } = useDash();
  if (loading) return <LoadingBox />;
  const { ctl, nc, ctlEntities, ncEntities } = cashSplit;
  if (!ctlEntities.length && !ncEntities.length) return <EmptyBox title="No cash accounts in this scope" />;
  const row = (e, i, base, muted) => (
    <div key={e.code} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0', fontSize: '0.84rem', color: muted ? 'var(--text-muted)' : 'inherit', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
      <span style={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: 8 }}>
        {!muted ? <Dot color={seriesColor(i)} /> : <span style={{ width: 10, height: 10, borderRadius: 3, border: '1px dashed var(--text-muted)' }} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name || ix.byCode.get(e.code)?.name || e.code || 'No entity'}</span>
        {e.partners ? <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>· {e.partners}</span> : null}
      </span>
      <span style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 12, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{base ? pctTxt(e.balance / base, 0) : '-'}</span>
        <span style={{ fontWeight: 600 }}>{m(e.balance, { compact: true })}</span>
      </span>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {ctlEntities.length ? (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><Eyebrow>Controllable</Eyebrow><span style={{ fontSize: '1rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{m(ctl)}</span></div>
          <Meter style={{ margin: '8px 0' }} segments={ctlEntities.map((e, i) => ({ share: ctl ? e.balance / ctl : 0, color: seriesColor(i), title: `${e.name || e.code}: ${m(e.balance)}` }))} />
          <div>{ctlEntities.map((e, i) => row(e, i, ctl))}</div>
        </div>
      ) : null}
      {ncEntities.length ? (
        <div style={{ borderTop: ctlEntities.length ? '1px dashed var(--border-color)' : 'none', paddingTop: ctlEntities.length ? 12 : 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Eyebrow>Non-controllable</Eyebrow><Chip tone="fyi">FYI</Chip></span><span style={{ fontSize: '1rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{m(nc)}</span></div>
          <div>{ncEntities.map((e, i) => row(e, i, nc, true))}</div>
        </div>
      ) : null}
      {ctlEntities.length && ncEntities.length ? <Footnote>Non-controllable cash sits in entities with outside investors or partners and is not available for general use.</Footnote> : null}
    </div>
  );
}

export function UncatWidget({ onOpenBanks }) {
  const { m } = useDash();
  const { feed, isLoading } = useFeed();
  if (isLoading) return <LoadingBox />;
  if (!feed || !feed.lines?.length) return <EmptyBox title="Every imported bank line has a GL account" body="New feed lines that need coding show up here with the matcher's suggestion." />;
  return (
    <div>
      <div className="req-table-wrapper">
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th>Date</th><th>Description</th><th style={num}>Amount</th><th>Suggested account</th></tr></thead>
          <tbody>
            {feed.lines.map((l) => (
              <tr key={l.id}>
                <td style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{fmtNumMD(l.txn_date)}</td>
                <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.description}>{l.description}</td>
                <td style={{ ...num, color: l.amount > 0 ? toneColor(true) : undefined }}>{m(l.amount, { cents: true })}</td>
                <td>{l.suggested ? <Chip><span style={{ fontFamily: 'monospace' }}>{l.suggested.gl_code}</span>&nbsp;{l.suggested.account_name}</Chip> : <Chip tone="bad">Needs review</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        <span>{feed.total} line{feed.total === 1 ? '' : 's'} waiting</span>
        {onOpenBanks ? <button type="button" onClick={onOpenBanks} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 600, color: 'var(--wk-brand, #2b45e1)' }}>Code them in Nexus Accounting →</button> : null}
      </div>
    </div>
  );
}

export function CashForecastWidget() {
  const { m, cashSplit, loading } = useDash();
  const f = useForecast13();
  if (loading) return <LoadingBox />;
  if (!cashSplit.ctlEntities.length) return <EmptyBox title="No controllable cash in this scope" body="Choose All Entities, Controllable Entities Only, or one of your companies." />;
  const low = Math.min(...f.end);
  const lowIdx = f.end.indexOf(low);
  const stat = (label, value, color, sub) => (<div><Eyebrow>{label}</Eyebrow><div style={{ marginTop: 4, fontSize: '1rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color }}>{value}</div>{sub ? <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{sub}</div> : null}</div>);
  const data = f.weeks.map((w, i) => ({ label: fmtNumMD(w), end: Math.round(f.end[i]) }));
  const rowsDef = [
    ['Rent and operating receipts', f.rent, 'in'], ['Construction billings', f.con, 'in'],
    ['Payroll', f.pay, 'out'], ['Vendors and operating', f.vend, 'out'], ['Debt service', f.debt, 'out'], ['Property taxes and insurance', f.tax.map((t, i) => t + f.ins[i]), 'out'], ['Owner distributions', f.dist, 'out'],
    ['Net cash flow', f.receipts.map((r, i) => r + f.disbursements[i]), 'net'], ['Ending cash', f.end, 'end'],
  ];
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {stat('Opening cash', m(f.opening, { compact: true }))}
        {stat('Week 13 ending', m(f.end[12], { compact: true }))}
        {stat('Low point', m(low, { compact: true }), low < f.minCash ? BAD : undefined, `wk of ${fmtNumMD(f.weeks[lowIdx])}`)}
        {stat('Minimum cash target', m(f.minCash, { compact: true }), undefined, 'one month of payroll and debt')}
        {stat('13-week net', m(f.end[12] - f.opening, { compact: true, paren: true }), toneColor(f.end[12] - f.opening >= 0))}
      </div>
      <Lines data={data} series={[{ key: 'end', label: 'Ending cash', color: 'var(--wk-brand, #2b45e1)' }]} height={150} hline={{ v: f.minCash, label: 'minimum' }} />
      <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
          <thead><tr><th style={{ position: 'sticky', left: 0, background: 'var(--bg-card)' }}>Week of</th>{f.weeks.map((w) => <th key={w} style={num}>{fmtNumMD(w)}</th>)}</tr></thead>
          <tbody>
            {rowsDef.map(([label, vals, kind]) => (
              <tr key={label} style={kind === 'net' || kind === 'end' ? { fontWeight: 700, borderTop: '1px solid var(--border-color)' } : undefined}>
                <td style={{ position: 'sticky', left: 0, background: 'var(--bg-card)', paddingLeft: kind === 'in' || kind === 'out' ? 18 : undefined, color: kind === 'in' || kind === 'out' ? 'var(--text-secondary)' : undefined }}>{label}</td>
                {vals.map((v, i) => <td key={i} style={{ ...num, color: kind === 'net' ? toneColor(v >= 0) : kind === 'end' && v < f.minCash ? BAD : undefined }}>{v ? m(v, { compact: true, paren: true }) : '-'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Footnote>Receipts and disbursements are projected from the last closed month's ledger and the loan schedule. Non-controllable cash in partner entities is excluded. Weeks start {fmtMDY(f.weeks[0])}.</Footnote>
    </div>
  );
}

export { mono };
