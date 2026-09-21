// Month keys ("YYYY-MM"), business-day math and the small date formats the
// Finance Dashboard uses. Pure functions; no React, no Date.now() unless a
// `today` is not supplied, so everything is testable.
const pad = (n) => String(n).padStart(2, "0");
export function monthKeyOf(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function keyOfISO(iso) {
    return iso.slice(0, 7);
}
export function parts(k) {
    const [y, m] = k.split("-").map(Number);
    return { y, m };
}
/** Month key `n` months EARLIER than `k` (negative n = later). */
export function shiftKey(k, n) {
    const { y, m } = parts(k);
    const d = new Date(y, m - 1 - n, 1);
    return monthKeyOf(d);
}
export function daysInMonth(k) {
    const { y, m } = parts(k);
    return new Date(y, m, 0).getDate();
}
export function mStart(k) {
    return `${k}-01`;
}
export function mEnd(k) {
    return `${k}-${pad(daysInMonth(k))}`;
}
/** Inclusive list of month keys from `a` to `b` (a <= b). */
export function monthsBetween(a, b) {
    const out = [];
    let k = a;
    let guard = 0;
    while (k <= b && guard++ < 600) {
        out.push(k);
        k = shiftKey(k, -1);
    }
    return out;
}
/** The last month before `today`'s month: the latest month that can be closed. */
export function lastClosedKey(today = new Date()) {
    return shiftKey(monthKeyOf(today), 1);
}
const parseISO = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d || 1);
};
export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "Aug" */
export function monthLabel(k) {
    return MONTH_SHORT[parts(k).m - 1] ?? k;
}
/** "Aug 2026" */
export function mShort(k) {
    const { y, m } = parts(k);
    return `${MONTH_SHORT[m - 1]} ${y}`;
}
/** "August 2026" */
export function monthLong(k) {
    const { y, m } = parts(k);
    return `${MONTH_LONG[m - 1]} ${y}`;
}
/** "Aug 31, 2026" */
export function fmtLong(iso) {
    const d = parseISO(iso);
    return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
/** "Aug 31" */
export function fmtMD(iso) {
    const d = parseISO(iso);
    return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}
/** "8/31" */
export function fmtNumMD(iso) {
    const d = parseISO(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
}
/** "08/31/2026" - the house date format. */
export function fmtMDY(iso) {
    const d = parseISO(iso);
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}
export function toISO(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDays(iso, n) {
    const d = parseISO(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
}
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
/** The date `n` business days after `fromISO` (weekends skipped, holidays not). n = 0 returns `fromISO`. */
export function busDay(fromISO, n) {
    const d = parseISO(fromISO);
    let left = n;
    while (left > 0) {
        d.setDate(d.getDate() + 1);
        if (!isWeekend(d))
            left--;
    }
    return toISO(d);
}
/** Business days from `periodEndISO` (exclusive) up to `iso` (inclusive); 0 when iso is on or before the period end. */
export function busDayIdx(periodEndISO, iso) {
    const end = parseISO(periodEndISO);
    const target = parseISO(iso);
    if (target <= end)
        return 0;
    let count = 0;
    const d = new Date(end);
    while (d < target) {
        d.setDate(d.getDate() + 1);
        if (!isWeekend(d))
            count++;
    }
    return count;
}
/** "today" / "yesterday" / "3 days ago" / "Aug 14" */
export function whenTxt(iso, now = new Date()) {
    if (!iso)
        return "";
    const t = new Date(iso);
    if (Number.isNaN(t.getTime()))
        return "";
    const days = Math.round((now.getTime() - t.getTime()) / 86400000);
    if (days <= 0)
        return "today";
    if (days === 1)
        return "yesterday";
    if (days < 7)
        return `${days} days ago`;
    return `${MONTH_SHORT[t.getMonth()]} ${t.getDate()}`;
}
/** Revenue and utilities seasonality used by the cash forecast: +3.5% in summer, -3.5% in winter. */
export function seasonal(monthNumber) {
    return 1 + 0.035 * Math.sin(((monthNumber - 3) * Math.PI) / 6);
}
