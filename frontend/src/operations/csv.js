// Operations exports: rows -> a .csv a spreadsheet opens cleanly.

const NUMERIC = /^-?\d[\d,]*(\.\d+)?%?$/;

// One cell. Quoted when it has a comma, quote or line break. Text that a
// spreadsheet would run as a formula (a tenant or task name starting with
// = + - @) is prefixed with an apostrophe; a plain negative number is left alone.
function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  return [columns, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

// "Rent Roll - Temecula - 10-13-2026.csv"
export function csvName(title, scope, isoDate) {
  const [y, m, d] = String(isoDate || '').split('-');
  const day = y && m && d ? `${m}-${d}-${y}` : '';
  return `${[title, scope, day].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]/g, '')}.csv`;
}

export function downloadCsv(filename, columns, rows) {
  // The BOM makes Excel read UTF-8 (names with accents) instead of guessing.
  const blob = new Blob(['﻿', toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
