// Performance page math: headline tiles against budget and prior year,
// material variances with a plain-English line each, and year-to-date
// budget variance. Signed amounts make "favorable" one rule: actual - budget >= 0.
import { incomeStatementRange, incomeStatementWindow, isRevenue, sumLines } from "./ledger";
import { shiftKey } from "./months";
import { money, pct } from "./money";
const rel = (a, b) => (b == null || !b ? null : (a - b) / Math.abs(b));
/** Same months a year earlier, when the loaded window has them. */
function lastYear(L, from, to) {
    const f = shiftKey(from, 12), t = shiftKey(to, 12);
    return L.months.includes(f) ? incomeStatementWindow(L, f, t) : null;
}
/** Headline tiles for [from, period]; a single month when `from` is omitted. */
export function perfTiles(L, period, from = period) {
    const cur = incomeStatementWindow(L, from, period);
    const py = lastYear(L, from, period);
    const rev = (l) => l.group === "Revenue";
    const cor = (l) => l.group === "Cost of Revenue";
    const opx = (l) => l.group === "Operating Expenses";
    const S = (ls, f, key = "actual") => (ls ? sumLines(ls, f, key) : 0);
    const mk = (name, actual, budget, prior, up) => {
        const vsBudget = rel(actual, budget);
        const vsPrior = rel(actual, prior);
        return {
            name, actual, budget, prior, up, vsBudget, vsPrior,
            goodBudget: vsBudget == null ? true : up ? vsBudget >= 0 : vsBudget <= 0,
            goodPrior: vsPrior == null ? true : up ? vsPrior >= 0 : vsPrior <= 0,
        };
    };
    const noi = (ls, key = "actual") => S(ls, rev, key) + S(ls, cor, key) + S(ls, opx, key);
    return [
        mk("Revenue", S(cur, rev), S(cur, rev, "budget"), py ? S(py, rev) : null, true),
        mk("Operating expenses", -S(cur, opx), -S(cur, opx, "budget"), py ? -S(py, opx) : null, false),
        mk("NOI", noi(cur), noi(cur, "budget"), py ? noi(py) : null, true),
        mk("Net income", sumLines(cur), sumLines(cur, () => true, "budget"), py ? sumLines(py) : null, true),
    ];
}
export const MATERIAL_ABS = 5000;
export const MATERIAL_PCT = 0.05;
/** Every line's variance to budget, ranked by size, with the sentence the page shows. */
export function variances(L, period, from = period) {
    const cur = incomeStatementWindow(L, from, period);
    const pyLines = lastYear(L, from, period);
    const py = pyLines ? new Map(pyLines.map((l) => [l.id, l.actual])) : null;
    return cur
        .map((l) => {
        // A line with no budget has nothing to vary from: it ranks last and is never "material".
        const hasBudget = Math.abs(l.budget) >= 0.005;
        const v = hasBudget ? l.actual - l.budget : 0;
        const p = hasBudget ? v / Math.abs(l.budget) : 0;
        const good = v >= 0;
        const material = hasBudget && (Math.abs(v) >= MATERIAL_ABS || Math.abs(p) >= MATERIAL_PCT);
        const pyv = py ? (py.get(l.id) ?? null) : null;
        return { ...l, v, p, good, material, py: pyv, text: hasBudget ? say(l, v, p, pyv) : "" };
    })
        .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}
function say(l, v, p, py) {
    const rev = isRevenue(l.account);
    const dir = rev ? (v >= 0 ? "above" : "below") : v >= 0 ? "under" : "over";
    const yoy = py == null ? null : (l.actual - py) / (Math.abs(py) || 1);
    const drv = yoy == null
        ? ""
        : Math.abs(yoy) > 0.05
            ? ` and ${pct(rev ? yoy : -yoy)} vs last year - a trend rather than a one-off`
            : ", in line with last year - worth checking the budget assumption";
    return `${money(Math.abs(v), { compact: true })} (${pct(p)}) ${dir} budget${drv}.`;
}
export function ytdVariance(L, period) {
    const from = `${period.slice(0, 4)}-01`;
    const lines = incomeStatementRange(L, from, period).map((l) => ({ ...l, v: l.actual - l.budget }));
    const rev = lines.filter((l) => isRevenue(l.account));
    const exp = lines.filter((l) => !isRevenue(l.account));
    const t = (ls, key) => ls.reduce((s, l) => s + l[key], 0);
    const pyFrom = shiftKey(from, 12);
    const py = L.months.includes(pyFrom) ? incomeStatementRange(L, pyFrom, shiftKey(period, 12)) : null;
    return {
        lines,
        revenue: { a: t(rev, "actual"), b: t(rev, "budget") },
        expense: { a: t(exp, "actual"), b: t(exp, "budget") },
        net: { a: t(lines, "actual"), b: t(lines, "budget") },
        largest: [...lines].sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 5),
        prior: py
            ? { revenue: sumLines(py, (l) => isRevenue(l.account)), expense: sumLines(py, (l) => !isRevenue(l.account)), net: sumLines(py) }
            : null,
    };
}
