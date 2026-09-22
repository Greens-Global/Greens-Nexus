import { covenantState, maturingSoon } from "./capital";
import { monthLong } from "./months";
export function attentionItems(args) {
    const items = [];
    const behind = args.recon.filter((r) => r.status === "Behind" || r.status === "Difference").length;
    if (behind)
        items.push({ severity: 0, text: `${behind} account${behind > 1 ? "s" : ""} behind on reconciliation`, target: "recon" });
    if (args.close && args.close.n) {
        const left = args.close.n - args.close.nDone;
        if (left > 0)
            items.push({ severity: left > 4 ? 1 : 2, text: `${left} close step${left > 1 ? "s" : ""} remaining for ${monthLong(args.period)}`, target: "close" });
    }
    const off = args.ic.filter((p) => !p.matched).length;
    if (off)
        items.push({ severity: 0, text: `${off} intercompany balance${off > 1 ? "s" : ""} out of sync`, target: "ic" });
    const maturing = args.loans.filter((l) => maturingSoon(l, args.period)).length;
    if (maturing)
        items.push({ severity: 1, text: `${maturing} loan${maturing > 1 ? "s" : ""} maturing within 18 months`, target: "debt" });
    const near = args.loans.filter((l) => { const c = covenantState(l); return c === "Near" || c === "Below"; }).length;
    if (near)
        items.push({ severity: 1, text: `${near} loan${near > 1 ? "s" : ""} near DSCR covenant`, target: "debt" });
    // Spent more than 5% over budget: both numbers negative, actual further below.
    const over = args.lines.filter((l) => l.actual < 0 && l.budget < 0 && l.actual < l.budget * 1.05).length;
    if (over)
        items.push({ severity: 1, text: `${over} expense line${over > 1 ? "s" : ""} more than 5% over budget`, target: "variance" });
    if (args.feed && args.feed.total)
        items.push({ severity: 1, text: `${args.feed.total} bank transaction${args.feed.total > 1 ? "s" : ""} need coding`, target: "uncat" });
    if (args.runway != null && args.runway > 0 && args.runway < 6)
        items.push({ severity: 0, text: `Liquidity runway under 6 months (${args.runway.toFixed(1)})`, target: "kpiRunway" });
    return items.sort((a, b) => a.severity - b.severity);
}
