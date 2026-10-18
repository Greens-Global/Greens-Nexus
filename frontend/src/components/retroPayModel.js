// Retro Pay report helpers (RetroPayReport.jsx): money, hours, the default
// range and the CSV. US dates via lib/datetime.
import { formatDate } from '../lib/datetime';

const SYMBOLS = { USD: '$', INR: '₹', EUR: '€', GBP: '£', JPY: '¥' };
export function money(v, currency = 'USD') {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sym = SYMBOLS[currency] || `${currency} `;
  return `${n < 0 ? '-' : ''}${sym}${abs}`;
}
// A pay rate keeps up to 4 decimals (17.1234), never rounded to cents in the CSV.
const rateStr = (v) => (Number(v) || 0).toFixed(4).replace(/(\.\d\d\d?)0+$/, '$1').replace(/(\.\d\d)0$/, '$1');
export const hrs = (min) => ((Number(min) || 0) / 60).toFixed(2);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function defaultRange(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  return [iso(from), iso(now)];
}
export const span = (a, b) => `${formatDate(a)} - ${formatDate(b)}`;
export const rateNowText = (runs, currency, only) => (runs || []).map((r) => (
  only ? money(r.rate, currency) : `${money(r.rate, currency)} ${r.from === r.through ? `on ${formatDate(r.from)}` : `${formatDate(r.from)} - ${formatDate(r.through)}`}`
));

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function retroPayCsv(data) {
  const head = ['Employee', 'Email', 'Period Start', 'Period End', 'Currency', 'Regular Hours', 'OT Hours (1.5x)',
    'DT Hours (2x)', 'Leave Hours', 'Rate Paid', 'Rate Now', 'Paid', 'Now', 'Owed', 'Note'];
  const lines = [head];
  for (const p of data?.people || []) {
    for (const it of p.periods) {
      lines.push([p.name, p.email, formatDate(it.periodStart), formatDate(it.periodEnd), it.currency,
        hrs(it.hours.regMin), hrs(it.hours.otMin), hrs(it.hours.dtMin), hrs(it.hours.leaveMin),
        rateStr(it.ratePaid), (it.rateNow || []).map((r) => `${rateStr(r.rate)} (${formatDate(r.from)} - ${formatDate(r.through)})`).join('; '),
        it.paid.total.toFixed(2), it.now.total.toFixed(2), it.owed.toFixed(2),
        it.hours.holidayDays ? `Includes ${it.hours.holidayDays} paid holiday${it.hours.holidayDays === 1 ? '' : 's'}` : '']);
    }
  }
  for (const t of data?.totals || []) {
    lines.push([`Total ${t.currency}`, '', '', '', t.currency, hrs(t.regMin), hrs(t.otMin), hrs(t.dtMin), hrs(t.leaveMin),
      '', '', t.paid.toFixed(2), t.now.toFixed(2), t.owed.toFixed(2), '']);
  }
  for (const m of data?.checkManually || []) {
    lines.push([m.name, m.email, formatDate(m.periodStart), formatDate(m.periodEnd), m.currency, '', '', '', '',
      m.ratePaid == null ? '' : rateStr(m.ratePaid), (m.rateNow || []).map((r) => rateStr(r.rate)).join('; '),
      '', '', '', `Check manually: ${m.reason}`]);
  }
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
}

