import { covenantState, MATURITY_SOON_MONTHS, maturingSoon, maturitySummary } from '../../../accounting/dashboard/model/capital';
import { fmtLong, MONTH_SHORT } from '../../../accounting/dashboard/model/months';
import { pctTxt } from '../../../accounting/dashboard/model/money';
import { WarnMark } from '../warnMark';
import { BAD, Chip, Dot, EmptyBox, Footnote, GroupRow, LoadingBox, Meter, num, Tile, toneColor, WARN } from './Bits';
import { ColoredBars } from './Charts';
import { useDash } from './DashContext';
import { useLoans, usePartners, useValuation } from './hooks';

// Debt and capital widgets: loans and covenants, partner capital and
// distributions, portfolio valuation, and maturities.

const matLabel = (iso) => (iso ? `${MONTH_SHORT[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '-');
const tiles = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 };

export function DebtWidget() {
  const { m, ix, period } = useDash();
  const { loans, isLoading, failed } = useLoans();
  if (isLoading) return <LoadingBox failed={failed} />;
  if (!loans.length) return <EmptyBox title="No loans for this scope" body="Record mortgages and credit lines under Financing > Loans." setUp={['loans', 'Financing > Loans']} />;
  return (
    <div className="req-table-wrapper">
      <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr><th>Loan</th><th style={num}>Balance</th><th style={num}>Rate</th><th>Matures</th><th>DSCR</th></tr></thead>
        <tbody>
          {loans.map((l) => {
            const cov = covenantState(l);
            return (
              <tr key={l.id} style={ix.isPartner(l.entity_code) ? { color: 'var(--text-muted)' } : undefined}>
                <td><div>{l.lender}</div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ix.byCode.get(l.entity_code)?.name || l.entity_code}</div></td>
                <td style={num}>{m(l.balance, { compact: true })}</td>
                <td style={num}>{l.rate_pct ? `${l.rate_pct.toFixed(2)}%` : <span style={{ color: 'var(--text-muted)' }}>Not Set</span>}</td>
                <td style={{ fontSize: 13 }}>{matLabel(l.maturity)}{maturingSoon(l, period) ? <Chip tone="wait" style={{ marginLeft: 8 }}>Within {MATURITY_SOON_MONTHS} Mo</Chip> : null}</td>
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
  const { summary: s, isLoading, failed } = usePartners();
  if (isLoading) return <LoadingBox failed={failed} />;
  if (!s.rows.length) return <EmptyBox title="No partner capital in this scope" body="Record investor classes and distributions under Tools > Reference Data, Partner Capital." setUp={['data', 'Tools > Reference Data']} />;
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
                  <tr key={r.id}><td>{r.class_name}</td><td style={num}>{pctTxt(r.ownership, 0)}</td><td style={num}>{m(r.capital, { report: true })}</td><td style={num}>{m(r.ytd, { report: true })}</td><td style={{ ...num, color: 'var(--text-muted)' }}>{pctTxt(r.yield)}</td></tr>
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
  const { v, isLoading, failed } = useValuation();
  if (isLoading) return <LoadingBox failed={failed} />;
  if (!v.rows.length) return <EmptyBox title="No properties in this scope" body="Give each property entity an asset type, and each asset type a cap rate under Tools > Reference Data, Cap Rates." setUp={['data', 'Tools > Reference Data']} />;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={tiles}>
        <Tile label="Implied value" value={m(v.value, { compact: true })} sub={`${pctTxt(v.blendedCap, 2)} blended cap`} />
        <Tile label="Debt" value={m(v.debt, { compact: true })} />
        <Tile label="Equity" value={m(v.equity, { compact: true })} subColor={toneColor(v.equity >= 0)} />
        <Tile label="Loan to value" value={pctTxt(v.ltv, 0)} sub={<Chip tone={v.ltvTone === 'High' ? 'bad' : v.ltvTone === 'Moderate' ? 'wait' : 'ok'}>{v.ltvTone}</Chip>} />
      </div>
      <Meter segments={[{ share: v.ltv, color: v.ltv > 0.7 ? BAD : v.ltv > 0.6 ? WARN :'var(--wk-brand, #2b45e1)' }]} />
      <div className="req-table-wrapper">
        <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr><th>Asset Class</th><th style={num}>T12 NOI</th><th style={num}>Cap Rate</th><th style={num}>Value</th></tr></thead>
          <tbody>{v.rows.map((r) => <tr key={r.assetType}><td>{r.assetType}</td><td style={num}>{m(r.noi, { report: true })}</td><td style={num}>{r.capRate != null ? pctTxt(r.capRate, 2) : <span style={{ color: 'var(--text-muted)' }}>not set</span>}</td><td style={num}>{r.value ? m(r.value, { compact: true }) : '-'}</td></tr>)}</tbody>
        </table>
      </div>
      <Footnote>Cap rates are placeholder market assumptions by asset class; replace with broker opinions of value or appraisals.</Footnote>
    </div>
  );
}

export function MaturityWidget() {
  const { m, period } = useDash();
  const { loans, isLoading, failed } = useLoans();
  if (isLoading) return <LoadingBox failed={failed} />;
  if (!loans.length) return <EmptyBox title="No loans for this scope" setUp={['loans', 'Financing > Loans']} />;
  const s = maturitySummary(loans, period);
  // A loan with no rate is "not set", not 0% (11/12/2026: $3.40M of debt read 0.00%).
  const rated = loans.filter((l) => l.rate_pct > 0);
  const ratedBal = rated.reduce((t, l) => t + l.balance, 0);
  const rate = ratedBal ? rated.reduce((t, l) => t + l.balance * l.rate_pct, 0) / ratedBal : null;
  const unrated = loans.length - rated.length;
  // One horizon everywhere: the model's MATURITY_SOON_MONTHS (18).
  const soon = loans.filter((l) => maturingSoon(l, period)).reduce((t, l) => t + l.balance, 0);
  const compact = (v) => m(v, { compact: true });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={tiles}>
        <Tile label="Total debt" value={compact(s.total)} />
        <Tile label="Weighted rate" value={rate == null ? '-' : `${rate.toFixed(2)}%`} sub={unrated ? `Rate not set on ${unrated} loan${unrated === 1 ? '' : 's'}` : undefined} />
        <Tile label="Annual debt service" value={compact(s.annualService)} />
        <Tile label={`Maturing within ${MATURITY_SOON_MONTHS} mo`} value={compact(soon)} />
      </div>
      {s.byYear.length ? <ColoredBars data={s.byYear.map((y) => ({ label: String(y.year), value: y.balance, color: y.soon ? WARN : '#0998c3' }))} height={150} valueLabel={compact} /> : null}
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: WARN }}><WarnMark size={11} />Maturing within {MATURITY_SOON_MONTHS} months</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot color="#0998c3" />Later maturities</span></div>
      <Footnote>Refinance conversations typically start 12 to 18 months before maturity.</Footnote>
    </div>
  );
}
