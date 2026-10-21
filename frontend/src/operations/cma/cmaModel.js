// Rate Management / CMA (Miranda, Oct 21 2026): what the four screens share -
// money and percent text, the nearest-size match the survey form shows, and
// the CSV / XLS export (Miranda: "export CSV/XLS, not PDF") and import.
// Every figure comes from the server (backend/ops_cma.py); this only formats.
import { money } from '../model';
import { formatDate } from '../../lib/datetime';
import { csvName, downloadCsv } from '../csv';

export const dash = '-';
export const usd = (c) => (c == null ? dash : money(c, { exact: c % 100 !== 0 }));
export const usdExact = (c) => (c == null ? dash : money(c, { exact: true }));
export const signedUsd = (c) => (c == null ? dash : `${c > 0 ? '+' : c < 0 ? '-' : ''}${usd(Math.abs(c))}`);
export const pctText = (x, digits = 1) => (x == null ? dash : `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`);
export const occText = (r) => (r.total ? `${(r.occupancy * 100).toFixed(1)}%` : dash);
export const toCents = (s) => {
  const n = Number(String(s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

// "-$20.03 · -15.0%" (blue when we are below the market average).
export const varianceText = (r) => (r.variance == null ? dash : `${signedUsd(r.variance)} · ${pctText(r.variancePct)}`);

// "Storage · drive-up" / "Parking · gravel, drive-in" under the size.
export function sizeLine(r) {
  const n = (r.name || '').toLowerCase();
  const kind = r.parking || r.category === 'Vehicle Storage' ? 'Parking' : 'Storage';
  const bits = [];
  for (const [re, word] of [[/drive[- ]?up/, 'drive-up'], [/interior/, 'interior'], [/climate|\bcc\b/, 'climate'],
    [/gravel/, 'gravel'], [/asphalt|paved/, 'asphalt'], [/covered/, 'covered'], [/pull[- ]?thr/, 'pull-thru'], [/drive[- ]?in/, 'drive-in']]) {
    if (re.test(n)) bits.push(word);
  }
  return bits.length ? `${kind} · ${bits.join(', ')}` : kind;
}

// The unit size alone: "12' x 32'".
export const sizeOf = (r) => (r.width && r.depth ? `${r.width}' x ${r.depth}'` : r.name);

// "8 x 10", "8'x10'" -> [8, 10]; null when it does not read as a size.
export function parseSize(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*['’]?\s*(?:x|X|×|\*|by)\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const w = Number(m[1]); const d = Number(m[2]);
  return w > 0 && d > 0 ? [w, d] : null;
}

// Our unit type for a competitor's quoted size: the exact size and kind, else
// the nearest by area of the same kind (the server applies the same rule).
export function nearestType(text, parking, unitTypes) {
  const size = parseSize(text);
  if (!size) return { name: '', exact: false, note: '' };
  const [w, d] = size;
  const same = (unitTypes || []).filter((t) => t.width && t.depth && Boolean(t.parking) === Boolean(parking));
  const key = (a, b) => [a, b].sort((x, y) => x - y).join('x');
  const exact = same.find((t) => key(t.width, t.depth) === key(w, d));
  if (exact) return { name: exact.name, exact: true, note: '' };
  if (!same.length) return { name: '', exact: false, note: 'We have no unit of this kind' };
  const area = w * d;
  const best = [...same].sort((a, b) => Math.abs(a.width * a.depth - area) - Math.abs(b.width * b.depth - area) || a.name.localeCompare(b.name))[0];
  return { name: best.name, exact: false, note: `Nearest size to their ${w}' x ${d}'` };
}

const SOURCE = { web: 'Website', stortrack: 'Website', manual: 'Manual', override: 'Manual Override', import: 'Manual' };
export const sourceLabel = (s) => SOURCE[s] || 'Manual';

// ── Export: CSV and XLS ─────────────────────────────────────────────────────
// columns: [{ header, get, width }]. XLS uses the project's own xlsx helper
// (tasks/exporting.js), loaded only when someone exports.
export async function exportRows(format, { title, facility, asOf, columns, rows }) {
  const name = csvName(title, facility, asOf).replace(/\.csv$/, '');
  if (format === 'xls') {
    const { exportExcel } = await import('../../tasks/exporting');
    await exportExcel({ filename: `${name}.xlsx`, title, columns, rows });
    return;
  }
  downloadCsv(`${name}.csv`, columns.map((c) => c.header), rows.map((r) => columns.map((c) => c.get(r))));
}

export const OVERVIEW_COLUMNS = [
  { header: 'Category', get: (r) => r.category, width: 16 },
  { header: 'Unit Type', get: (r) => r.name, width: 26 },
  { header: 'Total', get: (r) => r.total, width: 8 },
  { header: 'Vacant', get: (r) => r.vacant, width: 8 },
  { header: 'Offline', get: (r) => r.offline, width: 8 },
  { header: 'Occ.', get: (r) => occText(r), width: 8 },
  { header: 'Avg Days Vacant', get: (r) => (r.avgDaysVacant == null ? '' : r.avgDaysVacant), width: 14 },
  { header: 'Current Standard Rate', get: (r) => usdExact(r.set), width: 18 },
  { header: 'Web Rate', get: (r) => usdExact(r.algorithmWebRate ?? r.sell), width: 12 },
  { header: 'Walk-In Rate', get: (r) => usdExact(r.walkIn), width: 12 },
  { header: 'Mkt Low', get: (r) => usdExact(r.marketLow), width: 11 },
  { header: 'Mkt High', get: (r) => usdExact(r.marketHigh), width: 11 },
  { header: 'Mkt Avg', get: (r) => usdExact(r.marketAvg), width: 11 },
  { header: 'Variance', get: (r) => varianceText(r), width: 18 },
  { header: 'Comps', get: (r) => r.competitors, width: 7 },
  { header: 'Comps Running a Promotion', get: (r) => (r.promoBy || []).join('; '), width: 30 },
  { header: 'Comp Admin Fee', get: (r) => feeRange(r), width: 14 },
  { header: 'Suggested', get: (r) => usdExact(r.suggested), width: 11 },
  { header: 'Why', get: (r) => r.why, width: 44 },
  { header: 'Proposed', get: (r) => usdExact(r.proposed), width: 11 },
  { header: 'Rev. Change / Mo', get: (r) => (r.proposed == null ? '' : signedUsd(r.revDelta)), width: 14 },
  { header: 'Nearest Size', get: (r) => r.nearestSize || '', width: 12 },
];

export function feeRange(r) {
  if (r.adminFeeLow == null) return dash;
  return r.adminFeeLow === r.adminFeeHigh ? usdExact(r.adminFeeLow) : `${usdExact(r.adminFeeLow)} - ${usdExact(r.adminFeeHigh)}`;
}

export const COMP_COLUMNS = [
  { header: 'Unit Type', get: (x) => x.unitType, width: 24 },
  { header: 'Competitor', get: (x) => x.competitor, width: 28 },
  { header: 'Distance (Mi)', get: (x) => (x.distanceMiles == null ? '' : x.distanceMiles), width: 12 },
  { header: 'Source', get: (x) => sourceLabel(x.source), width: 12 },
  { header: 'Their Size', get: (x) => x.theirSize, width: 12 },
  { header: 'Street Rate', get: (x) => usdExact(x.rate), width: 12 },
  { header: 'Online Rate', get: (x) => usdExact(x.online), width: 12 },
  { header: 'Current Special', get: (x) => x.promo || '', width: 30 },
  { header: 'Admin Fee', get: (x) => usdExact(x.adminFee), width: 10 },
  { header: 'Insurance', get: (x) => x.insurance || '', width: 20 },
  { header: 'Updated', get: (x) => formatDate(x.observedOn), width: 12 },
];

// Every competitor row behind the overview, one line per unit type and competitor.
export const compRows = (rows) => rows.flatMap((r) => (r.comps || []).map((c) => ({ ...c, unitType: r.name })));

// ── Import: manual competitor rates from CSV / XLS ──────────────────────────
export const IMPORT_COLUMNS = ['Competitor', 'Their Size', 'Kind', 'Surface / Access', 'Street Rate', 'Online Rate',
  'Survey Date', 'Special', 'Admin Fee', 'Compares To'];

// Sheet rows (arrays of strings, first row the header) -> [{ header: cell }].
export function sheetToObjects(rows) {
  const clean = (rows || []).filter((r) => r.some((c) => String(c || '').trim()));
  if (!clean.length) return [];
  const head = clean[0].map((h) => String(h || '').trim());
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

export function downloadImportTemplate(facility) {
  downloadCsv(csvName('CMA Manual Rates Template', facility, ''), IMPORT_COLUMNS,
    [['Tri-City Boat & RV Storage', '12 x 32', 'Parking', 'Gravel - Open - Drive-In', '110', '', '10/15/2026', 'Rate locked in for 2 years', '25', '']]);
}

// A fresh id for one Approve click (the server answers a repeat with the first result).
export const requestId = () => (globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
