// Hours read as hours:minutes (Neil, 11/04/2026): "8:15", never "8.25",
// "8.25 h" or "44:05 (44.08)". The one helper for hours a person reads.
// Exports that payroll or accounting import as numbers (QuickBooks IIF,
// CSV, Intacct) keep their decimal hours - this is for screens only.

// Minutes as H:MM, rounded to the minute: 495 -> "8:15", 5 -> "0:05",
// -90 -> "-1:30". `sign: true` puts "+" on a positive amount (a change).
// A missing or non-numeric value reads as "0:00".
// Big totals group their hours: 740730 -> "12,345:30".
export function formatHM(min, { sign = false } = {}) {
  const x = Number(min);
  const n = Number.isFinite(x) ? Math.round(x) : 0;
  const a = Math.abs(n);
  const pre = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  return `${pre}${Math.floor(a / 60).toLocaleString('en-US')}:${String(a % 60).padStart(2, '0')}`;
}

// Decimal hours (as the server sends some totals) as H:MM: 8.25 -> "8:15".
export const formatHoursHM = (hours, opts) => formatHM((Number(hours) || 0) * 60, opts);

// The same amount in words, for a line that also carries clock times
// ("7h 30m worked of 8h 00m from 9:00 AM"): minutes always padded, the
// hours grouped ("1,250h 30m"). `compact: true` drops "00m" on whole
// hours ("16h", "37h 30m") where a line used to read "16 h".
export function formatHMWords(min, { sign = false, compact = false } = {}) {
  const x = Number(min);
  const n = Number.isFinite(x) ? Math.round(x) : 0;
  const a = Math.abs(n);
  const pre = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  const h = `${pre}${Math.floor(a / 60).toLocaleString('en-US')}h`;
  if (compact && a % 60 === 0) return h;
  return `${h} ${String(a % 60).padStart(2, '0')}m`;
}

// Decimal hours (a server total) in words: 312.5 -> "312h 30m".
export const formatHoursWords = (hours, opts) => formatHMWords((Number(hours) || 0) * 60, opts);
