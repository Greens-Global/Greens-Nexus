// Balance-sheet flux: month-over-month balance changes big enough to explain
// before the close package goes out ($25K, or 10% when the account is not
// tiny). Ported thresholds; retained earnings and the derived current-year
// earnings are excluded because they move by construction.
import { balanceSheet, isCurrentYearEarnings } from "./ledger";
import { shiftKey } from "./months";
export const FLUX_ABS = 25000;
export const FLUX_PCT = 0.1;
export const FLUX_PCT_FLOOR = 2500;
const SUGGESTIONS = [
    [/accumulated depreciation/i, "Monthly depreciation entry per the fixed asset schedule"],
    [/mortgage|notes? payable|loan/i, "Scheduled principal payments per the loan amortization schedules"],
    [/construction in progress|\bcip\b/i, "Construction draws capitalized to CIP (see construction billings on the Cash page)"],
    [/cash|checking|operating|bank/i, "Net operating cash flow for the month - see the cash plan"],
    [/prepaid/i, "Prepaid amortization per the schedule"],
    [/accrued/i, "Month-end accruals reversed and re-booked"],
    [/deposit/i, "Tenant deposits received and refunded"],
    [/investment|brokerage|securit/i, "Market value adjustment from the brokerage statement"],
];
export function suggestionFor(name) {
    for (const [re, text] of SUGGESTIONS)
        if (re.test(name))
            return text;
    return "";
}
export function fluxRows(L, period) {
    const pk = shiftKey(period, 1);
    const hasPrior = L.months.includes(pk);
    if (!hasPrior)
        return { rows: [], hasPrior };
    const cur = balanceSheet(L, period).rows;
    const prev = new Map(balanceSheet(L, pk).rows.map((r) => [r.id, r.balance]));
    const rows = [];
    for (const r of cur) {
        if (r.section === "equity" && isCurrentYearEarnings(r.account))
            continue;
        const prior = prev.get(r.id) ?? 0;
        const change = r.balance - prior;
        const changePct = prior ? change / Math.abs(prior) : 0;
        if (Math.abs(change) >= FLUX_ABS || (Math.abs(changePct) >= FLUX_PCT && Math.abs(change) >= FLUX_PCT_FLOOR)) {
            rows.push({ ...r, prior, change, changePct, suggestion: suggestionFor(r.name) });
        }
    }
    // Accounts that had a balance last month and none now.
    for (const [id, prior] of prev) {
        if (cur.some((r) => r.id === id) || Math.abs(prior) < FLUX_PCT_FLOOR)
            continue;
        const a = L.accounts.get(id);
        if (!a || (a.section === "equity" && isCurrentYearEarnings(a)))
            continue;
        const section = a.section === "asset" ? "asset" : a.section === "liability" ? "liability" : "equity";
        rows.push({ id, gl: a.gl, name: a.name, section, account: a, balance: 0, prior, change: -prior, changePct: -1, suggestion: suggestionFor(a.name) });
    }
    return { rows: rows.sort((x, y) => Math.abs(y.change) - Math.abs(x.change)), hasPrior };
}
