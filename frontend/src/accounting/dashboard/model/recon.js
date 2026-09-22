import { inScope } from "./scope";
import { keyOfISO, mEnd, monthsBetween } from "./months";
export const RECON_TYPES = ["Bank", "Credit Card", "Mortgage", "Line of Credit", "Investment"];
const monthsLag = (period, thru) => {
    if (!thru)
        return 99;
    const k = keyOfISO(thru);
    if (k >= period)
        return 0;
    return monthsBetween(k, period).length - 1;
};
const statusOf = (lag, diff) => lag === 0 && Math.abs(diff) < 0.005 ? "Reconciled" : lag === 0 ? "Difference" : lag === 1 ? "In progress" : "Behind";
export function reconList(args) {
    const { period, scope, ix } = args;
    const pe = mEnd(period);
    const markOf = new Map(args.marks.map((m) => [m.recon_key, m]));
    const out = [];
    for (const b of args.banks) {
        const key = `bank:${b.id}`;
        const rec = args.recons.find((r) => r.bank_account_id === b.id) ?? null;
        const mark = markOf.get(key) ?? null;
        const isCard = /credit|card/i.test(b.account_type) || /credit|card/i.test(b.nickname);
        const thru = mark ? pe : (rec?.statement_date ?? rec?.reconciliation_date ?? null);
        const lag = mark ? 0 : monthsLag(period, thru);
        const diff = mark ? 0 : rec && lag === 0 ? rec.difference : 0;
        const book = b.gl_account_id ? args.glBalance(b.gl_account_id) : 0;
        const stmt = rec && lag === 0 ? rec.ending_balance : book;
        out.push({
            key, type: isCard ? "Credit Card" : "Bank", name: b.nickname || b.bank_name, ref: b.masked_number ? `····${b.masked_number.slice(-4)}` : b.bank_name,
            entityCode: "", gl: b.gl_account_id ? args.glCode(b.gl_account_id) : "", thru, lag, openItems: 0, diff, mark, book, stmt, status: statusOf(lag, diff), nc: false,
        });
    }
    for (const l of args.loans.filter((x) => x.is_active)) {
        if (!inScope(ix, l.entity_code, scope))
            continue;
        const key = `loan:${l.id}`;
        const mark = markOf.get(key) ?? null;
        const isLoc = /line|revolv|\bloc\b/i.test(l.lender) || /line|revolv/i.test(l.notes);
        out.push({
            key, type: isLoc ? "Line of Credit" : "Mortgage", name: l.lender, ref: ix.byCode.get(l.entity_code)?.name || l.entity_code, entityCode: l.entity_code, gl: "",
            thru: mark ? pe : null, lag: mark ? 0 : 99, openItems: 0, diff: 0, mark, book: -l.balance, stmt: -l.balance,
            status: mark ? "Reconciled" : "Behind", nc: ix.isPartner(l.entity_code),
        });
    }
    const byAcct = new Map();
    for (const h of args.holdings) {
        if (!inScope(ix, h.entity_code, scope))
            continue;
        const arr = byAcct.get(h.account_label) ?? [];
        arr.push(h);
        byAcct.set(h.account_label, arr);
    }
    for (const [label, hs] of byAcct) {
        const key = `holding:${label}`;
        const mark = markOf.get(key) ?? null;
        const mv = hs.reduce((t, h) => t + h.market_value, 0);
        const gl = hs.find((h) => h.gl_account_id)?.gl_account_id ?? null;
        out.push({
            key, type: "Investment", name: label, ref: hs.map((h) => h.symbol).filter(Boolean).join(", "), entityCode: hs[0].entity_code, gl: gl ? args.glCode(gl) : "",
            thru: mark ? pe : null, lag: mark ? 0 : 99, openItems: 0, diff: 0, mark, book: gl ? args.glBalance(gl) : mv, stmt: mv,
            status: mark ? "Reconciled" : "Behind", nc: ix.isPartner(hs[0].entity_code),
        });
    }
    return out.sort((a, b) => RECON_TYPES.indexOf(a.type) - RECON_TYPES.indexOf(b.type) || a.name.localeCompare(b.name));
}
