// Terms From Asset Management (Neil, 11/19/2026) - the rules the Loans screen applies to what
// GET /accounting/loans/term-suggestions offers. The list itself is LoanTermOffers.jsx.
import { formatDate } from '../../lib/datetime';

/** The offers that still apply: for a loan on screen, only the terms it lacks. -> [{ ...offer, loan }] */
export function offersFor(suggestions, loans) {
  const byId = new Map((loans || []).map((l) => [String(l.id), l]));
  return (suggestions || []).map((s) => {
    const loan = byId.get(String(s.loanId));
    if (!loan || loan.closed) return null;
    const o = { loanId: String(s.loanId), propertyId: s.propertyId || '', propertyName: s.propertyName || '', why: s.why || '', loan };
    if (s.maturity && !loan.maturity) o.maturity = s.maturity;
    if (s.ratePct != null && loan.ratePct == null) { o.ratePct = s.ratePct; if (s.rateType) o.rateType = s.rateType; }
    return o.maturity || o.ratePct != null ? o : null;
  }).filter(Boolean);
}

/** The PUT body that fills one offer. */
export function offerBody(o) {
  const body = {};
  if (o.maturity) body.maturity = o.maturity;
  if (o.ratePct != null) { body.ratePct = o.ratePct; if (o.rateType) body.rateType = o.rateType; }
  return body;
}

/** "Maturity 06/01/2031 - Rate 6.25% fixed" */
export function offerWords(o) {
  return [
    o.maturity && `Maturity ${formatDate(o.maturity)}`,
    o.ratePct != null && `Rate ${Number(o.ratePct).toLocaleString('en-US', { maximumFractionDigits: 3 })}%${o.rateType ? ` ${o.rateType}` : ''}`,
  ].filter(Boolean).join(' - ');
}
