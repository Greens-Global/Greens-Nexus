// Operations: stores run by another operator (CubeSmart, Oct 20 2026). The
// server sends them in the same shape as a Cubby facility plus a `thirdParty`
// block (GET /third-party/ops-facilities), so the screen's arithmetic adds
// them in unchanged. These helpers are the few places they read differently.
import { formatDate } from '../lib/datetime';

export const isThirdParty = (f) => !!f?.thirdParty;

// "CubeSmart Managed" - the tag on the facility picker pill.
export const managedLabel = (f) => f?.thirdParty?.label || '';

// "Data as of 10/19/2026", so a store whose reports were not uploaded lately is obvious.
export function dataAsOf(f) {
  const iso = f?.thirdParty?.dataAsOf;
  return iso ? `Data as of ${formatDate(iso)}` : 'No data uploaded yet';
}

export const isStale = (f) => !!f?.thirdParty?.stale;

export const REPORT_KINDS = [
  { key: 'auto', label: 'Detect From File' },
  { key: 'sre', label: 'SRE Summary (Monthly)' },
  { key: 'flash', label: 'Daily Flash' },
  { key: 'rent_roll', label: 'Rent Roll' },
];
export const kindLabel = (k) => (REPORT_KINDS.find((r) => r.key === k) || { label: k }).label;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A preview row's period: "2026-10" -> "Oct 2026"; "2026-10-19" -> the person's date format.
export function periodLabel(p) {
  const s = String(p || '');
  if (/^\d{4}-\d{2}$/.test(s)) return `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
  return formatDate(s) || s;
}

// The figures a preview row shows, per report: [field, column header].
export const PREVIEW_COLUMNS = {
  sre: [['total_cubes_avail', 'Cubes Available'], ['rented_during_month', 'Rented'], ['vacated_during_month', 'Vacated'],
    ['net_rentals', 'Net Rentals'], ['cubes_occ_eom', 'Occupied EOM'], ['pct_rented_cube', '% Rented (Cube)'],
    ['rental_revenue', 'Rental Revenue'], ['promo_discounts', 'Promotions'], ['ar_total', 'Total AR']],
  flash: [['move_ins_mtd', 'Move-Ins MTD'], ['move_outs_mtd', 'Move-Outs MTD'], ['occupied_cubes', 'Occupied'],
    ['vacant_cubes', 'Vacant'], ['total_cubes', 'Total Cubes'], ['accrued_rent_mtd', 'Accrued Rent MTD'],
    ['revenue_mtd', 'Revenue MTD'], ['net_revenue_mtd', 'Net Revenue MTD']],
  rent_roll: [['rentedUnits', 'Rented Units']],
};
const MONEY = new Set(['rental_revenue', 'promo_discounts', 'ar_total', 'accrued_rent_mtd', 'revenue_mtd', 'net_revenue_mtd']);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// A preview cell. Dollars as the report states them (not cents); "-" when the file had none.
export function previewCell(field, v) {
  if (v === null || v === undefined || v === '') return '-';
  if (MONEY.has(field)) return usd.format(v);
  if (field.startsWith('pct_')) return `${Number(v).toFixed(1)}%`;
  return Number(v).toLocaleString('en-US');
}
