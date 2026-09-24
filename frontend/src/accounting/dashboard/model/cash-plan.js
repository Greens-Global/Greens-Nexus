import { balanceOf, cashAt, incomeStatement, isCapitalAsset, isConstruction, isDepreciation, isDistribution, isInsurance, isInterest, isPayroll, isPl, isRevenue, isTax, isWorkingCapitalAsset, plGroup, sumLines, } from "./ledger";
import { addDays, mEnd, monthsBetween, parts, seasonal, shiftKey } from "./months";
import { sum } from "./money";
export const SCENARIOS = {
    base: { id: "base", name: "Base", rent: 1, con: 1, vend: 1, dist: 1, note: "Trailing three-month run rate with seasonality." },
    down: { id: "down", name: "Downside", rent: 0.92, con: 0.6, vend: 1.05, dist: 1, note: "Collections -8%, construction billings -40%, vendor costs +5%." },
    up: { id: "up", name: "Upside", rent: 1.03, con: 1.15, vend: 0.98, dist: 0, note: "Collections +3%, construction +15%, distributions paused." },
};
export const CASH_CATS = [
    { dir: "in", id: "rent", label: "Rent and operating receipts" },
    { dir: "in", id: "con", label: "Construction billings" },
    { dir: "out", id: "pay", label: "Payroll and contractors" },
    { dir: "out", id: "vend", label: "Vendors and operating" },
    { dir: "out", id: "debt", label: "Debt service" },
    { dir: "out", id: "tax", label: "Taxes and insurance" },
    { dir: "out", id: "capex", label: "Capital projects and investments" },
    { dir: "out", id: "dist", label: "Owner distributions" },
];
const isCostLine = (l) => !isRevenue(l.account);
const isVendorLine = (l) => isCostLine(l) && l.group !== "Other" && !isPayroll(l.account) && !isTax(l.account) && !isInsurance(l.account) && !isDepreciation(l.account) && !isInterest(l.account);
/** Signed category amounts from one month's income statement (debt service is the loan schedule, not the ledger). */
export function categorize(lines, loans) {
    return {
        rent: sumLines(lines, (l) => isRevenue(l.account) && !isConstruction(l.account)),
        con: sumLines(lines, (l) => isRevenue(l.account) && isConstruction(l.account)),
        pay: sumLines(lines, (l) => isCostLine(l) && isPayroll(l.account)),
        vend: sumLines(lines, isVendorLine),
        debt: -sum(loans.filter((x) => x.is_active).map((x) => x.monthly_pi)),
        tax: sumLines(lines, (l) => isCostLine(l) && (isTax(l.account) || isInsurance(l.account))),
        capex: 0,
        dist: 0,
    };
}
/** One actual month: category amounts, opening and ending cash, and the reconciling "other". */
export function cashMonth(L, loans, k) {
    const lines = incomeStatement(L, k);
    const v = { ...categorize(lines, loans), other: 0 };
    const pk = shiftKey(k, 1);
    const hasPrior = L.months.includes(pk);
    const capNow = balanceOf(L, k, (a) => a.section === "asset" && !a.cash && isCapitalAsset(a) && !isWorkingCapitalAsset(a));
    const capPrev = hasPrior ? balanceOf(L, pk, (a) => a.section === "asset" && !a.cash && isCapitalAsset(a) && !isWorkingCapitalAsset(a)) : capNow;
    v.capex = Math.round(-(capNow - capPrev));
    const distNow = balanceOf(L, k, (a) => a.section === "equity" && isDistribution(a));
    const distPrev = hasPrior ? balanceOf(L, pk, (a) => a.section === "equity" && isDistribution(a)) : distNow;
    v.dist = Math.round(-Math.max(0, distNow - distPrev)); // distributions carry a debit balance; growth = cash out
    for (const c of CASH_CATS)
        v[c.id] = Math.round(v[c.id]);
    const end = Math.round(cashAt(L, k));
    const beg = hasPrior ? Math.round(cashAt(L, pk)) : null;
    const net = CASH_CATS.reduce((t, c) => t + v[c.id], 0);
    v.other = beg == null ? 0 : Math.round(end - beg - net);
    return { k, v, beg, end, actual: true };
}
/** Twelve actual months ending at `period`, then six forecast months under a scenario. */
export function cashPlan(L, loans, period, scenario) {
    const keys = monthsBetween(shiftKey(period, 11), period).filter((k) => L.months.includes(k));
    const hist = keys.map((k) => cashMonth(L, loans, k));
    const base = hist.slice(-3);
    const avg = (id) => (base.length ? sum(base.map((h) => h.v[id])) / base.length : 0);
    const fc = [];
    let beg = hist.length ? hist[hist.length - 1].end : 0;
    let k = period;
    for (let n = 1; n <= 6; n++) {
        k = shiftKey(k, -1);
        const mo = parts(k).m;
        const v = {
            rent: Math.round(avg("rent") * seasonal(mo) * scenario.rent),
            con: Math.round(avg("con") * scenario.con),
            pay: Math.round(avg("pay")),
            vend: Math.round(avg("vend") * scenario.vend),
            debt: Math.round(avg("debt")),
            tax: Math.round(avg("tax") * (mo === 12 || mo === 4 ? 3.2 : 0.6)),
            capex: Math.round(avg("capex") * (n <= 3 ? 1.2 : 0.8)),
            dist: Math.round(avg("dist") * scenario.dist),
            other: 0,
        };
        const end = beg + CASH_CATS.reduce((t, c) => t + v[c.id], 0);
        fc.push({ k, v, beg, end, actual: false });
        beg = end;
    }
    // What the plan would have forecast for the last closed month one month
    // earlier: the three months before it, with the rent seasonality applied.
    const prev3 = hist.slice(-4, -1);
    const fcLast = Object.fromEntries(CASH_CATS.map((c) => {
        const m = prev3.length ? sum(prev3.map((h) => h.v[c.id])) / prev3.length : 0;
        return [c.id, Math.round(m * (c.id === "rent" ? seasonal(parts(period).m) : 1))];
    }));
    const last = hist[hist.length - 1] ?? { k: period, v: { rent: 0, con: 0, pay: 0, vend: 0, debt: 0, tax: 0, capex: 0, dist: 0, other: 0 }, beg: null, end: 0, actual: true };
    return { hist, fc, last, fcLast };
}
/** Fixed monthly obligations: payroll, taxes, insurance, interest from the ledger plus the principal share of debt service. */
export function fixedMonthly(lines, loans) {
    const fromLedger = -sumLines(lines, (l) => isCostLine(l) && (isPayroll(l.account) || isTax(l.account) || isInsurance(l.account) || isInterest(l.account)));
    const principal = sum(loans.filter((x) => x.is_active).map((x) => x.monthly_pi)) * 0.35;
    return fromLedger + principal;
}
/** Months the liquid balance covers fixed obligations; 0 when there are none recorded. */
export function runwayMonths(liquid, fixed) {
    return fixed > 0 ? liquid / fixed : 0;
}
const hash01 = (s) => {
    let h = 2166136261;
    for (const c of s) {
        h ^= c.charCodeAt(0);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
};
/**
 * Month-by-month cash forecast from the POSTED BUDGET (Charmi, 09/23: monthly,
 * not weekly; Neil: the figures come from budgets, and until budgets are
 * uploaded there is nothing to forecast). Each future month's receipts and
 * costs are its budget lines by category; debt service is the loan schedule;
 * distributions come from partner capital. No run-rate, no seasonality, no
 * jitter - a month with no budget lines is flagged, and with none at all
 * `hasBudget` is false and the widget says so instead of inventing numbers.
 */
export function forecastMonthly(L, budgetAhead, loans, period, openingCash, distributionsPerMonth, months = 6) {
    const keys = [];
    let k = period;
    for (let n = 1; n <= months; n++) {
        k = shiftKey(k, -1);
        keys.push(k);
    }
    const byMonth = new Map();
    for (const r of budgetAhead) {
        if (!keys.includes(r.month))
            continue;
        const m = byMonth.get(r.month) ?? new Map();
        m.set(r.account_id, (m.get(r.account_id) ?? 0) + r.amount);
        byMonth.set(r.month, m);
    }
    const debt = sum(loans.filter((x) => x.is_active).map((x) => x.monthly_pi));
    const out = { months: keys, budgeted: [], hasBudget: false, rent: [], con: [], pay: [], vend: [], debt: [], tax: [], dist: [], receipts: [], disbursements: [], end: [], minCash: 0, opening: openingCash };
    let bal = openingCash;
    let firstPay = 0;
    keys.forEach((mk, i) => {
        const m = byMonth.get(mk) ?? new Map();
        // Budget amounts are signed like the income statement: revenue +, costs -.
        const lines = [];
        for (const [id, amount] of m) {
            const a = L.accounts.get(id);
            if (!a || !isPl(a) || Math.abs(amount) < 0.005)
                continue;
            lines.push({ id, gl: a.gl, name: a.name, group: plGroup(a), account: a, actual: amount, budget: amount, prior: 0 });
        }
        const budgeted = lines.length > 0;
        const cat = categorize(lines, []);
        const tax = sumLines(lines, (l) => isCostLine(l) && (isTax(l.account) || isInsurance(l.account)));
        const r = Math.round(cat.rent), c = Math.round(cat.con), p = Math.round(cat.pay), v = Math.round(cat.vend), t = Math.round(tax);
        const db = -Math.round(debt), ds = -Math.round(distributionsPerMonth);
        if (i === 0)
            firstPay = Math.abs(p);
        out.budgeted.push(budgeted);
        out.rent.push(r);
        out.con.push(c);
        out.pay.push(p);
        out.vend.push(v);
        out.debt.push(db);
        out.tax.push(t);
        out.dist.push(ds);
        const rec = r + c, dis = p + v + db + t + ds;
        out.receipts.push(rec);
        out.disbursements.push(dis);
        bal += rec + dis;
        out.end.push(bal);
    });
    out.hasBudget = out.budgeted.some(Boolean);
    out.minCash = Math.round(firstPay + debt);
    return out;
}
/** Thirteen weeks of receipts and disbursements projected from the last closed month, starting from controllable cash. */
export function forecast13(lines, loans, period, openingCash, distributionsPerMonth) {
    const cat = categorize(lines, loans);
    const rent = cat.rent;
    const con = Math.abs(cat.con);
    const pay = Math.abs(cat.pay);
    const vend = Math.abs(cat.vend);
    const ins = Math.abs(sumLines(lines, (l) => isCostLine(l) && isInsurance(l.account)));
    const tax = Math.abs(sumLines(lines, (l) => isCostLine(l) && isTax(l.account)));
    const debt = sum(loans.filter((x) => x.is_active).map((x) => x.monthly_pi));
    const weeks = [];
    let d = addDays(mEnd(period), 1);
    for (let i = 0; i < 13; i++) {
        weeks.push(d);
        d = addDays(d, 7);
    }
    const out = { weeks, rent: [], con: [], pay: [], vend: [], debt: [], tax: [], ins: [], dist: [], receipts: [], disbursements: [], end: [], minCash: Math.round(pay + debt), opening: openingCash };
    let bal = openingCash;
    weeks.forEach((w, i) => {
        const dom = Number(w.slice(8, 10));
        const mo = Number(w.slice(5, 7));
        const mw = i % 4;
        const r = Math.round(rent * (dom <= 7 ? 0.55 : dom <= 14 ? 0.25 : dom <= 21 ? 0.12 : 0.08));
        const c = mw === 2 ? Math.round(con) : 0;
        const p = -(i % 2 === 1 ? Math.round(pay / 2) : 0);
        const v = -Math.round((vend / 4.33) * (0.85 + hash01(`v${i}`) * 0.3));
        const db = -(dom <= 7 ? Math.round(debt) : 0);
        const t = -((mo === 12 || mo === 4) && dom <= 10 ? Math.round(tax * 6) : 0);
        const n = -(dom <= 7 ? Math.round(ins) : 0);
        const ds = -(mw === 3 ? Math.round(distributionsPerMonth) : 0);
        out.rent.push(r);
        out.con.push(c);
        out.pay.push(p);
        out.vend.push(v);
        out.debt.push(db);
        out.tax.push(t);
        out.ins.push(n);
        out.dist.push(ds);
        const rec = r + c, dis = p + v + db + t + n + ds;
        out.receipts.push(rec);
        out.disbursements.push(dis);
        bal += rec + dis;
        out.end.push(bal);
    });
    return out;
}
