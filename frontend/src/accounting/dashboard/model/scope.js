export const SCOPE_LABEL = {
    ALL: "All Entities (Consolidated)",
    CTL: "Controllable Entities Only",
    NC: "Partner Entities Only (Non-Controllable)",
};
export const isGroupScope = (s) => s === "ALL" || s === "CTL" || s === "NC";
export function indexEntities(entities) {
    const byCode = new Map(entities.map((e) => [e.code, e]));
    const rootCache = new Map();
    const rootOf = (code) => {
        if (!code)
            return "";
        const hit = rootCache.get(code);
        if (hit)
            return hit;
        let cur = byCode.get(code);
        if (!cur) {
            // "12027-1" style child codes with no row of their own roll up by prefix.
            const dash = code.lastIndexOf("-");
            const r = dash > 0 && byCode.has(code.slice(0, dash)) ? rootOf(code.slice(0, dash)) : code;
            rootCache.set(code, r);
            return r;
        }
        let guard = 0;
        while (cur.parent_code && byCode.has(cur.parent_code) && guard++ < 50)
            cur = byCode.get(cur.parent_code);
        rootCache.set(code, cur.code);
        return cur.code;
    };
    const root = (code) => byCode.get(rootOf(code));
    const isPartner = (code) => !!root(code)?.is_partner;
    const roots = entities.filter((e) => !e.parent_code || !byCode.has(e.parent_code));
    return { byCode, rootOf, root, isPartner, roots };
}
/** Does a row tagged with `code` belong to the selected scope? Mirrors the server's _rpt_scope_codes. */
export function inScope(ix, code, scope) {
    if (scope === "ALL")
        return true;
    if (scope === "CTL")
        return !ix.isPartner(code);
    if (scope === "NC")
        return !!code && ix.isPartner(code);
    return ix.rootOf(code) === scope || code === scope || code.startsWith(`${scope}-`);
}
export function scopeLabel(ix, scope) {
    if (isGroupScope(scope))
        return SCOPE_LABEL[scope];
    const e = ix.byCode.get(scope);
    return e?.name || scope;
}
/** A short name for tight table cells: first two words, or the code. */
export function entityShort(ix, code) {
    const e = ix.root(code) ?? ix.byCode.get(code);
    if (!e || !e.name)
        return code || "No entity";
    const words = e.name.replace(/,.*$/, "").split(/\s+/).filter(Boolean);
    return words.slice(0, 2).join(" ");
}
/** Currency to display for a scope: INR only when a single INR entity is selected. */
export function scopeCurrency(ix, scope) {
    if (isGroupScope(scope))
        return "USD";
    return ix.byCode.get(scope)?.currency === "INR" ? "INR" : "USD";
}
