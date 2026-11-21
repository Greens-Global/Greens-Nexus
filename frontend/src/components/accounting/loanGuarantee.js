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
