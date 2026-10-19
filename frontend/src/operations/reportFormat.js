// Operations > Reports: how a report cell reads on screen and in the CSV.
// Column types come from the server (ops_reports.py / ops_report_builder.py):
// text, tenant, unit, money (cents), int, num, pct (already x100), area, date.
import { formatDate } from '../lib/datetime';
import { money } from './model';

export const NUMERIC_TYPES = new Set(['money', 'int', 'num', 'pct', 'area']);

const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function cellText(v, type) {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'money': return money(v, { exact: true });
    case 'pct': return `${Number(v).toFixed(1)}%`;
    case 'int':
    case 'area': return Math.round(Number(v)).toLocaleString('en-US');
    case 'num': return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'date': return formatDate(v);
    default: {
      const s = String(v);
      if (DAY.test(s)) return formatDate(s);
      if (MONTH.test(s)) return `${s.slice(5)}/${s.slice(0, 4)}`;
      return s;
    }
  }
}

// One CSV cell: money as plain dollars, numbers without separators, dates US.
export function csvValue(v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return (Number(v) / 100).toFixed(2);
  if (type === 'pct') return Number(v).toFixed(1);
  if (type === 'int' || type === 'area') return String(Math.round(Number(v)));
  if (type === 'num') return String(Math.round(Number(v) * 10000) / 10000);
  return cellText(v, type === 'date' ? 'date' : 'text');
}

export function toCsvRows(columns, rows) {
  return rows.map((r) => columns.map((c) => csvValue(r[c.key], c.type)));
}

// Sort a copy of the rows by one column; blanks last whichever way.
export function sortRows(rows, key, desc, type) {
  const num = NUMERIC_TYPES.has(type);
  const present = (r) => r[key] !== null && r[key] !== undefined && r[key] !== '';
  const has = rows.filter(present);
  const blank = rows.filter((r) => !present(r));
  has.sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const d = num ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'en-US', { numeric: true });
    return desc ? -d : d;
  });
  return [...has, ...blank];
}

export function matches(row, columns, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return columns.some((c) => cellText(row[c.key], c.type).toLowerCase().includes(needle));
}
