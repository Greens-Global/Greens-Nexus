import { monthsBetween, shiftKey } from "./months";
export const PL_GROUPS = ["Revenue", "Cost of Revenue", "Operating Expenses", "Other"];
const PL_SECTIONS = new Set(["revenue", "other_income", "cogs", "expense", "other_expense"]);
export const isPl = (a) => PL_SECTIONS.has(a.section);
export const isRevenue = (a) => a.section === "revenue" || a.section === "other_income";
export const isBalance = (a) => !isPl(a);
export function plGroup(a) {
    if (isRevenue(a))
        return "Revenue";
    if (a.section === "cogs")
        return "Cost of Revenue";
    if (a.section === "expense")
        return "Operating Expenses";
    return "Other";
}
// Keyword classifiers replace the prototype's GL-number prefixes: Greens'
// chart of accounts is Intacct's, and codes are strings with no fixed ranges.
const re = (p) => (a) => p.test(a.name);
export const isConstruction = re(/construct|contract revenue|job revenue/i);
export const isPayroll = re(/payroll|salar|wage|contractor|commission/i);
export const isTax = re(/\btax/i);
export const isInsurance = re(/insurance/i);
export const isInterest = re(/interest/i);
export const isDepreciation = re(/depreciat|amortiz/i);
export const isUtilities = re(/utilit|electric|water|gas\b|sewer|trash/i);
export const isCapitalAsset = re(/construction in progress|\bcip\b|improvement|building|equipment|land\b|fixed asset|furniture|vehicle|investment|securit|brokerage/i);
export const isWorkingCapitalAsset = re(/receivable|prepaid|deposit|escrow|inventory|due from|advance/i);
export const isDistribution = re(/distribut|\bdraw|dividend|withdrawal/i);
export const isCurrentYearEarnings = re(/current year|net income|retained/i);
export function buildLedger(data, budget = []) {
    const accounts = new Map(data.accounts.map((a) => [a.id, a]));
    const pl = new Map();
    const bsAct = new Map();
    for (const r of data.rows) {
        const a = accounts.get(r.a);
        if (!a)
            continue;
        if (isPl(a)) {
            const m = pl.get(r.a) ?? new Map();
            m.set(r.m, (m.get(r.m) ?? 0) + (r.c - r.d));
            pl.set(r.a, m);
        }
        else {
            const m = bsAct.get(r.a) ?? new Map();
            m.set(r.m, (m.get(r.m) ?? 0) + (r.d - r.c));
            bsAct.set(r.a, m);
        }
    }
    const open = new Map(data.open.map((o) => [o.a, o.b]));
    const bud = new Map();
    for (const b of budget) {
        const a = accounts.get(b.account_id);
        // Budgets are entered unsigned; a revenue budget is income, anything else a cost.
        const signed = a && !isRevenue(a) ? -Math.abs(b.amount) : Math.abs(b.amount);
        const m = bud.get(b.account_id) ?? new Map();
        m.set(b.month, (m.get(b.month) ?? 0) + signed);
        bud.set(b.account_id, m);
    }
    return { data, accounts, pl, bsAct, open, months: monthsBetween(data.from.slice(0, 7), data.to.slice(0, 7)), budget: bud };
}
/** Income statement for one month: every P&L account with activity or budget, with prior month. */
export function incomeStatement(L, k) {
    const pk = shiftKey(k, 1);
    const out = [];
    const ids = new Set([...L.pl.keys(), ...L.budget.keys()]);
    for (const id of ids) {
        const a = L.accounts.get(id);
        if (!a || !isPl(a))
            continue;
        const actual = L.pl.get(id)?.get(k) ?? 0;
        const budget = L.budget.get(id)?.get(k) ?? 0;
        const prior = L.pl.get(id)?.get(pk) ?? 0;
        if (Math.abs(actual) < 0.005 && Math.abs(budget) < 0.005)
            continue;
        out.push({ id, gl: a.gl, name: a.name, group: plGroup(a), account: a, actual, budget, prior });
    }
    return out.sort((x, y) => PL_GROUPS.indexOf(x.group) - PL_GROUPS.indexOf(y.group) || x.gl.localeCompare(y.gl, "en-US", { numeric: true }));
}
/** Income statement summed over several months (year to date, trailing 12). */
export function incomeStatementRange(L, from, to) {
    const keys = monthsBetween(from, to);
    const acc = new Map();
    for (const k of keys) {
        for (const l of incomeStatement(L, k)) {
            const cur = acc.get(l.id);
            if (cur) {
                cur.actual += l.actual;
                cur.budget += l.budget;
                cur.prior += l.prior;
            }
            else
                acc.set(l.id, { ...l });
        }
    }
    return [...acc.values()].sort((x, y) => PL_GROUPS.indexOf(x.group) - PL_GROUPS.indexOf(y.group) || x.gl.localeCompare(y.gl, "en-US", { numeric: true }));
}
/** The equal-length run of months just before [from, to]: the "prior period" for a range. */
export function priorRange(from, to) {
    const n = monthsBetween(from, to).length;
    return { from: shiftKey(from, n), to: shiftKey(to, n) };
}
/**
 * Income statement over [from, to] where `prior` is the PRECEDING run of the
 * same length (a quarter compares to the quarter before it), not the sum of
 * each month's previous month. For a single month it equals incomeStatement.
 */
