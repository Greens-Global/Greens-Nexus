import { mEnd, parts, toISO } from "./months";
import { sum } from "./money";
import { inScope } from "./scope";
// ── Loans ───────────────────────────────────────────────────────────────────
export const MATURITY_SOON_MONTHS = 18;
export const COVENANT_NEAR = 0.05;
export function monthsToMaturity(loan, period) {
    if (!loan.maturity)
        return null;
    const pe = new Date(mEnd(period));
    const m = new Date(loan.maturity);
    return (m.getTime() - pe.getTime()) / 2.63e9;
}
export const maturingSoon = (loan, period) => {
    const m = monthsToMaturity(loan, period);
    return m != null && m < MATURITY_SOON_MONTHS;
};
export function covenantState(loan) {
    if (loan.dscr == null || loan.covenant_min == null)
        return "n/a";
    if (loan.dscr < loan.covenant_min)
        return "Below";
    if (loan.dscr < loan.covenant_min + COVENANT_NEAR)
        return "Near";
    return "Meets";
}
export const loansInScope = (loans, ix, scope) => loans.filter((l) => l.is_active && inScope(ix, l.entity_code, scope));
export function maturitySummary(loans, period) {
    const total = sum(loans.map((l) => l.balance));
    const weightedRate = total ? sum(loans.map((l) => l.balance * l.rate_pct)) / total : 0;
    const annualService = sum(loans.map((l) => l.monthly_pi * 12));
    const withinTwoYears = sum(loans.filter((l) => { const m = monthsToMaturity(l, period); return m != null && m <= 24; }).map((l) => l.balance));
    const years = new Map();
    for (const l of loans) {
        if (!l.maturity)
            continue;
        const y = Number(l.maturity.slice(0, 4));
        years.set(y, (years.get(y) ?? 0) + l.balance);
    }
    const { y: py, m: pm } = parts(period);
    const byYear = [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, balance]) => ({ year, balance, soon: year - (py + pm / 12) <= 1.5 }));
    return { total, weightedRate, annualService, withinTwoYears, byYear };
}
/** Implied value from trailing-12 NOI per asset class at that class's cap rate, against debt. */
export function valuation(noiByType, capRates, debt) {
    const rateOf = new Map(capRates.map((c) => [c.asset_type.toLowerCase(), c.cap_rate]));
    const rows = [...noiByType.entries()]
        .map(([assetType, noi]) => {
        const capRate = rateOf.get(assetType.toLowerCase()) ?? null;
        return { assetType, noi, capRate, value: capRate && noi > 0 ? noi / capRate : 0 };
    })
        .sort((a, b) => b.noi - a.noi);
    const t12 = sum(rows.map((r) => r.noi));
    const value = sum(rows.map((r) => r.value));
    const ltv = value ? debt / value : 0;
    return {
        rows, t12, value, debt, ltv, equity: value - debt, blendedCap: value ? t12 / value : 0,
        ltvTone: ltv > 0.7 ? "High" : ltv > 0.6 ? "Moderate" : "Conservative",
    };
}
export function partnerSummary(rows, period) {
    const { y, m } = parts(period);
    const ytdOf = (c) => (c.frequency === "M" ? c.distribution * m : c.distribution * Math.floor(m / 3));
    const withYtd = rows.map((c) => {
        const ytd = ytdOf(c);
        return { ...c, ytd, yield: c.capital && m ? ((ytd / c.capital) * 12) / m : 0 };
    });
    const capital = sum(rows.map((c) => c.capital));
    const ytd = sum(withYtd.map((c) => c.ytd));
    const q = new Date(y, Math.ceil(m / 3) * 3, 0); // last day of the current quarter
    return {
        rows: withYtd, capital, ytd,
        annualizedYield: capital && m ? ((ytd / capital) * 12) / m : 0,
        nextQuarterly: sum(rows.filter((c) => c.frequency === "Q").map((c) => c.distribution)),
        nextQuarterDate: toISO(q),
    };
}
export function intercompanyRows(pairs, ix, scope) {
    return pairs
        .filter((p) => inScope(ix, p.from_code, scope) || inScope(ix, p.to_code, scope))
        .map((p) => ({ ...p, matched: Math.abs(p.due_from - p.due_to) < 0.005, difference: p.due_from - p.due_to }));
}
/** Next occurrence of every active deadline on or after `today`, soonest first. */
export function upcomingDeadlines(deadlines, today = new Date(), limit = 6) {
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const out = [];
    for (const d of deadlines) {
        if (!d.is_active)
            continue;
        const candidates = [];
        for (const year of [t0.getFullYear(), t0.getFullYear() + 1]) {
            if (d.kind === "monthly") {
                for (let mo = 0; mo < 12; mo++)
                    for (const day of d.schedule)
                        candidates.push(new Date(year, mo, Number(day)));
            }
            else {
                for (const [mo, day] of d.schedule)
                    candidates.push(new Date(year, Number(mo) - 1, Number(day)));
            }
        }
        const next = candidates.filter((c) => c >= t0).sort((a, b) => a.getTime() - b.getTime())[0];
        if (!next)
            continue;
        out.push({ deadline: d, date: toISO(next), days: Math.round((next.getTime() - t0.getTime()) / 86400000) });
    }
    return out.sort((a, b) => a.days - b.days || a.deadline.sort - b.deadline.sort).slice(0, limit);
}
// ── Holdings ────────────────────────────────────────────────────────────────
export const holdingClass = (cls) => (/equity|stock/i.test(cls) ? "Stocks" : "Bonds");
export function holdingsInScope(holdings, ix, scope) {
    return holdings.filter((h) => inScope(ix, h.entity_code, scope));
}
