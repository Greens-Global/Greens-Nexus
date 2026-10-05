// Loan arithmetic for Accounting > Loans & Financing (Charmi and Neil, 10/06):
// the amortization schedule ("allow us to build it or upload an existing file
// from the bank") and the rate stress test ("if the interest rate were to go
// up, we should be able to calculate if the income will support the loan").
// Pure functions only - no React, no API - so every figure on both screens is
// covered by loanMath.test.js. Amounts are rounded to cents per period, the
// way a bank's schedule is.

export const round2 = (v) => Math.round((Number(v) || 0) * 100 + Number.EPSILON * 100) / 100;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The loan row as either shape comes in: the Loans review row ({ ratePct,
 *  covenantMin, entityCode, monthlyPi, ... }) or the plain props shape
 *  ({ rate, covenant, entity, ... }). */
export function normalizeLoan(loan = {}) {
  const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    id: loan.id ?? '',
    lender: loan.lender || '',
    loanNo: loan.loanNo || '',
    entityCode: loan.entityCode || loan.entity || '',
    entityName: loan.entityName || loan.entity || '',
    balance: n(loan.balance) ?? 0,
    ratePct: n(loan.ratePct ?? loan.rate),
    rateType: (loan.rateType || '').toLowerCase() === 'variable' || (loan.rateType || '').toLowerCase() === 'floating' ? 'floating' : 'fixed',
    maturity: loan.maturity || null,
    monthlyPi: n(loan.monthlyPi),
    noiT12: n(loan.noiT12),
    covenant: n(loan.covenantMin ?? loan.covenant) || 1.35,
  };
}

