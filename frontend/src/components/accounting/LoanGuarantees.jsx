import Amount from './Amount';
import { guaranteeWords, guarantorGroups, hasGuaranteeRecord } from './loanGuarantee';

// Accounting > Loans & Financing: Guarantees (Neil, 11/21/2026) - the register
// the loan-by-loan record (Change Loan > Guarantee) adds up to. One line per
// guarantor across the open loans shown: the loans they stand behind, how, and
// what that comes to - the balance for a full guarantee, the limit for a
// limited one, nothing for carve-outs. A guarantor's own loans are added up;
// guarantors are never added to each other, because several usually stand
// behind the same dollars.
//
// Drawn like Maturities: a titled list with hairline rows, no table, no boxes.
// The name column is a share of the row (30%, 90px to 220px), so on a phone
// the loans keep most of the width and the names still line up row to row.
// The figure is worked out, not posted, so it is plain (no ledger drill).
// Nothing shows until at least one open loan has a guarantee record.

const loanName = (l) => `${l.lender || l.loanNo || 'Loan'}${l.loanNo && l.lender ? ` #${l.loanNo}` : ''}${l.entityName ? ` (${l.entityName})` : ''}`;

export default function LoanGuarantees({ rows }) {
  const open = (rows || []).filter((r) => !r.closed);
  const recorded = open.filter(hasGuaranteeRecord).length;
  if (!recorded) return null;
  const groups = guarantorGroups(open);
  const missing = open.length - recorded;
  return (
    <section style={{ display: 'grid', gap: 6 }} aria-label="Guarantees">
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Guarantees</h3>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
        What each guarantor stands behind on the open loans shown: the balance for a full guarantee, the limit for a limited one.
        Carve-outs are not counted, and guarantors are not added together - several often stand behind the same dollars.
      </div>
      {!groups.length && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No guarantor is recorded on the open loans shown.</div>}
      {groups.length > 0 && (
        <div role="list" style={{ display: 'grid' }}>
          {groups.map((g) => (
            <div key={g.key} role="listitem" style={{ display: 'grid', gridTemplateColumns: 'clamp(90px, 30%, 220px) minmax(0, 1fr) auto', gap: 12, alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid var(--border-color)', fontSize: 13 }}>
              <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{g.name}</span>
              <span style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
                {g.lines.map((x) => `${loanName(x.loan)} - ${guaranteeWords(x.guarantee)}`).join('; ')}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}><Amount value={g.exposure} zero="dash" /></span>
            </div>
          ))}
        </div>
      )}
      {missing > 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {`${missing} of ${open.length} open ${open.length === 1 ? 'loan' : 'loans'} ${missing === 1 ? 'has' : 'have'} no guarantee recorded yet - add it under Change Loan.`}
        </div>
      )}
    </section>
  );
}
