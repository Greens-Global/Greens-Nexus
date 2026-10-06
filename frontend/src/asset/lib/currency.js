// World currencies for maintenance costs (Pranshu, 10/06). ISO 4217 codes from
// the browser (Intl.supportedValuesOf), the common ones first. A cost is always
// shown with its own currency, and totals are kept per currency - dollars and
// euros are never added together.
const COMMON = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'MXN', 'AUD', 'AED', 'JPY', 'CNY', 'CHF', 'SGD'];

let cached = null;
export function currencyOptions() {
  if (cached) return cached;
  let all = [];
  try { all = Intl.supportedValuesOf('currency'); } catch { all = COMMON; }
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'currency' }); } catch { names = null; }
  const label = (c) => {
    const n = names?.of(c);
    return n && n !== c ? `${c} - ${n}` : c;
  };
  const rest = all.filter((c) => !COMMON.includes(c));
  cached = [...COMMON.filter((c) => all.includes(c) || all === COMMON), ...rest].map((c) => ({ code: c, label: label(c) }));
  return cached;
}

/** "1240.50" + "EUR" -> "€1,240.50". Empty amount -> "". */
export function formatCost(amount, currency = 'USD') {
  if (amount === '' || amount == null) return '';
  const n = Number(String(amount).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(n)) return String(amount);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n);
  } catch {
    return `${currency || ''} ${n.toFixed(2)}`.trim();
  }
}

/** [{currency, amount}] -> "$1,245.00 · €200.00" ("" when nothing). */
export function formatTotals(totals) {
  return (totals || []).filter((t) => Number(t.amount) > 0).map((t) => formatCost(t.amount, t.currency)).join(' · ');
}