// ── Dates (ISO strings, no time zones: a payment date is a calendar day) ────
export function parseIso(s) {
  const m = ISO.exec(String(s || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** `s` moved by `k` months; the day is kept, or the month's last day when the
 *  month is shorter (Jan 31 + 1 = Feb 28), and a schedule anchored on the
 *  31st keeps coming back to it. */
export function addMonths(s, k) {
  const p = parseIso(s);
  if (!p) return '';
  const idx = p.y * 12 + (p.m - 1) + k;
  const y = Math.floor(idx / 12); const m = (idx % 12) + 1;
  return iso(y, m, Math.min(p.d, daysInMonth(y, m)));
}

export function actualDays(a, b) {
  const pa = parseIso(a); const pb = parseIso(b);
  if (!pa || !pb) return 0;
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

/** US 30/360 (bond basis): every month counts 30 days. */
export function days360(a, b) {
  const pa = parseIso(a); const pb = parseIso(b);
  if (!pa || !pb) return 0;
  let d1 = pa.d; let d2 = pb.d;
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;
  return (pb.y - pa.y) * 360 + (pb.m - pa.m) * 30 + (d2 - d1);
}

// ── Payments ────────────────────────────────────────────────────────────────
/** The level payment that pays `principal` off over `n` periods at the
 *  periodic rate `r`. */
export function pmt(principal, r, n) {
  if (!(n > 0)) return 0;
  if (!r) return principal / n;
  return (principal * r) / (1 - (1 + r) ** -n);
}

/** How many monthly payments are left on a loan, from its balance, rate and
 *  monthly P&I: the payment formula solved for n. null when the payment does
 *  not even cover the interest (it never pays off) or a figure is missing. */
export function impliedRemainingMonths(balance, ratePct, monthlyPayment) {
  const b = Number(balance); const p = Number(monthlyPayment); const r = (Number(ratePct) || 0) / 1200;
  if (!(b > 0) || !(p > 0)) return null;
  if (!r) return Math.ceil(b / p);
  if (p <= b * r) return null;
  return Math.ceil(-Math.log(1 - (b * r) / p) / Math.log(1 + r));
}

export const DAY_COUNTS = [
  { key: '30/360', label: '30/360' },
  { key: 'actual/365', label: 'Actual/365' },
];

/**
 * The schedule of a monthly-pay loan.
 *   principal         the amount funded
 *   ratePct           annual note rate, %
 *   termMonths        months to maturity (the last payment)
 *   amortMonths       months the payment is sized over - more than the term
 *                     leaves a balloon at maturity (e.g. 10-year term on a
 *                     30-year amortization); defaults to the term
 *   ioMonths          interest-only months first; the amortizing payment is
 *                     then sized over amortMonths from the end of them
 *   firstPaymentDate  YYYY-MM-DD, then the same day each month
 *   startDate         YYYY-MM-DD the loan funded (interest runs from it to the
 *                     first payment); default a month before the first payment
 *   dayCount          '30/360' (interest = rate / 12 on a full month) or
 *                     'actual/365' (the days in each period over 365, the
 *                     payment still level - the usual commercial note, so
 *                     the balloon comes out a little higher than 30/360)
 * Returns { rows: [{ n, date, payment, interest, principal, balloon,
 * balance }], payment, ioPayment, totalInterest, totalPaid, balloon, errors }.
 */
export function buildSchedule(params = {}) {
  const principal = Number(params.principal) || 0;
  const ratePct = Number(params.ratePct) || 0;
  const term = Math.floor(Number(params.termMonths) || 0);
  const amort = Math.floor(Number(params.amortMonths) || 0) || term;
  const io = Math.max(0, Math.floor(Number(params.ioMonths) || 0));
  const first = params.firstPaymentDate || '';
  const dayCount = params.dayCount === 'actual/365' ? 'actual/365' : '30/360';
  const errors = [];
  if (!(principal > 0)) errors.push('Enter the principal.');
  if (ratePct < 0 || ratePct > 50) errors.push('The rate must be between 0% and 50%.');
  if (!(term >= 1 && term <= 1200)) errors.push('The term must be 1 to 1,200 months.');
  if (!(amort >= 1 && amort <= 1200)) errors.push('The amortization must be 1 to 1,200 months.');
  if (amort < term - io) errors.push('The amortization cannot be shorter than the amortizing part of the term.');
  if (io > term) errors.push('Interest-only months cannot exceed the term.');
  if (!parseIso(first)) errors.push('Enter the first payment date.');
  const start = params.startDate && parseIso(params.startDate) ? params.startDate : addMonths(first, -1);
  if (parseIso(first) && params.startDate && parseIso(params.startDate) && actualDays(start, first) <= 0) errors.push('The first payment must come after the funding date.');
  const empty = { rows: [], payment: 0, ioPayment: 0, totalInterest: 0, totalPaid: 0, balloon: 0, errors };
  if (errors.length) return empty;

  const rate = ratePct / 100;
  const level = round2(pmt(principal, rate / 12, amort));
  const fullyAmortizing = io + amort <= term;
  const rows = [];
  let bal = principal;
  let prev = start;
  let ioPayment = 0;
  for (let k = 1; k <= term && bal > 0.004; k += 1) {
    const date = addMonths(first, k - 1);
    const days = dayCount === 'actual/365' ? actualDays(prev, date) : days360(prev, date);
    const interest = round2(bal * rate * days / (dayCount === 'actual/365' ? 365 : 360));
    let principalPart; let payment;
    if (k <= io) {
      principalPart = 0;
      payment = interest;
      if (!ioPayment) ioPayment = interest;
    } else {
      payment = level;
      principalPart = round2(payment - interest);
      if (principalPart > bal || (k === term && fullyAmortizing)) {
        // The last payment of a fully amortizing loan (or one that overpays)
        // clears what the cents left behind.
        principalPart = round2(bal);
        payment = round2(interest + principalPart);
      }
    }
    bal = round2(bal - principalPart);
    let balloon = 0;
    if (k === term && bal > 0.004) {
      balloon = bal;
      bal = 0;
    }
    rows.push({ n: k, date, payment, interest, principal: principalPart, balloon, balance: bal });
    prev = date;
  }
  const totalInterest = round2(rows.reduce((s, r) => s + r.interest, 0));
  const totalPaid = round2(rows.reduce((s, r) => s + r.payment + r.balloon, 0));
  return { rows, payment: level, ioPayment, totalInterest, totalPaid, balloon: rows.length ? rows[rows.length - 1].balloon : 0, errors };
}

/** Totals of a schedule's columns (any source). */
export function scheduleTotals(rows = []) {
  const t = { payment: 0, interest: 0, principal: 0, balloon: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += Number(r[k]) || 0;
  for (const k of Object.keys(t)) t[k] = round2(t[k]);
  return t;
}

/** What the schedule says is owed at the end of `month` (YYYY-MM): the
 *  balance after the last payment dated in or before it; before the first
 *  payment, the starting balance. Mirrors expected_balance in
 *  routers/accounting_loan_plans.py. */
export function expectedBalanceAt(rows = [], month) {
  if (!rows.length) return null;
  let last = null;
  for (const r of rows) {
    if (String(r.date).slice(0, 7) <= month) last = r;
    else break;
  }
  if (!last) return { balance: round2(rows[0].balance + rows[0].principal + (rows[0].balloon || 0)), asOf: null, n: 0 };
  return { balance: last.balance, asOf: last.date, n: last.n };
}

// ── The bank's file ─────────────────────────────────────────────────────────
/** A cell as a number: 1234.5, "$1,234.50", "(1,234.50)" (negative), "-"
 *  (zero). null when it is not a number at all. */
export function parseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim();
  if (!s) return null;
  if (/^[-–—]$/.test(s)) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$,\s]/g, '').replace(/^USD/i, '');
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

/** A cell as YYYY-MM-DD: an Excel serial day, a Date, "MM/DD/YYYY" (US, the
 *  banks' format), "M/D/YY", "YYYY-MM-DD" or "Jan 1, 2026". '' when not a
 *  date. */
export function parseDateCell(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return '';     // 1954 - 2119: anything else is an amount, not a day
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) { const out = iso(Number(m[1]), Number(m[2]), Number(m[3])); return parseIso(out) ? out : ''; }
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const out = iso(y, Number(m[1]), Number(m[2]));
    return parseIso(out) ? out : '';
  }
  if (/[a-z]{3}/i.test(s) && /\d{4}/.test(s)) {
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
  return '';
}

export const SCHEDULE_FIELDS = [
  { key: 'date', label: 'Date', re: /date|due|period end|pmt dt/i, required: true },
  { key: 'payment', label: 'Payment', re: /^(?!.*(#|\bno\b|number|count)).*(payment|pmt|installment|total due|amount due|debt service)/i },
  { key: 'interest', label: 'Interest', re: /interest|int\b/i },
  { key: 'principal', label: 'Principal', re: /principal|prin\b/i },
  { key: 'balloon', label: 'Balloon', re: /balloon|maturity pay/i },
  { key: 'balance', label: 'Balance', re: /balance|outstanding|remaining|ending|end bal/i, required: true },
];

/** The row of a sheet that holds the column titles: the first one where at
 *  least three cells name a schedule column. 0 when none does. */
export function findHeaderRow(matrix = []) {
  for (let i = 0; i < Math.min(matrix.length, 40); i += 1) {
    const cells = (matrix[i] || []).map((c) => String(c ?? ''));
    const hits = SCHEDULE_FIELDS.filter((f) => cells.some((c) => c && f.re.test(c) && parseNumber(c) == null)).length;
    if (hits >= 3) return i;
  }
  return 0;
}

/** Which column is which, from the titles: { date: 0, payment: 2, ... }, -1
 *  for a column not found. A title is used once - "Principal Balance" is the
 *  balance only when no plainer balance column exists, so the specific
 *  words are matched first. */
export function guessColumns(headers = []) {
  const titles = headers.map((h) => String(h ?? '').trim());
  const used = new Set();
  const out = {};
  const order = ['balloon', 'balance', 'interest', 'principal', 'payment', 'date'];
  for (const key of order) {
    const f = SCHEDULE_FIELDS.find((x) => x.key === key);
    let idx = -1;
    // Prefer a title that matches only this field.
    titles.forEach((t, i) => {
      if (idx !== -1 || used.has(i) || !t || !f.re.test(t)) return;
      const others = SCHEDULE_FIELDS.filter((x) => x.key !== key && x.re.test(t)).length;
      if (!others) idx = i;
    });
    if (idx === -1) titles.forEach((t, i) => { if (idx === -1 && !used.has(i) && t && f.re.test(t)) idx = i; });
    if (idx !== -1) used.add(idx);
    out[key] = idx;
  }
  return out;
}

/** The schedule rows from the sheet below its header row, with the mapped
 *  columns. A row without a date or a balance (a title, a blank, a Totals
 *  line) is skipped. A missing principal is payment less interest, a missing
 *  interest payment less principal, a missing payment the two together. */
export function rowsFromMatrix(matrix = [], headerRow = 0, map = {}) {
  const col = (r, key) => (map[key] != null && map[key] >= 0 ? r[map[key]] : undefined);
  const rows = [];
  let skipped = 0;
  for (const r of matrix.slice(headerRow + 1)) {
    if (!r || !r.some((c) => c !== '' && c != null)) continue;
    const date = parseDateCell(col(r, 'date'));
    const balance = parseNumber(col(r, 'balance'));
    if (!date || balance == null) { skipped += 1; continue; }
    let payment = parseNumber(col(r, 'payment'));
    let interest = parseNumber(col(r, 'interest'));
    let principal = parseNumber(col(r, 'principal'));
    const balloon = parseNumber(col(r, 'balloon')) || 0;
    if (principal == null && payment != null && interest != null) principal = payment - interest;
    if (interest == null && payment != null && principal != null) interest = payment - principal;
    if (payment == null && principal != null && interest != null) payment = principal + interest;
    rows.push({ date, payment: round2(payment), interest: round2(interest), principal: round2(principal), balloon: round2(balloon), balance: round2(Math.abs(balance)) });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows: rows.map((r, i) => ({ n: i + 1, ...r })), skipped };
}

// ── Stress ──────────────────────────────────────────────────────────────────
export const SHOCKS = [100, 200, 300];
const DEFAULT_AMORT = 300;   // 25 years when nothing says otherwise

/** Twelve months of payments on `balance` at `ratePct`: interest only, or the
 *  level payment over `amortMonths`. */
export function annualDebtService({ balance, ratePct, amortMonths = DEFAULT_AMORT, interestOnly = false }) {
  const b = Math.max(0, Number(balance) || 0);
  const r = Math.max(0, Number(ratePct) || 0) / 100;
  if (interestOnly) return round2(b * r);
  return round2(pmt(b, r / 12, Math.max(1, Number(amortMonths) || DEFAULT_AMORT)) * 12);
}

/** The rate (%) at which `ds(rate)` reaches `target`, by bisection (debt
 *  service only grows with the rate). null when even 0% is too much; 'above'
 *  when even `hi`% still fits. */
export function solveRate(ds, target, hi = 50) {
  if (!(target > 0) || ds(0) > target) return null;
  if (ds(hi) <= target) return 'above';
  let lo = 0; let up = hi;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + up) / 2;
    if (ds(mid) > target) up = mid; else lo = mid;
  }
  return Math.round(lo * 1000) / 1000;
}

/** The amortization the stress test sizes the payment over: what was typed,
 *  else what the loan's monthly P&I implies, else 25 years. */
export function stressAmortMonths(loan, typed) {
  if (Number(typed) > 0) return Math.floor(Number(typed));
  const l = normalizeLoan(loan);
  return impliedRemainingMonths(l.balance, l.ratePct, l.monthlyPi) || DEFAULT_AMORT;
}

/**
 * One loan under a rate shock.
 *   balance, ratePct     today
 *   shockBps             the rise, in basis points (100 = 1.00%)
 *   noi                  annual net operating income that services it
 *   covenant             the DSCR minimum (1.35 = NOI 35% over debt service)
 *   rateType             'floating' - the shock reaches the payment now;
 *                        'fixed' - the payment holds until maturity, and the
 *                        shocked figures are what a refinance would cost
 *   amortMonths          remaining amortization the payment is sized over
 *   interestOnly         the payment is interest only
 */
export function stressLoan({ balance, ratePct, shockBps = 0, noi, covenant = 1.35, rateType = 'floating', amortMonths = DEFAULT_AMORT, interestOnly = false }) {
  const base = Number(ratePct) || 0;
  const stressedRate = Math.round((base + (Number(shockBps) || 0) / 100) * 1000) / 1000;
  const ds = (rate) => annualDebtService({ balance, ratePct: rate, amortMonths, interestOnly });
  const cov = Number(covenant) > 0 ? Number(covenant) : 1.35;
  const income = Number(noi) || 0;
  const baseDebtService = ds(base);
  const shocked = ds(Math.max(0, stressedRate));
  const floating = rateType !== 'fixed';
  const debtService = floating ? shocked : baseDebtService;
  const dscr = (d) => (d > 0 ? Math.round((income / d) * 100) / 100 : null);
  const breakEven = solveRate(ds, income / cov);
  const cushion = round2(income - cov * debtService);
  return {
    baseRate: base,
    stressedRate,
    floating,
    baseDebtService,
    debtService,
    refinanceDebtService: shocked,
    dscrBase: dscr(baseDebtService),
    dscr: dscr(debtService),
    dscrAtRefinance: dscr(shocked),
    covenant: cov,
    pass: debtService > 0 ? income / debtService >= cov : true,
    passAtRefinance: shocked > 0 ? income / shocked >= cov : true,
    increase: round2(debtService - baseDebtService),
    cushion,
    cushionPct: income > 0 ? Math.round((cushion / income) * 1000) / 10 : null,
    breakEvenRate: breakEven,
    headroomBps: typeof breakEven === 'number' ? Math.round((breakEven - base) * 100) : breakEven,
  };
}

/**
 * Every loan under the same shock, entity by entity: an entity's NOI services
 * all of its loans (the Loans review's DSCR is the entity's NOI over the
 * entity's whole debt service - what a lender looks at), so a property passes
 * or fails as one. `opts` = { shockBps, overrides: { [loanId]: { noi?,
 * rateType?, amortMonths? } } }; an entity's NOI is the first loan's NOI
 * (the review gives every loan of an entity the same figure) unless typed.
 */
export function stressPortfolio(loans = [], { shockBps = 0, overrides = {}, entityNoi = {} } = {}) {
  const groups = new Map();
  for (const raw of loans) {
    const l = normalizeLoan(raw);
    const key = l.entityCode || l.entityName || String(l.id);
    if (!groups.has(key)) groups.set(key, { entityCode: key, entityName: l.entityName || key, loans: [], noi: null, covenant: 0 });
    const g = groups.get(key);
    const o = overrides[l.id] || {};
    const amortMonths = stressAmortMonths(raw, o.amortMonths);
    const rateType = o.rateType || l.rateType;
    const stressedRate = Math.max(0, (l.ratePct || 0) + (Number(shockBps) || 0) / 100);
    const base = annualDebtService({ balance: l.balance, ratePct: l.ratePct || 0, amortMonths });
    const shocked = annualDebtService({ balance: l.balance, ratePct: stressedRate, amortMonths });
    g.loans.push({ ...l, rateType, amortMonths, baseDebtService: base, debtService: rateType === 'fixed' ? base : shocked, refinanceDebtService: shocked, missingRate: l.ratePct == null });
    if (g.noi == null && l.noiT12 != null) g.noi = l.noiT12;
    g.covenant = Math.max(g.covenant, l.covenant || 1.35);
  }
  const entities = [];
  for (const g of groups.values()) {
    const noi = entityNoi[g.entityCode] != null && entityNoi[g.entityCode] !== '' ? Number(entityNoi[g.entityCode]) : (g.noi || 0);
    const baseDS = round2(g.loans.reduce((s, l) => s + l.baseDebtService, 0));
    const ds = round2(g.loans.reduce((s, l) => s + l.debtService, 0));
    const dsAt = (bps) => g.loans.reduce((s, l) => s + (l.rateType === 'fixed' ? l.baseDebtService
      : annualDebtService({ balance: l.balance, ratePct: Math.max(0, (l.ratePct || 0) + bps / 100), amortMonths: l.amortMonths })), 0);
    // The shock (bps) at which the entity's DSCR falls to the covenant; fixed
    // loans do not move, so a fully fixed entity has no break-even.
    const anyFloating = g.loans.some((l) => l.rateType !== 'fixed');
    const be = anyFloating ? solveRate((pct) => dsAt(pct * 100), noi / g.covenant, 50) : 'above';
    entities.push({
      entityCode: g.entityCode, entityName: g.entityName, loans: g.loans, noi: round2(noi), covenant: g.covenant,
      baseDebtService: baseDS, debtService: ds,
      dscrBase: baseDS > 0 ? Math.round((noi / baseDS) * 100) / 100 : null,
      dscr: ds > 0 ? Math.round((noi / ds) * 100) / 100 : null,
      pass: ds > 0 ? noi / ds >= g.covenant : true,
      cushion: round2(noi - g.covenant * ds),
      breakEvenShockBps: typeof be === 'number' ? Math.round(be * 100) : be,
    });
  }
  entities.sort((a, b) => (a.pass === b.pass ? (a.dscr ?? 99) - (b.dscr ?? 99) : a.pass ? 1 : -1));
  const totals = {
    entities: entities.length,
    loans: loans.length,
    balance: round2(entities.reduce((s, e) => s + e.loans.reduce((t, l) => t + l.balance, 0), 0)),
    noi: round2(entities.reduce((s, e) => s + e.noi, 0)),
    baseDebtService: round2(entities.reduce((s, e) => s + e.baseDebtService, 0)),
    debtService: round2(entities.reduce((s, e) => s + e.debtService, 0)),
    failing: entities.filter((e) => !e.pass).length,
  };
  totals.dscr = totals.debtService > 0 ? Math.round((totals.noi / totals.debtService) * 100) / 100 : null;
  return { entities, totals };
}
