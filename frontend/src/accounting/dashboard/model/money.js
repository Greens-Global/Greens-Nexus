// Number formats for the Finance Dashboard. Amounts are stored in USD; an
// INR entity shows rupees at the configured rate ("₹" and Indian grouping).
/** USD -> INR display rate. Overridable from the dashboard context. */
export const FX_INR_DEFAULT = 83.4;
export function money(v, opt = {}) {
    const inr = opt.currency === "INR";
    const x = inr ? v * (opt.fx ?? FX_INR_DEFAULT) : v;
    const a = Math.abs(x);
    let s;
    if (opt.compact) {
        if (inr && a >= 1e7)
            s = `${(a / 1e7).toFixed(2)} Cr`;
        else if (a >= 1e6)
            s = `${(a / 1e6).toFixed(2)}M`;
        else if (a >= 1e3)
            s = `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
        else
            s = a.toFixed(0);
    }
    else {
        s = a.toLocaleString(inr ? "en-IN" : "en-US", {
            minimumFractionDigits: opt.cents ? 2 : 0,
            maximumFractionDigits: opt.cents ? 2 : 0,
        });
    }
    s = (inr ? "₹" : "$") + s;
    if (x < -0.004)
        return opt.paren ? `(${s})` : `-${s}`;
    return s;
}
/** "+12.3%" / "-4.0%" */
export function pct(v) {
    if (!Number.isFinite(v))
        return "-";
    return `${v >= 0 ? "+" : "-"}${Math.abs(v * 100).toFixed(1)}%`;
}
/** "12.3%" (unsigned) */
export function pctTxt(v, digits = 1) {
    if (!Number.isFinite(v))
        return "-";
    return `${(v * 100).toFixed(digits)}%`;
}
/** Relative change; null when there is no base to compare against. */
export function change(now, prev) {
    if (!prev || !Number.isFinite(prev))
        return null;
    return (now - prev) / Math.abs(prev);
}
export const sum = (xs) => xs.reduce((t, x) => t + (x || 0), 0);
