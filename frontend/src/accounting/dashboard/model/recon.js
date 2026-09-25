import { inScope } from "./scope";
import { keyOfISO, mEnd, monthsBetween } from "./months";
/** The mark key for a ledger bank / card account within one entity. */
export const glReconKey = (accountId, entity) => `gl:${accountId}@${entity}`;
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
    const latestOf = new Map((args.latestMarks ?? []).map((m) => [m.recon_key, m]));
    const out = [];
    // Ledger bank / card accounts, one row per account and entity. A bank_accounts
    // row pointing at the same GL account is the richer record; skip the GL row then.
    const covered = new Set(args.banks.map((b) => b.gl_account_id).filter((x) => !!x));
    for (const g of args.glAccounts ?? []) {
        if (covered.has(g.account_id))
            continue;
        const key = glReconKey(g.account_id, g.entity);
        const book = g.balance;
        const type = g.kind === "card" ? "Credit Card" : "Bank";
        if (g.intacct_ref) {
            // Intacct's own last reconciliation decides (09/25) - a Nexus mark on
            // the same account is ignored, and an account Intacct has never
            // reconciled reads "Never". The statement balance is the one Intacct
            // reconciled to; book minus statement is outstanding items when the
            // months match, never a reason to call the account "Difference".
            const thru = g.intacct_thru ?? null;
            const lag = monthsLag(period, thru);
            const stmtRaw = thru ? g.intacct_stmt ?? null : null;
            const stmt = stmtRaw == null ? book : g.kind === "card" ? -Math.abs(stmtRaw) : stmtRaw;
            const diff = stmtRaw != null && thru && keyOfISO(thru) === period ? Math.round((book - stmt) * 100) / 100 : 0;
            out.push({
                key, type, name: g.name, ref: g.entity_name, entityCode: g.entity, gl: g.gl_code,
                thru, lag, openItems: 0, diff, mark: null, book, stmt, status: statusOf(lag, 0), nc: g.is_partner,
                source: "intacct", intacctRef: g.intacct_ref ?? "", intacctAsOf: g.intacct_asof ?? null,
            });
            continue;
        }
        const mark = markOf.get(key) ?? null;
        const latest = latestOf.get(key) ?? null;
        // Reconciled through: this month's mark, else the latest mark's statement
        // date (or that mark's month end when no date was typed).
        const thru = mark ? (mark.thru_date ?? pe) : latest ? (latest.thru_date ?? mEnd(latest.period ?? period)) : null;
        const lag = mark ? 0 : monthsLag(period, thru);
        // Statement balance from the mark that covers the month; a book-side
        // liability shows as the negative it is so Difference reads book - statement.
        const stmtRaw = mark?.stmt_balance ?? (lag === 0 ? latest?.stmt_balance ?? null : null);
        const stmt = stmtRaw == null ? book : g.kind === "card" ? -Math.abs(stmtRaw) : stmtRaw;
        const diff = stmtRaw == null ? 0 : Math.round((book - stmt) * 100) / 100;
        out.push({
            key, type, name: g.name, ref: g.entity_name, entityCode: g.entity, gl: g.gl_code,
            thru, lag, openItems: 0, diff, mark, book, stmt, status: statusOf(lag, diff), nc: g.is_partner,
            source: mark || latest ? "mark" : null,
        });
    }
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
