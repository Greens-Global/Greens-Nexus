import { formatAmount } from './Amount';

// Accounting > Loans: the guarantee record on a loan (Neil, 11/21/2026) - who
// stands behind it. Recourse and a short list of guarantors, typed under
// Change Loan and read on the loan's sheet. The server's one shape is
// backend/loan_guarantees.py; this file is the same lists and the words.
//
// A guarantor is a NAME as the guaranty states it (a person, a trust, an
// entity), so it is typed, never picked from Nexus People. Nothing is added
// up: several guarantors of one loan usually stand behind the same dollars.

export const RECOURSE = [['full', 'Full Recourse'], ['limited', 'Limited Recourse'], ['non_recourse', 'Non-Recourse']];
export const GUARANTEE_KINDS = [['full', 'Full'], ['limited', 'Limited'], ['carve_out', 'Carve-Outs Only']];
export const MAX_GUARANTORS = 12;

export const recourseLabel = (v) => (RECOURSE.find(([k]) => k === v) || [null, ''])[1];

export const blankGuarantor = () => ({ name: '', kind: 'full', amount: null, burnOff: '' });

/** The loan's guarantors as Change Loan's rows (copies - the loan is never edited in place). */
export function guarantorsStart(loan) {
  return (loan?.guarantors || []).map((g) => ({ name: g.name || '', kind: g.kind || 'full', amount: g.amount ?? null, burnOff: g.burnOff || '' }));
}

const words = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');
const isBlank = (g) => !words(g.name) && !words(g.burnOff) && g.amount == null;

/** The rows as they are sent: untouched rows dropped, a full or carve-out guarantee without an amount. */
export function cleanGuarantors(list) {
  return (list || []).filter((g) => !isBlank(g)).map((g) => ({
    name: words(g.name), kind: g.kind || 'full',
    amount: g.kind === 'limited' && g.amount != null && g.amount !== '' ? Number(g.amount) : null,
    burnOff: words(g.burnOff),
  }));
}

/** The first thing that stops the rows being saved, in the server's own words - '' when they are fine. */
export function guarantorsError(list) {
  for (const g of cleanGuarantors(list)) {
    if (!g.name) return 'Each guarantor needs a name.';
    if (g.kind === 'limited' && !(g.amount > 0)) return `${g.name}: a limited guarantee needs its amount.`;
  }
  return '';
}

/** "Full", "Limited to $350,000.00", "Carve-Outs Only". */
export function guaranteeWords(g) {
  if (g.kind === 'limited') return g.amount > 0 ? `Limited to $${formatAmount(g.amount)}` : 'Limited';
  return (GUARANTEE_KINDS.find(([k]) => k === g.kind) || GUARANTEE_KINDS[0])[1];
}

// ── The register: who stands behind what, across the loans shown ────────────

/**
 * What one guarantor stands behind on one loan: the balance for a full
 * guarantee, the limit (never more than the balance) for a limited one, and
 * nothing for carve-outs - those bite only on a "bad boy" act, not on the debt.
 * A loan with nothing owed (paid off, or a debit balance) carries no exposure.
 */
export function guaranteeExposure(g, loan) {
  const owed = loan?.debitBalance ? 0 : Math.max(0, Number(loan?.balance) || 0);
  if (g.kind === 'carve_out') return 0;
  if (g.kind === 'limited') return Math.min(owed, Math.max(0, Number(g.amount) || 0));
  return owed;
}

const nameKey = (name) => words(name).toLowerCase();

/**
 * One row per guarantor across `loans`: [{ key, name, exposure, lines: [{ loan,
 * guarantee, exposure }] }], the largest exposure first. A guarantor's own
 * loans ARE added up (they are different debts); guarantors are never added
 * to each other. The same name typed in a different case is one guarantor.
 */
export function guarantorGroups(loans) {
  const by = new Map();
  for (const loan of loans || []) {
    for (const g of loan.guarantors || []) {
      const key = nameKey(g.name);
      if (!key) continue;
      if (!by.has(key)) by.set(key, { key, name: words(g.name), exposure: 0, lines: [] });
      by.get(key).lines.push({ loan, guarantee: g, exposure: guaranteeExposure(g, loan) });
    }
  }
  for (const row of by.values()) {
    // Two guarantees by one name on ONE loan (a limited payment guaranty beside
    // a carve-out one) never come to more than that loan's balance.
    const perLoan = new Map();
    for (const x of row.lines) perLoan.set(x.loan, (perLoan.get(x.loan) || 0) + x.exposure);
    let total = 0;
    for (const [loan, sum] of perLoan) total += Math.min(sum, guaranteeExposure({ kind: 'full' }, loan));
    row.exposure = Math.round(total * 100) / 100;
  }
  return [...by.values()].sort((a, b) => b.exposure - a.exposure || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** A loan has a guarantee record once its recourse is set or it has a guarantor. */
export const hasGuaranteeRecord = (loan) => !!loan?.recourse || (loan?.guarantors || []).length > 0;
