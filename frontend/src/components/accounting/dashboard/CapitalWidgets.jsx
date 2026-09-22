import { covenantState, maturingSoon, maturitySummary } from '../../../accounting/dashboard/model/capital';
import { fmtLong, MONTH_SHORT } from '../../../accounting/dashboard/model/months';
import { pctTxt } from '../../../accounting/dashboard/model/money';
import { Chip, Dot, EmptyBox, Footnote, GroupRow, LoadingBox, Meter, num, Tile, toneColor } from './Bits';
import { ColoredBars } from './Charts';
import { useDash } from './DashContext';
import { useLoans, usePartners, useValuation } from './hooks';

// Debt and capital widgets: loans and covenants, partner capital and
// distributions, portfolio valuation, and maturities.

const matLabel = (iso) => (iso ? `${MONTH_SHORT[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '-');
const tiles = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 };

export function DebtWidget() {
  const { m, ix, period } = useDash();
  const { loans, isLoading } = useLoans();
  if (isLoading) return <LoadingBox />;
  if (!loans.length) return <EmptyBox title="No loans for this scope" body="Record mortgages and credit lines under the Data tab." />;
  return (
    <div className="req-table-wrapper">
      <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr><th>Loan</th><th style={num}>Balance</th><th style={num}>Rate</th><th>Matures</th><th>DSCR</th></tr></thead>
        <tbody>
          {loans.map((l) => {
            const cov = covenantState(l);
            return (
              <tr key={l.id} style={ix.isPartner(l.entity_code) ? { color: 'var(--text-muted)' } : undefined}>
                <td><div>{l.lender}</div><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{ix.byCode.get(l.entity_code)?.name || l.entity_code}</div></td>
                <td style={num}>{m(l.balance, { compact: true })}</td>
                <td style={num}>{l.rate_pct.toFixed(2)}%</td>
                <td style={{ fontSize: '0.78rem' }}>{matLabel(l.maturity)}{maturingSoon(l, period) ? <Chip tone="wait" style={{ marginLeft: 8 }}>Within 18 mo</Chip> : null}</td>
                <td>{cov === 'n/a' ? <span style={{ color: 'var(--text-muted)' }}>-</span> : <Chip tone={cov === 'Below' ? 'bad' : cov === 'Near' ? 'wait' : 'ok'}>{l.dscr?.toFixed(2)}x / {l.covenant_min?.toFixed(2)}x min</Chip>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PartnersWidget() {
  const { m, ix } = useDash();
  const { summary: s, isLoading } = usePartners();
  if (isLoading) return <LoadingBox />;
  if (!s.rows.length) return <EmptyBox title="No partner capital in this scope" body="Record investor classes and distributions under the Data tab." />;
  const byEntity = [...new Set(s.rows.map((r) => r.entity_code))];
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={tiles}>
        <Tile label="Partner capital" value={m(s.capital, { compact: true })} />
        <Tile label="Distributions YTD" value={m(s.ytd, { compact: true })} />
        <Tile label="Annualized yield" value={pctTxt(s.annualizedYield)} />
        <Tile label="Next quarterly" value={m(s.nextQuarterly, { compact: true })} sub={fmtLong(s.nextQuarterDate)} />
      </div>
      <div className="req-table-wrapper">
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th>Class</th><th style={num}>Ownership</th><th style={num}>Capital</th><th style={num}>Distributions YTD</th><th style={num}>Yield</th></tr></thead>
          <tbody>
            {byEntity.map((code) => (
              <GroupBlock key={code} title={`${ix.byCode.get(code)?.name || code}${ix.isPartner(code) ? ' · non-controllable' : ''}`}>
                {s.rows.filter((r) => r.entity_code === code).map((r) => (
                  <tr key={r.id}><td>{r.class_name}</td><td style={num}>{pctTxt(r.ownership, 0)}</td><td style={num}>{m(r.capital)}</td><td style={num}>{m(r.ytd)}</td><td style={{ ...num, color: 'var(--text-muted)' }}>{pctTxt(r.yield)}</td></tr>
                ))}
              </GroupBlock>
            ))}
          </tbody>
        </table>
      </div>
      <Footnote>Investor names live in Nexus Investor Relations; this shows classes only. Partner-entity distributions are paid from non-controllable cash.</Footnote>
    </div>
  );
}

function GroupBlock({ title, children }) {
  return (<><GroupRow title={title} cols={5} />{children}</>);
}

export function ValuationWidget() {
  const { m } = useDash();
  const { v, isLoading } = useValuation();
  if (isLoading) return <LoadingBox />;
  if (!v.rows.length) return <EmptyBox title="No properties in this scope" body="Give each property entity an asset type and a cap rate under the Data tab." />;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={tiles}>
        <Tile label="Implied value" value={m(v.value, { compact: true })} sub={`${pctTxt(v.blendedCap, 2)} blended cap`} />
        <Tile label="Debt" value={m(v.debt, { compact: true })} />
        <Tile label="Equity" value={m(v.equity, { compact: true })} subColor={toneColor(v.equity >= 0)} />
        <Tile label="Loan to value" value={pctTxt(v.ltv, 0)} sub={<Chip tone={v.ltvTone === 'High' ? 'bad' : v.ltvTone === 'Moderate' ? 'wait' : 'ok'}>{v.ltvTone}</Chip>} />
      </div>
      <Meter segments={[{ share: v.ltv, color: v.ltv > 0.7 ? '#dc2626' : v.ltv > 0.6 ? '#d97706' : 'var(--wk-brand, #2b45e1)' }]} />
      <div className="req-table-wrapper">
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th>Asset class</th><th style={num}>T12 NOI</th><th style={num}>Cap rate</th><th style={num}>Value</th></tr></thead>
          <tbody>{v.rows.map((r) => <tr key={r.assetType}><td>{r.assetType}</td><td style={num}>{m(r.noi)}</td><td style={num}>{r.capRate != null ? pctTxt(r.capRate, 2) : <span style={{ color: 'var(--text-muted)' }}>not set</span>}</td><td style={num}>{r.value ? m(r.value, { compact: true }) : '-'}</td></tr>)}</tbody>
        </table>
      </div>
      <Footnote>Cap rates are placeholder market assumptions by asset class; replace with broker opinions of value or appraisals.</Footnote>
    </div>
  );
}

export function MaturityWidget() {
  const { m, period } = useDash();
  const { loans, isLoading } = useLoans();
  if (isLoading) return <LoadingBox />;
  if (!loans.length) return <EmptyBox title="No loans for this scope" />;
  const s = maturitySummary(loans, period);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={tiles}>
        <Tile label="Total debt" value={m(s.total, { compact: true })} />
        <Tile label="Weighted rate" value={`${s.weightedRate.toFixed(2)}%`} />
        <Tile label="Annual debt service" value={m(s.annualService, { compact: true })} />
        <Tile label="Maturing within 24 mo" value={m(s.withinTwoYears, { compact: true })} />
      </div>
      {s.byYear.length ? <ColoredBars data={s.byYear.map((y) => ({ label: String(y.year), value: y.balance, color: y.soon ? '#d97706' : '#0998c3' }))} height={150} /> : null}
      <div style={{ display: 'flex', gap: 16, fontSize: '0.7rem', color: 'var(--text-muted)' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="#d97706" />Maturing within 18 months</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="#0998c3" />Later maturities</span></div>
      <Footnote>Refinance conversations typically start 12 to 18 months before maturity.</Footnote>
    </div>
  );
}