export function incomeStatementWindow(L, from, to) {
    if (from === to)
        return incomeStatement(L, to);
    const cur = incomeStatementRange(L, from, to);
    const p = priorRange(from, to);
    const prev = new Map(incomeStatementRange(L, p.from, p.to).map((l) => [l.id, l.actual]));
    return cur.map((l) => ({ ...l, prior: prev.get(l.id) ?? 0 }));
}
export const sumLines = (ls, f = () => true, key = "actual") => ls.reduce((t, l) => (f(l) ? t + l[key] : t), 0);
/** Revenue / expense / net income per month across the loaded window, plus month-end cash. */
export function monthTotals(L) {
    const cash = cashTrend(L);
    return L.months.map((k, i) => {
        let revenue = 0, expense = 0, budgetRevenue = 0, budgetExpense = 0;
        for (const [id, m] of L.pl) {
            const a = L.accounts.get(id);
            const v = m.get(k) ?? 0;
            if (isRevenue(a))
                revenue += v;
            else
                expense -= v;
        }
        for (const [id, m] of L.budget) {
            const a = L.accounts.get(id);
            const v = m.get(k) ?? 0;
            if (a && isRevenue(a))
                budgetRevenue += v;
            else
                budgetExpense -= v;
        }
        return { month: k, revenue, expense, net: revenue - expense, budgetRevenue, budgetExpense, cash: cash[i] };
    });
}
/** Balance (debit - credit) of every balance-sheet account at the end of month `k`. */
export function balancesAt(L, k) {
    const out = new Map();
    const ids = new Set([...L.open.keys(), ...L.bsAct.keys()]);
    for (const id of ids) {
        const a = L.accounts.get(id);
        if (!a || isPl(a))
            continue;
        let b = L.open.get(id) ?? 0;
        const acts = L.bsAct.get(id);
        if (acts)
            for (const [m, v] of acts)
                if (m <= k)
                    b += v;
        out.set(id, b);
    }
    return out;
}
/** Balance sheet rows at month end, liabilities and equity shown positive. Current-year earnings are derived, not an account. */
export function balanceSheet(L, k) {
    const bal = balancesAt(L, k);
    const rows = [];
    let assets = 0, liabilities = 0, equity = 0;
    for (const [id, b] of bal) {
        const a = L.accounts.get(id);
        const section = a.section === "asset" ? "asset" : a.section === "liability" ? "liability" : "equity";
        const balance = section === "asset" ? b : -b;
        if (Math.abs(balance) < 0.005)
            continue;
        rows.push({ id, gl: a.gl, name: a.name, section, account: a, balance });
        if (section === "asset")
            assets += balance;
        else if (section === "liability")
            liabilities += balance;
        else
            equity += balance;
    }
    // Unclosed profit lives in the P&L accounts until year end: the plug that
    // balances the sheet is the earnings since the last close.
    const earnings = assets - liabilities - equity;
    rows.sort((x, y) => ["asset", "liability", "equity"].indexOf(x.section) - ["asset", "liability", "equity"].indexOf(y.section) || x.gl.localeCompare(y.gl, "en-US", { numeric: true }));
    return { rows, assets, liabilities, equity: equity + earnings, earnings };
}
/** Month-end cash on hand (all cash accounts in scope) for every loaded month. */
export function cashTrend(L) {
    const cashIds = [...L.accounts.values()].filter((a) => a.cash).map((a) => a.id);
    let running = cashIds.reduce((t, id) => t + (L.open.get(id) ?? 0), 0);
    return L.months.map((k) => {
        for (const id of cashIds)
            running += L.bsAct.get(id)?.get(k) ?? 0;
        return running;
    });
}
export function cashAt(L, k) {
    const i = L.months.indexOf(k);
    if (i < 0)
        return 0;
    return cashTrend(L)[i];
}
/** Sum of balances at `k` for accounts matching a predicate (debit - credit). */
export function balanceOf(L, k, f) {
    let t = 0;
    for (const [id, b] of balancesAt(L, k))
        if (f(L.accounts.get(id)))
            t += b;
    return t;
}
