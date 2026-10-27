import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, FolderOpen, FolderSearch, FolderUp, Mail, MapPin, Pencil, Phone, X } from 'lucide-react';
import { api, withFreshReads } from '../../api';
import Amount, { AmountInput, formatAmount } from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { useAccountingPrefs } from './prefs';
import { BarMore, BarSearch, ControlBar, CustomizeButton, DENSITIES, EntitiesPicker, EntityPicker, ExportMenu, Pager, PopoverPanel, SyncButton, control, fitSelect } from './reportControls';
import { useCustomizePrefs, useFitHeight, usePaged } from './tableHooks';
import { TableViewBar, ViewHead, useTableView, viewCells, viewTable } from './tableView';
import { useTableSync } from './tableSync';
import { cellStyle, headStyle } from './columnStyles';
import EntryDetail from './EntryDetail';
import { downloadBlob, iso } from './reportModel';
import { ColumnFilterRow, ColumnFiltersEmpty, columnFiltersActive, filterRowsByColumns, useColumnFilters } from './columnFilters';
import { linesFile } from './linesExport';
import SendReportDialog from './SendReportDialog';
import { ScanOutcome, ScanProgress, entitiesScannedText, mergeScans, useLedgerScan, useScanRetry, POLL_MS } from './LedgerScan';
import AddMenu from './AddMenu';
import AnchoredMenu from '../AnchoredMenu';
import { EgnyteField } from './LoanDialogs';
import { CUSTOM_MAX_MONTHS, FREQUENCY, PeriodPicker, PossiblyEndedChip, RecheckStatus, RecurringSettingsButton, frequencyLabel, periodMonths, periodText, stepMonths, useStaleRecheck } from './recurringShared';
import { CompletenessButton, CompletenessPanel, gapCount, mreGaps, useJumpToRow } from './completeness';

export { CUSTOM_MAX_MONTHS, frequencyLabel, stepMonths };

// Accounting -> Reporting -> MRE, Monthly Recurring Expenses (Oct 6: Neil
// listed MRE as pending; Charmi wants it under Reporting next to MRI). The
// expense-side mirror of MRI's Leasing:
//
//   a LINE      one vendor that one entity pays from the same expense
//               account(s) on a schedule (monthly / quarterly / annual), the
//               amount expected each time, a category, and notes. Debt service
//               is not here - Loans & Financing covers it.
//   the GRID    a row per line, a column per month: what was PAID - read from
//               the ledger, what posted to the line's expense accounts for that
//               vendor that month, never keyed - colored against what was
//               expected (Paid / Short / Over / Missed / Upcoming), the year's
//               total, the Balance (expected - paid, to date) and the Notes.
//
// "+ Add" offers Manual. (Oct 14, Charmi: "Set up ledger option needs to be
// taken out from MRE" - the From the Ledger scan is off the menu; its dialog
// and the API stay.) The toolbar matches Reports: Entities, the year, a
// vendor search, category, Customize, Export.
//
// Oct 14 (Charmi, Urmi, Priyanka, Neil): the vendor is a searchable dropdown
// of the Intacct vendors (number on the LEFT of the name, free text still
// allowed); Mortgage, Dues & Subscriptions, Property Tax, Advertising, Auto
// Registration and State Tax categories; Semi-Annual and Custom (every N
// months) frequencies; and per line a Variance % (0-50 in steps of 5: a month
// paid within it of expected is Paid), the Account Number with the vendor,
// Account Details and Contact Information - the last three also as columns
// under Customize.
//
// Oct 7 (items 9, 12, 21, 32, 33): the standard Customize adds Rows per Page
// (a Pager under the grid; the Total Paid row and the exports always cover
// every line), the grid's columns resize by dragging a header edge, the
// entity on a line is the module's entity picker (search by number), and a
// paid month or a line's Total opens the ledger lines behind it - what
// posted to the line's expense accounts for its vendor - each entry number
// opening the entry.
//
// Oct 22 (Priyanka, Urmi, Neil):
//   - The period control is MRI's: the year, then Full Year / Year-to-Date /
//     a quarter / This Month / Custom Months. The grid shows those months;
//     Total and Balance cover them.
//   - Saving a line (add, edit, end, delete) updates its own row from the
//     save and ONE ledger read for that line (/grid?ids=) - never the whole
//     grid again, which read the ledger once per line.
//   - Vendor, Entity, Category, Expected, Total and Balance sort on a click
//     of the header (again for the other way), remembered per viewer.
//   - Each line can link to its vendor's contract folder in Egnyte: Find
//     Folder proposes the best-named folders under the root in Settings and
//     from Egnyte's search, the person picks, changes or clears it.
//   - Possibly Ended: a line with nothing posted for months (the daily
//     check, recurring_stale.py) carries a chip.
//
// Oct 23 (Charmi, Teams): a filter box under every heading, as on AMA and the
// Reports - text columns hold the words typed, amount columns compare with
// =, >, <, >=, <=, Between (OpFilter). They stack with the vendor search, the
// category and Customize, and the exports follow what is left. View only.
//
// Call of 10/27 with Charmi (items 04, 05, 07, 08):
//   - Vendor and Entity show the name, its code underneath in small muted
//     text ("like how annual it is written underneath"), the Ended /
//     Inactive / Possibly Ended chips beside the code - both columns
//     narrower by default. Filters, sort and exports are unchanged.
//   - Every month column drags narrower or wider like the others (the
//     width saved per person with the view); they start narrow enough for
//     nine months at 1440 with the side menu open.
//   - The legend is a filter, as on MRI: Paid / Short / Over / Missed /
//     Upcoming, several at once - the lines with a month in a picked state
//     within the months shown; the figures and Total Paid follow; Clear.
//   - Expected Amount sits on the left of its box in Add and Edit (she
//     first said right, then corrected herself: left).

const CATEGORIES = [
  { key: 'utilities', label: 'Utilities' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'payroll_services', label: 'Payroll Services' },
  { key: 'software', label: 'Software' },
  { key: 'rent_paid', label: 'Rent Paid' },
  { key: 'mortgage', label: 'Mortgage' },
  { key: 'dues_subscriptions', label: 'Dues & Subscriptions' },
  { key: 'property_tax', label: 'Property Tax' },
  { key: 'advertising', label: 'Advertising' },
  { key: 'auto_registration', label: 'Auto Registration' },
  { key: 'state_tax', label: 'State Tax' },
  { key: 'other', label: 'Other' },
];
const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
export const VARIANCES = Array.from({ length: 11 }, (_v, i) => i * 5);   // 0%, 5%, ... 50%

/** Whether a line falls due in a month (1-12): inside its start / end, on its
 *  frequency counted from the start month. The API's due_in_month, kept in step. */
export function dueInMonth(line, year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const start = (line?.startDate || '').slice(0, 7);
  const end = (line?.endDate || '').slice(0, 7);
  if (start && key < start) return false;
  if (end && key > end) return false;
  if (line?.status === 'ended' && !end) return false;
  const step = stepMonths(line);
  if (step === 1 || !start) return true;
  const idx = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
  return (idx(key) - idx(start)) % step === 0;
}

// 10/27 (Charmi): an Annual / Semi-Annual / Quarterly line is settled by one
// charge anywhere in its calendar year / half / quarter (the API's
// period_cells); Missed only once the period is over with nothing posted.
const PERIOD_HINT = {
  annual: 'One charge in any month of the year (Jan - Dec) settles it. Missed only after December with nothing posted.',
  semi_annual: 'One charge in each half (Jan - Jun, Jul - Dec) settles it. Missed only after a half ends with nothing posted.',
  quarterly: 'One charge in each quarter settles it. Missed only after a quarter ends with nothing posted.',
};

/** A month's tooltip: what it reads, and for a periodic line what its period expects and got. */
export function monthTitle(cell, statusLabel) {
  const base = `${monthLabel(cell.month)} - ${statusLabel}.`;
  const p = cell.period;
  if (!p) return `${base} Expected ${formatAmount(cell.expected)}, paid ${formatAmount(cell.paid)}.`;
  const span = p.from === p.to ? monthLabel(p.from) : `${monthLabel(p.from)} - ${monthLabel(p.to)}`;
  return `${base} One charge any month ${span} settles it: expected ${formatAmount(p.expected)}, paid ${formatAmount(p.paid)} in the period${cell.paid ? ` (${formatAmount(cell.paid)} this month)` : ''}.`;
}

/** Vendor number on the LEFT of the name (Oct 14, item 7): "V-SDGE - San Diego Gas & Electric". */
export function vendorLabel(code, name) {
  if (!code) return name || '';
  return name && name !== code ? `${code} - ${name}` : code;
}

/** The vendors a search leaves: by number, name or "number - name". */
export function matchVendors(vendors, query) {
  const s = (query || '').trim().toLowerCase();
  if (!s) return vendors || [];
  return (vendors || []).filter((v) => (v.code || '').toLowerCase().includes(s) || (v.name || '').toLowerCase().includes(s)
    || vendorLabel(v.code, v.name).toLowerCase().includes(s));
}

/** A scan's progress that never goes backward (Oct 14, Urmi: "the number
 *  keeps reducing back"). Each API worker runs its own copy of a scan, so
 *  consecutive polls can land on copies at different points; the dialog
 *  keeps the furthest it has seen for the same run (same total). */
export function steadyProgress(prev, next) {
  if (!next || !next.scanning) return next;
  if (!prev || !prev.scanning || (prev.total || 0) !== (next.total || 0)) return next;
  return { ...next, done: Math.max(prev.done || 0, next.done || 0) };
}

// Optional columns under Customize (Oct 14, item 5): [key, label, pref].
const OPTIONAL_COLUMNS = [
  ['accountNumber', 'Account Number', 'mreShowAccountNumber'],
  ['accountDetails', 'Account Details', 'mreShowAccountDetails'],
  ['contactInfo', 'Contact Information', 'mreShowContactInfo'],
  ['variancePct', 'Variance', 'mreShowVariance'],
];
const optionalValue = (line, key) => (key === 'variancePct' ? `${Number(line.variancePct) || 0}%` : (line[key] || ''));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS = {
  paid: { label: 'Paid', fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' },
  short: { label: 'Short', fg: '#92400e', bg: 'rgba(180,83,9,0.13)' },
  over: { label: 'Over', fg: '#6d28d9', bg: 'rgba(109,40,217,0.10)' },
  missed: { label: 'Missed', fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
  upcoming: { label: 'Upcoming', fg: 'var(--text-muted)', bg: 'transparent' },
  unknown: { label: 'Not Read', fg: 'var(--text-muted)', bg: 'var(--bg-secondary)' },
};
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const monthLabel = (m) => (m ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '');
const notAvailable = (e) => e?.status === 503 || /not configured|not available/i.test(e?.message || '');

/** The rows the toolbar leaves on screen. `states`: the legend's picks (rowInStates). */
export function visibleRows(rows, { q = '', category = '', showEnded = false, showInactive = false, showZero = false, states = [], span = [0, 11] } = {}) {
  const s = q.trim().toLowerCase();
  return (rows || []).filter((r) => {
    const l = r.line;
    if (!showEnded && l.status === 'ended') return false;
    if (!showInactive && r.vendorInactive) return false;
    if (category && l.category !== category) return false;
    if (!showZero && !r.paidTotal && !r.expectedYear) return false;
    if (!rowInStates(r, states, span)) return false;
    return !s || [l.vendorName, l.vendorId, l.entityName, l.entityCode, l.notes].some((v) => (v || '').toLowerCase().includes(s));
  });
}

// The legend as a filter (10/27 call, item 07 - Charmi: "if you can just make
// this clickable, then whichever is missed, then we click on missed and all
// the missed transactions will show up"), MRI's StateFilter for MRE.
export const LEGEND = ['paid', 'short', 'over', 'missed', 'upcoming'];
/** Whether a line has a month in one of the picked states within the months shown (nothing picked: every line). */
export function rowInStates(row, picked = [], [from, to] = [0, 11]) {
  if (!picked.length) return true;
  const want = new Set(picked);
  return (row.months || []).slice(from, to + 1).some((c) => c && want.has(c.status));
}

// Default widths (10/27 call, items 04 and 05): Vendor and Entity narrower now
// their codes sit underneath, and month columns narrow enough for nine months
// at 1440 with the side menu open. A width the person drags wins.
export const MRE_WIDTHS = { vendor: 200, entity: 170, category: 116, expected: 84 };
export const MONTH_WIDTH = 74;
export const defaultWidth = (key) => MRE_WIDTHS[key] || (/^m\d+$/.test(key) ? MONTH_WIDTH : undefined);

/** One row's paid and balance over the months shown. The full year is the
 *  server's own figures (paidTotal, balance - expected less paid, to date);
 *  a part of the year is added up from its months the same way. */
export function spanFigures(row, [from, to]) {
  if (from === 0 && to === 11) return { paid: row.paidTotal || 0, balance: row.balance || 0 };
  const cells = (row.months || []).slice(from, to + 1);
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    paid: r2(cells.reduce((s, c) => s + (Number(c.paid) || 0), 0)),
    balance: r2(cells.reduce((s, c) => s + (['paid', 'short', 'over', 'missed'].includes(c.status) ? (Number(c.expected) || 0) - (Number(c.paid) || 0) : 0), 0)),
  };
}

// The filter box under each heading (Oct 23), in the grid's column order:
// Vendor, Entity, Category, the optional columns shown, Expected, the months
// shown, Total, Balance, Notes. A month filters on the figure in its cell.
export function mreFilterColumns(extra = [], span = [0, 11]) {
  const [from, to] = span;
  const shownFigure = (c) => (c?.status === 'upcoming' && !c.paid ? Number(c.expected) || 0 : Number(c?.paid) || 0);
  return [
    { key: 'vendor', label: 'Vendor', text: (r) => `${vendorLabel(r.line.vendorId, r.line.vendorName)} ${r.line.vendorName || ''}` },
    { key: 'entity', label: 'Entity', text: (r) => `${r.line.entityCode || ''} ${r.line.entityName || ''}` },
    { key: 'category', label: 'Category', text: (r) => CATEGORY[r.line.category] || 'Other' },
    ...OPTIONAL_COLUMNS.filter(([k]) => extra.includes(k)).map(([k, l]) => (k === 'variancePct'
      ? { key: k, label: l, num: true, value: (r) => Number(r.line.variancePct) || 0 }
      : { key: k, label: l, text: (r) => optionalValue(r.line, k) })),
    { key: 'expected', label: 'Expected', num: true, value: (r) => Number(r.line.expectedAmount) || 0 },
    ...MONTHS.map((m, i) => ({ key: `m${i}`, label: m, num: true, value: (r) => shownFigure(r.months?.[i]) })).slice(from, to + 1),
    { key: 'total', label: 'Total', num: true, value: (r) => spanFigures(r, span).paid },
    { key: 'balance', label: 'Balance', num: true, value: (r) => spanFigures(r, span).balance },
    { key: 'notes', label: 'Notes', text: (r) => r.line.notes || '' },
  ];
}

/** Ended / Inactive / Possibly Ended - the chips beside the vendor, for the export (10/27: the export follows a re-check). */
export const lineStanding = (r) => [r.line.status === 'ended' ? 'Ended' : '', r.vendorInactive ? 'Inactive' : '', r.line.possiblyEnded ? 'Possibly Ended' : ''].filter(Boolean).join(', ');

// The grid's columns for the standard table view (10/23 meeting, item 01):
// the filter columns above, typed for the rules (amounts) and the value lists,
// the vendor pinned first and sorting by name (Urmi, 10/22), each with what
// it exports as - the export is the view's rows and columns.
function mreViewColumns(extra = [], span = [0, 11]) {
  const money = (c) => ({ ...c, type: 'amount', text: (r) => formatAmount(c.value(r)) });
  return mreFilterColumns(extra, span).map((c) => {
    if (c.key === 'vendor') {
      return { ...c, fixed: true, text: (r) => vendorLabel(r.line.vendorId, r.line.vendorName), sortBy: (r) => (r.line.vendorName || r.line.vendorId || '').toLowerCase(),
        exportAs: [{ label: 'Vendor No.', width: 80, get: (r) => r.line.vendorId }, { label: 'Vendor', width: 200, get: (r) => r.line.vendorName }, { label: 'Status', width: 100, get: lineStanding }] };
    }
    if (c.key === 'entity') return { ...c, text: (r) => `${r.line.entityCode || ''} ${r.line.entityName || ''}`.trim(), exportAs: [{ label: 'Entity', width: 170, get: (r) => `${r.line.entityName} (${r.line.entityCode})` }] };
    if (c.key === 'category') return { ...c, exportAs: [{ label: 'Category', width: 100, get: (r) => CATEGORY[r.line.category] || 'Other' }, { label: 'Frequency', width: 80, get: (r) => frequencyLabel(r.line) }] };
    if (c.key === 'expected') return { ...money(c), exportAs: [{ label: 'Expected', num: true, width: 80, get: (r) => r.line.expectedAmount }] };
    if (c.key === 'total') return { ...money(c), total: true, exportAs: [{ label: 'Total', num: true, width: 84, total: true, get: (r) => spanFigures(r, span).paid }] };
    if (c.key === 'balance') return { ...money(c), total: true, exportAs: [{ label: 'Balance', num: true, width: 84, total: true, get: (r) => spanFigures(r, span).balance }] };
    if (c.key === 'notes') return { ...c, exportAs: [{ label: 'Notes', width: 160, get: (r) => r.line.notes || '' }] };
    if (/^m\d+$/.test(c.key)) {
      const i = Number(c.key.slice(1));
      return { ...money(c), exportAs: [{ label: c.label, num: true, width: 70, total: true, get: (r) => r.months?.[i]?.paid || 0 }] };
    }
    // The optional columns under Customize.
    return c.num ? { ...money(c), exportAs: [{ label: c.label, width: 120, get: (r) => optionalValue(r.line, c.key) }] } : { ...c, exportAs: [{ label: c.label, width: 120, get: (r) => optionalValue(r.line, c.key) }] };
  });
}

/** The summary over some rows: what the full year's server summary says, added up from them. */
function mreSummary(rows, [from, to]) {
  const r2 = (n) => Math.round(n * 100) / 100;
  if (from === 0 && to === 11) {
    return {
      expectedToDate: r2(rows.reduce((s, r) => s + (r.expectedToDate || 0), 0)),
      paidToDate: r2(rows.reduce((s, r) => s + (r.paidToDate || 0), 0)),
      balance: r2(rows.reduce((s, r) => s + (r.balance || 0), 0)),
      missed: rows.filter((r) => r.monthsMissed).length,
    };
  }
  const cells = (r) => r.months.slice(from, to + 1).filter((c) => ['paid', 'short', 'over', 'missed'].includes(c.status));
  return {
    expectedToDate: r2(rows.reduce((s, r) => s + cells(r).reduce((t, c) => t + (Number(c.expected) || 0), 0), 0)),
    paidToDate: r2(rows.reduce((s, r) => s + cells(r).reduce((t, c) => t + (Number(c.paid) || 0), 0), 0)),
    balance: r2(rows.reduce((s, r) => s + spanFigures(r, [from, to]).balance, 0)),
    missed: rows.filter((r) => cells(r).some((c) => c.status === 'missed')).length,
  };
}

/** Whether any of these column filters is typed (the shared columnFilters.jsx). */
export const mreFiltering = (columns, typed) => columnFiltersActive(columns, typed);

/** The rows every typed column filter lets through: a text column holds the
 *  words typed (each must appear, any case), an amount column compares. They
 *  stack. A filter on a column not shown (a month outside the period, an
 *  optional column turned off) is ignored. */
export function mreColumnFilter(rows, typed = {}, columns = mreFilterColumns()) {
  return filterRowsByColumns(rows, typed, columns);
}

// Sortable headers (Oct 22, Urmi), remembered per viewer (prefs.mreSort).
const SORTS = {
  vendor: (r) => (r.line.vendorName || r.line.vendorId || '').toLowerCase(),
  entity: (r) => `${r.line.entityName || ''} ${r.line.entityCode || ''}`.toLowerCase(),
  category: (r) => (CATEGORY[r.line.category] || 'Other').toLowerCase(),
  expected: (r) => Number(r.line.expectedAmount) || 0,
};
/** The rows in the picked order; ties (and no pick) keep the server's order. */
export function sortRows(rows, sort, span = [0, 11]) {
  if (!sort?.key) return rows;
  const get = sort.key === 'total' ? (r) => spanFigures(r, span).paid : sort.key === 'balance' ? (r) => spanFigures(r, span).balance : SORTS[sort.key];
  if (!get) return rows;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return rows.map((r, i) => [r, i, get(r)]).sort((a, b) => {
    const x = a[2], y = b[2];
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en-US', { numeric: true });
    return c ? c * dir : a[1] - b[1];
  }).map(([r]) => r);
}

/** The grid with one row put in place (or taken out: row null), its totals and summary added up again. */
export function withRow(data, id, row) {
  const rows = data.rows || [];
  const at = rows.findIndex((r) => r.line.id === id);
  const next = row ? (at >= 0 ? rows.map((r, i) => (i === at ? row : r)) : [...rows, row]) : rows.filter((r) => r.line.id !== id);
  const r2 = (n) => Math.round(n * 100) / 100;
  const totals = Array.from({ length: 12 }, (_v, i) => ({
    month: next[0]?.months?.[i]?.month || data.totals?.[i]?.month || '',
    expected: r2(next.reduce((s, r) => s + (Number(r.months[i]?.expected) || 0), 0)),
    paid: r2(next.reduce((s, r) => s + (Number(r.months[i]?.paid) || 0), 0)),
  }));
  const summary = {
    ...(data.summary || {}),
    lines: next.filter((r) => r.line.status === 'active').length,
    expectedToDate: r2(next.reduce((s, r) => s + (r.expectedToDate || 0), 0)),
    paidToDate: r2(next.reduce((s, r) => s + (r.paidToDate || 0), 0)),
    balance: r2(next.reduce((s, r) => s + (r.balance || 0), 0)),
    missed: next.filter((r) => r.monthsMissed).length,
  };
  return { ...data, rows: next, totals, summary };
}

/** The grid as a table for linesExport (PDF / Excel / CSV / Email / Save to Files).
 *  `extra`: the optional columns shown under Customize (keys of OPTIONAL_COLUMNS). */
export function mreTable(rows, year, entityLabel, extra = [], span = [0, 11], periodLabel = '') {
  const opt = OPTIONAL_COLUMNS.filter(([k]) => extra.includes(k));
  const [from, to] = span;
  const shown = MONTHS.slice(from, to + 1);
  const columns = [
    { label: 'Vendor No.', width: 80 }, { label: 'Vendor', width: 200 }, { label: 'Entity', width: 170 }, { label: 'Category', width: 100 }, { label: 'Frequency', width: 80 },
    ...opt.map(([, l]) => ({ label: l, width: 120 })),
    { label: 'Expected', num: true, width: 80 },
    ...shown.map((m) => ({ label: m, num: true, width: 70 })),
    { label: 'Total', num: true, width: 84 }, { label: 'Balance', num: true, width: 84 }, { label: 'Notes', width: 160 },
  ];
  const body = rows.map((r) => [
    r.line.vendorId, r.line.vendorName, `${r.line.entityName} (${r.line.entityCode})`, CATEGORY[r.line.category] || 'Other', frequencyLabel(r.line),
    ...opt.map(([k]) => optionalValue(r.line, k)),
    r.line.expectedAmount, ...r.months.slice(from, to + 1).map((c) => c.paid), spanFigures(r, span).paid, spanFigures(r, span).balance, r.line.notes || '',
  ]);
  const totals = ['Total Paid', '', '', '', '', ...opt.map(() => ''), null, ...shown.map((_m, k) => rows.reduce((s, r) => s + (r.months[from + k]?.paid || 0), 0)),
    rows.reduce((s, r) => s + spanFigures(r, span).paid, 0), rows.reduce((s, r) => s + spanFigures(r, span).balance, 0), ''];
  return {
    title: 'Monthly Recurring Expenses', period: periodLabel || String(year),
    subtitle: `${entityLabel} · ${periodLabel || year} · paid as posted to each line's expense accounts for its vendor`,
    columns, rows: body, totals,
  };
}

export default function MreTab({ canEdit = false, canDelete = false }) {
  const [prefs, setPrefs] = useAccountingPrefs();
  const customize = useCustomizePrefs(['density', 'pageSize', 'historicalEntities']);
  const density = customize.density;
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [period, setPeriod] = useState('year');
  const [custom, setCustom2] = useState([0, 11]);
  const [picked, setPicked] = useState([]);
  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [showZero, setShowZero] = useState(false);
  const [states, setStates] = useState([]);           // the legend's picks ([] = every line)
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);       // a line (new or existing)
  const [sending, setSending] = useState(null);       // 'email' | 'egnyte'
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState('');
  const [lines, setLines] = useState(null);           // { line, from, to, title } - the ledger lines behind a figure
  const seq = useRef(0);
  const showEnded = !!prefs.mreShowEnded;
  const showInactive = !!prefs.mreShowInactive;
  const extra = OPTIONAL_COLUMNS.filter(([, , pref]) => prefs[pref]).map(([k]) => k);

  useEffect(() => {
    api.getAccountingLocations().then((d) => { setEntities(d?.entities || []); setLimited(!!d?.limited); }).catch(() => setEntities([]));
  }, []);
  const pickedKey = picked.join(',');
  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    return api.getMreGrid(year, pickedKey ? pickedKey.split(',') : [])
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) { setData((x) => x || { rows: [], totals: [], summary: {} }); setError(e?.message || 'Could not load the recurring expenses.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [year, pickedKey]);
  useEffect(() => { load(); }, [load]);
  // 10/23 meeting, item 13: Sync reads the grid again past the server's cache;
  // the rows, the filters, the sort and an open popup stay while it does.
  const ts = useTableSync(load);
  // 10/27 (Urmi): a new Possibly Ended setting re-checks every line on the
  // server; when it is done the grid is read again, so the flags, the count
  // and the export follow without a reload or a Sync.
  const recheck = useStaleRecheck(useCallback(() => withFreshReads(load), [load]));

  const span = periodMonths(period, year, custom);
  const [spanFrom, spanTo] = span;
  const statesKey = states.join(',');
  const visible = useMemo(() => visibleRows(data?.rows, { q, category, showEnded, showInactive, showZero, states, span: [spanFrom, spanTo] }),
    [data, q, category, showEnded, showInactive, showZero, statesKey, spanFrom, spanTo]); // eslint-disable-line react-hooks/exhaustive-deps
  const extraKey = extra.join(',');
  const filterColumns = useMemo(() => mreFilterColumns(extra, span), [extraKey, spanFrom, spanTo]); // eslint-disable-line react-hooks/exhaustive-deps
  // The filter boxes under the headings (columnFilters.jsx, shared with AMA).
  const { typed, setFilter: setTyped, clear: clearTyped, filtering, rows: boxed } = useColumnFilters(visible, filterColumns);
  // 10/23 meeting, item 01: the standard table view over what the boxes, the
  // search, the category and Customize leave. The header-click sort Urmi
  // asked for (10/22, prefs.mreSort) is the person's built-in default sort.
  const viewColumns = useMemo(() => mreViewColumns(extra, span), [extraKey, spanFrom, spanTo]); // eslint-disable-line react-hooks/exhaustive-deps
  const legacySort = prefs.mreSort?.key ? { col: prefs.mreSort.key, dir: prefs.mreSort.dir === 'desc' ? 'desc' : 'asc' } : null;
  const view = useTableView('mre', viewColumns, boxed, { sort: legacySort });
  const rows = view.rows;
  const fullYear = spanFrom === 0 && spanTo === 11;
  // The figures over the months shown; the full year is the server's summary
  // as it always was - until the view or the legend filters, then they follow
  // it (item 01; 10/27 call, item 07: "totals follow").
  const sum = view.count || states.length ? mreSummary(rows, [spanFrom, spanTo]) : fullYear ? data?.summary || {} : mreSummary(data?.rows || [], [spanFrom, spanTo]);
  const periodLabel = periodText(period, year, span);
  // Oct 22 (Urmi: "adding a manual expense is very slow"): a save updates its
  // own row - the line from the save at once, then its months from one ledger
  // read for just that line - instead of reading the ledger for every line.
  const savedLine = (res) => {
    setEditing(null);
    if (res?.deleted) { setData((d) => d && withRow(d, res.deleted, null)); return; }
    const line = res && res.id ? res : null;
    if (!line) { load(); return; }
    setData((d) => {
      if (!d) return d;
      const old = (d.rows || []).find((r) => r.line.id === line.id);
      return old ? withRow(d, line.id, { ...old, line }) : d;
    });
    const mine = seq.current;
    (api.getMreGridRows ? api.getMreGridRows(year, [line.id]) : Promise.reject(new Error('no single-row read')))
      .then((g) => {
        if (mine !== seq.current) return;
        const row = (g?.rows || []).find((r) => r.line.id === line.id);
        if (!row) { load(); return; }
        setData((d) => d && withRow(d, line.id, { ...row, vendorInactive: (d.rows || []).find((r) => r.line.id === line.id)?.vendorInactive ?? row.vendorInactive }));
      })
      .catch(() => load());
  };
  const entityLabel = !picked.length ? (limited ? 'All my entities' : 'All entities')
    : picked.length === 1 ? `${entities.find((e) => e.code === picked[0])?.name || picked[0]} (${picked[0]})` : `${picked.length} entities`;
  // Exactly what the view leaves: its rows, order and columns (item 01).
  const table = () => {
    const base = mreTable([], year, entityLabel, extra, span, fullYear ? '' : periodLabel);
    return viewTable(rows, view.columns, { title: base.title, period: base.period, subtitle: base.subtitle, totalLabel: 'Total Paid' });
  };
  const exportAs = async (format) => {
    if (busy) return;
    setBusy(format);
    try {
      const file = await linesFile(table(), format);
      downloadBlob(file.name, file);
    } catch (e) {
      setError(e?.message || 'Could not export.');
    } finally {
      setBusy('');
    }
  };
  const hidden = (data?.rows || []).length - rows.length;
  const possiblyEnded = rows.filter((r) => r.line.possiblyEnded).length;
  // 10/27 (Neil, item 07): the completeness check - gaps for the entities and
  // the period picked (not the search or the column filters); a click on one
  // shows its line, clearing the quick filters that hide it.
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeNote, setCompleteNote] = useState('');
  const [focus, setFocus] = useState(null);
  const gaps = useMemo(() => mreGaps(data?.rows, [spanFrom, spanTo]), [data, spanFrom, spanTo]);
  const pickGap = (g) => {
    setCompleteNote('');
    const r = (data?.rows || []).find((x) => x.line.id === g.id);
    if (r && !rows.some((x) => x.line.id === g.id)) {
      setQ('');
      setCategory('');
      setStates([]);
      clearTyped();
      if (!r.paidTotal && !r.expectedYear) setShowZero(true);
      if (r.vendorInactive && !showInactive) setPrefs({ mreShowInactive: true });
    }
    setFocus((f) => ({ id: g.id, n: (f?.n || 0) + 1 }));
  };

  return (
    <AsyncSection loading={data === null} skeleton={<SkeletonBlocks count={4} />}>
      <div style={{ display: 'grid', gap: 10 }}>
        {/* Item 02, round 3 (UI test 10/24: two lines at 1366 / 1440 once View
            and Filters joined): the search is an icon until used, Category
            as wide as its choice; into More first Customize, Columns and
            Settings, then Category, then Entities and Sync, then Export. */}
        <ControlBar style={{ ...card, padding: '8px 10px' }}>
          <BarMore level={4} active={picked.length ? 1 : 0}>
          <EntitiesPicker entities={entities} value={picked} onChange={setPicked} limited={limited} showHistorical={customize.showHistorical} />
          </BarMore>
          <PeriodPicker year={year} onYear={setYear} period={period} onPeriod={setPeriod} custom={custom} onCustom={setCustom2} />
          <BarSearch value={q} onChange={setQ} label="Search a vendor" placeholder="Search a vendor" width={220} />
          <BarMore level={2} active={category ? 1 : 0}>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={{ ...control, ...fitSelect(CATEGORIES.find((c) => c.key === category)?.label || 'All Categories', { max: 220 }) }}>
            <option value="">All Categories</option>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          </BarMore>
          <TableViewBar view={view} />
          <div className="acct-bar-end">
            {/* Gaps are not a change: More's count is what the person changed (UI test 10/27: "More (1 changed)" from gaps alone). */}
            <BarMore level={3}>
            <CompletenessButton count={gapCount(gaps)} open={completeOpen} onClick={() => setCompleteOpen((o) => !o)} />
            </BarMore>
            <BarMore level={4}>
            <SyncButton onSync={ts.sync} busy={loading && !!data} syncedAt={ts.syncedAt} />
            </BarMore>
            <BarMore level={1} active={showEnded || showInactive || extra.length ? 1 : 0}>
            <CustomizeButton {...customize} showZero={showZero} onShowZero={setShowZero} active={showEnded || showInactive || !!extra.length}>
              <Toggle checked={showEnded} onChange={(v) => setPrefs({ mreShowEnded: v })} title="Show Ended"
                hint="Recurring expenses that have stopped. They keep their history; nothing is deleted." />
              <Toggle checked={showInactive} onChange={(v) => setPrefs({ mreShowInactive: v })} title="Show Inactive Vendors"
                hint="Lines whose vendor Intacct marks inactive." />
              {OPTIONAL_COLUMNS.map(([k, l, pref]) => (
                <Toggle key={k} checked={!!prefs[pref]} onChange={(v) => setPrefs({ [pref]: v })} title={`Show ${l}`}
                  hint={k === 'variancePct' ? 'How far a paid month may be from expected and still count as Paid.' : `The ${l.toLowerCase()} kept on each line, as a column.`} />
              ))}
            </CustomizeButton>
            </BarMore>
            <BarMore level={5}>
            <ExportMenu disabled={!rows.length} items={[
              { key: 'excel', label: 'Excel', hint: 'Every line, months as columns, live totals', onPick: () => exportAs('excel'), busy: busy === 'excel' },
              { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => exportAs('csv'), busy: busy === 'csv' },
              { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
              { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, the grid attached', Icon: Mail, onPick: () => setSending('email') },
              { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setSending('egnyte') },
            ]} />
            </BarMore>
            {canDelete && <BarMore level={1}><RecurringSettingsButton onChecked={load} recheck={recheck} /></BarMore>}
            {canEdit && (
              <AddMenu ariaLabel="Add a recurring expense" items={[
                { key: 'manual', label: 'Manual', hint: 'One vendor, accounts and amount by hand', Icon: Pencil, onPick: () => setEditing(blankLine(picked[0], entities)) },
              ]} />
            )}
          </div>
        </ControlBar>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums', padding: '0 4px' }}>
          <span style={{ color: 'var(--text-muted)' }}>{periodLabel}</span>
          <span>Expected to Date <strong><Amount value={sum.expectedToDate} /></strong></span>
          <span>Paid to Date <strong><Amount value={sum.paidToDate} /></strong></span>
          <span>Balance <strong style={{ color: sum.balance > 0.5 ? 'var(--bad-fg, #dc2626)' : undefined }}><Amount value={sum.balance} /></strong></span>
          <span>{sum.missed || 0} {sum.missed === 1 ? 'line' : 'lines'} with a missed month</span>
          {possiblyEnded > 0 && <span data-testid="possibly-ended-count">{possiblyEnded} Possibly Ended</span>}
          <RecheckStatus recheck={recheck} />
          <Legend value={states} onChange={setStates} />
        </div>

        {error && <div style={bad}>{error}</div>}
        {data?.warning && (
          <div style={{ ...card, padding: '8px 12px', borderColor: '#b45309', display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.82rem', color: '#92400e' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />{data.warning}
          </div>
        )}
        {sent && (
          <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.82rem', color: 'var(--ok-fg, #15803d)' }}>
            <span style={{ flex: 1 }}>{sent.text}{sent.url && <> <a href={sent.url} target="_blank" rel="noreferrer">Open the File</a></>}</span>
            <button type="button" onClick={() => setSent(null)} aria-label="Dismiss" style={icon}><X size={14} /></button>
          </div>
        )}

        {loading && !data?.rows?.length ? <SkeletonBlocks count={4} /> : !rows.length && !filtering && !view.count ? (
          <div style={{ ...card, padding: '18px 16px', fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{(data?.rows || []).length ? 'Nothing matches these filters.' : 'No recurring expenses yet.'}</strong>
            <span>
              {(data?.rows || []).length
                ? `${hidden} ${hidden === 1 ? 'line is' : 'lines are'} hidden by the search, the category, the legend${states.length ? ` (${states.map((k) => STATUS[k].label).join(', ')})` : ''} or Customize (ended lines, inactive vendors, lines with nothing this year).`
                : canEdit ? 'Use + Add > Manual to add one: the vendor, the expense accounts it posts to and the amount expected.' : 'Someone with edit access to Accounting adds them.'}
            </span>
          </div>
        ) : (
          <Grid view={view} filterColumns={filterColumns} typed={typed} onTyped={setTyped} onClearTyped={filtering ? clearTyped : null}
            rows={rows} totals={data?.totals || []} year={year} density={density} loading={loading} canEdit={canEdit} span={span}
            pageSize={customize.pageSize} pageKey={[year, picked, q, category, showEnded, showInactive, showZero, statesKey, period, spanFrom, spanTo, JSON.stringify(view.state), JSON.stringify(typed)]} onLines={setLines}
            focus={focus} onMissing={() => setCompleteNote("That line is hidden by the table view's filters. Clear them in the bar to see it.")}
            onEdit={(l) => setEditing(l)} onNotes={(id, notes) => api.setMreNotes(id, notes).then((line) => setData((d) => ({ ...d, rows: d.rows.map((r) => (r.line.id === id ? { ...r, line } : r)) })))} />
        )}
      </div>

      {editing && (
        <LineEditor line={editing} entities={entities} canDelete={canDelete} onClose={() => setEditing(null)}
          onSaved={savedLine} />
      )}
      {lines && <LedgerLines {...lines} onClose={() => setLines(null)} />}
      {completeOpen && (
        <CompletenessPanel caption={`MRE · ${entityLabel} · ${periodLabel}`} groups={gaps} note={completeNote} onPick={pickGap} onClose={() => setCompleteOpen(false)}
          rule="A gap is a month that is over and reads Missed while the line has no note, or a line with no expected amount, or no frequency (a Custom frequency without its number of months runs every month until it is set). Ended lines are left out." />
      )}
      {sending && (
        <SendReportDialog mode={sending} title={`Monthly Recurring Expenses ${year}`} baseName={`Monthly Recurring Expenses - ${year}`} what="lines"
          makeFile={async (format, name) => linesFile(table(), format, name)}
          onClose={() => setSending(null)} onDone={(text, url) => { setSending(null); setSent({ text, url }); }} />
      )}
    </AsyncSection>
  );
}

function Toggle({ checked, onChange, title, hint }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>{title}<span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{hint}</span></span>
    </label>
  );
}

// The legend, each chip a toggle (10/27 call, item 07; MRI's StateFilter):
// several at once, Clear beside them once one is on.
function Legend({ value = [], onChange }) {
  const on = new Set(value);
  const toggle = (k) => { const n = new Set(on); if (n.has(k)) n.delete(k); else n.add(k); onChange(LEGEND.filter((x) => n.has(x))); };
  return (
    <span role="group" aria-label="Legend - show lines with a month that is" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {LEGEND.map((k) => {
        const picked = on.has(k);
        return (
          <button key={k} type="button" aria-pressed={picked} onClick={() => toggle(k)}
            title={picked ? `Showing lines with a ${STATUS[k].label} month - click to show every line again` : `Show only the lines with a ${STATUS[k].label} month in the months shown`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, font: 'inherit', fontSize: '0.7rem', fontWeight: 700, color: STATUS[k].fg, background: STATUS[k].bg, cursor: 'pointer', borderRadius: 999, padding: '0 8px', lineHeight: '18px',
              border: picked ? '1px solid var(--wk-brand, #2b45e1)' : k === 'upcoming' ? '1px dashed var(--border-color)' : '1px solid transparent', boxShadow: picked ? '0 0 0 1px var(--wk-brand, #2b45e1)' : 'none' }}>
            {picked && <Check size={11} aria-hidden="true" />}{STATUS[k].label}
          </button>
        );
      })}
      {value.length > 0 && (
        <button type="button" onClick={() => onChange([])} aria-label="Clear the legend filter"
          style={{ border: 'none', background: 'none', padding: '0 2px', font: 'inherit', fontSize: '0.72rem', color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer' }}>Clear</button>
      )}
    </span>
  );
}

// The grid (Oct 7, item 32: resizable columns, saved per viewer). 10/23
// meeting, item 01: its headings are the standard view's - a click opens the
// menu (sort, filter, width, move, hide), the funnel a value list - and the
// columns, the filter boxes under them and the Total Paid line follow the
// view's order; the Vendor column stays pinned first.
function Grid({ view, filterColumns = [], typed = {}, onTyped = null, onClearTyped = null, rows, totals, year, density, loading, canEdit, onEdit, onNotes, pageSize = 0, pageKey = '', onLines = null, span = [0, 11], focus = null, onMissing = null }) {
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);
  const [from, to] = span;
  const idx = MONTHS.map((_m, i) => i).slice(from, to + 1);
  const range = { from: `${year}-${String(from + 1).padStart(2, '0')}-01`, to: monthRange(`${year}-${String(to + 1).padStart(2, '0')}`).to };
  const py = DENSITIES.find((d) => d.key === density)?.py || '5px';
  // A width the person dragged, else the default (10/27 call, items 04 / 05).
  const w = (k) => view.manualWidth(k) || defaultWidth(k);
  const month = (k) => /^m\d+$/.test(k);
  // Rows per Page: this page's lines; the Total Paid row adds up every line.
  const paged = usePaged(rows, pageSize, pageKey);
  useJumpToRow(focus, rows, (r) => r.line.id, paged, pageSize, onMissing);
  const totalPaid = rows.reduce((s, r) => s + spanFigures(r, span).paid, 0);
  const totalBalance = rows.reduce((s, r) => s + spanFigures(r, span).balance, 0);
  const monthPaid = Object.fromEntries(idx.map((i) => [i, rows.reduce((s, r) => s + (r.months[i]?.paid || 0), 0)]));
  const head = (c) => {
    const num = c.type === 'amount';
    if (c.key === 'vendor') return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className="acct-label acct-head" style={headStyle(w(c.key), { position: 'sticky', left: 0 })} />;
    if (c.key === 'total') return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className="acct-num" title="Paid in the months shown" style={headStyle(w(c.key), { fontWeight: 800 })} />;
    if (c.key === 'balance') return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className="acct-num" title="Expected less paid, in the months shown that are over" style={headStyle(w(c.key))} />;
    if (c.key === 'notes') return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} style={headStyle(w(c.key), { minWidth: w(c.key) || 180 })} />;
    return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className={[num ? 'acct-num' : '', month(c.key) ? 'mre-m' : ''].filter(Boolean).join(' ') || undefined} style={headStyle(w(c.key))} />;
  };
  return (
    // 10/23 meeting, item 05: the grid scrolls inside a box that ends in the window.
    <div className="acct-report-wrap acct-scroll-box acct-fit" ref={setBox} data-testid="mre-box" style={{ opacity: loading ? 0.6 : 1, ...fit }}>
      <table className="acct-report mre-grid" style={{ '--acct-row-py': py }} aria-label={`Recurring expenses ${year}`}>
        {/* The headings and the filter boxes stick as one block (mre-grid in
            style.css); the Vendor heading also stays pinned on the left. */}
        <thead>
          <tr>{view.columns.map(head)}</tr>
          {onTyped && (
            <ColumnFilterRow columns={view.columns} filterColumns={filterColumns} typed={typed} onChange={onTyped}
              cellProps={(col) => ({ className: col.key === 'vendor' ? 'acct-head' : month(col.key) ? 'mre-m' : undefined })} />
          )}
        </thead>
        <tbody>
          {!rows.length && <ColumnFiltersEmpty colSpan={view.columns.length} onClear={onClearTyped} />}
          {paged.rows.map((r) => {
            const f = spanFigures(r, span);
            const months = Object.fromEntries(idx.map((i) => {
              const c = r.months[i];
              return [`m${i}`, c ? <MonthCell cell={c} width={w(`m${i}`)} onOpen={onLines && Math.abs(Number(c.paid) || 0) > 0.005 ? () => onLines({ line: r.line, ...monthRange(c.month), title: monthLabel(c.month) }) : null} /> : <td />];
            }));
            const optional = Object.fromEntries(OPTIONAL_COLUMNS.map(([k]) => [k, (
              <td className={k === 'variancePct' ? 'acct-num' : undefined} title={optionalValue(r.line, k)}
                style={w(k) ? cellStyle(w(k)) : { maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{optionalValue(r.line, k)}</td>
            )]));
            return (
              <tr key={r.line.id} data-row-id={r.line.id}>
                {viewCells(view, {
                  // The name on the first line, the code and the chips underneath (10/27 call, item 04).
                  vendor: (
                    <td className="acct-label" style={cellStyle(w('vendor'))}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                        <VendorName id={r.line.vendorId} name={r.line.vendorName} />
                        {r.line.egnyteUrl && <a href={r.line.egnyteUrl} target="_blank" rel="noreferrer" aria-label={`Documents of ${r.line.vendorName} in Egnyte`} title={`Documents: ${r.line.egnyteFolder}`} style={{ display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)', flexShrink: 0 }}><FolderOpen size={13} /></a>}
                        {canEdit && <button type="button" style={{ ...icon, padding: 2, flexShrink: 0 }} onClick={() => onEdit(r.line)} aria-label={`Edit ${r.line.vendorName}`} title="Edit"><Pencil size={12} /></button>}
                      </span>
                      <span className="mre-sub" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {r.line.vendorId && r.line.vendorId !== r.line.vendorName && <span data-testid="vendor-code">{r.line.vendorId}</span>}
                        {r.line.status === 'ended' && <Chip text="Ended" />}
                        {r.vendorInactive && <Chip text="Inactive" />}
                        <PossiblyEndedChip flag={r.line.possiblyEnded} kind="mre" />
                      </span>
                    </td>
                  ),
                  entity: (
                    <td title={`${r.line.entityName} (${r.line.entityCode})`} style={cellStyle(w('entity'))}>
                      <span className="mre-main">{r.line.entityName || r.line.entityCode}</span>
                      {r.line.entityCode && r.line.entityName && <span className="mre-sub" data-testid="entity-code">{r.line.entityCode}</span>}
                    </td>
                  ),
                  category: <td style={cellStyle(w('category'))} title={CATEGORY[r.line.category] || 'Other'}>{CATEGORY[r.line.category] || 'Other'}</td>,
                  ...optional,
                  expected: (
                    <td className="acct-num" style={cellStyle(w('expected'))} title={`${frequencyLabel(r.line)} from ${formatDate(r.line.startDate) || 'the start'}${r.line.endDate ? ` to ${formatDate(r.line.endDate)}` : ''}${r.line.variancePct ? `; paid within ${r.line.variancePct}% counts as Paid` : ''}`}>
                      <Amount value={r.line.expectedAmount} />
                      <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{frequencyLabel(r.line)}</span>
                    </td>
                  ),
                  ...months,
                  total: (
                    <td className="acct-num" style={cellStyle(w('total'), { fontWeight: 700 })}>
                      {onLines && Math.abs(Number(f.paid) || 0) > 0.005
                        ? <button type="button" className="acct-drill" onClick={() => onLines({ line: r.line, ...range, title: from === 0 && to === 11 ? String(year) : `${MONTHS[from]}${to !== from ? ` - ${MONTHS[to]}` : ''} ${year}` })} aria-label={`Ledger lines behind ${r.line.vendorName}'s total for ${year}`} title="The ledger lines behind this total"><Amount value={f.paid} zero="dash" /></button>
                        : <Amount value={f.paid} zero="dash" />}
                    </td>
                  ),
                  balance: <td className="acct-num" style={cellStyle(w('balance'), { color: f.balance > 0.5 ? 'var(--bad-fg, #dc2626)' : undefined })} title="Expected less paid, to date"><Amount value={f.balance} zero="dash" /></td>,
                  notes: <td style={w('notes') ? cellStyle(w('notes'), { whiteSpace: 'normal' }) : { whiteSpace: 'normal', minWidth: 180 }}><NotesCell line={r.line} canEdit={canEdit} onSave={onNotes} /></td>,
                })}
              </tr>
            );
          })}
          <tr className="acct-grand">
            {viewCells(view, {
              vendor: <td className="acct-label">Total Paid</td>,
              ...Object.fromEntries(idx.map((i) => [`m${i}`, <td className="acct-num mre-m" style={cellStyle(w(`m${i}`))} title={`Paid ${formatAmount(monthPaid[i] || 0)}, expected ${formatAmount(totals[i]?.expected || 0)}`}><Amount value={monthPaid[i]} zero="dash" /></td>])),
              total: <td className="acct-num"><Amount value={totalPaid} zero="dash" /></td>,
              balance: <td className="acct-num"><Amount value={totalBalance} zero="dash" /></td>,
            })}
          </tr>
        </tbody>
      </table>
      <Pager {...paged} />
    </div>
  );
}

/** The first and last day of a month key (YYYY-MM). */
function monthRange(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return { from: `${monthKey}-01`, to: `${monthKey}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
}

/** The ledger searches behind a line's figure: each expense account, for the vendor, in the entity. */
export function mreLinesQueries(line, from, to) {
  return (line.expenseAccounts || []).map((account) => ({ account, party_kind: 'vendor', party: line.vendorId, location: line.entityCode, from, to, limit: 100 }));
}

// The ledger lines behind a paid month or a line's Total (Oct 7, item 33):
// what posted to the line's expense accounts for its vendor in the entity,
// each entry number opening the whole entry (EntryDetail). No new endpoint -
// the ledger search the Reports drill-down uses.
function LedgerLines({ line, from, to, title, onClose }) {
  const queries = useMemo(() => mreLinesQueries(line, from, to), [line, from, to]);
  const [state, setState] = useState({ lines: null, error: '' });
  const [entry, setEntry] = useState(null);
  const entryOpen = useRef(false);
  useEffect(() => { entryOpen.current = !!entry; }, [entry]);
  useEffect(() => {
    let alive = true;
    Promise.all(queries.map((p) => api.searchAccountingLedger(p)))
      .then((answers) => { if (alive) setState({ lines: answers.flatMap((d) => d?.rows || []), error: '' }); })
      .catch((e) => { if (alive) setState({ lines: [], error: e?.message || 'Could not read the ledger lines.' }); });
    return () => { alive = false; };
  }, [queries]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !entryOpen.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const total = (state.lines || []).reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content nx-popup" role="dialog" aria-modal="true" aria-label={`${line.vendorName}, ${title}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>{line.vendorName} - {title}</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Posted to {(line.expenseAccounts || []).join(', ')} for vendor {line.vendorId} in {line.entityName || line.entityCode}, {formatDate(from)} - {formatDate(to)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={icon}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 18px', maxHeight: '70vh', overflowY: 'auto' }}>
          {state.lines === null ? <SkeletonBlocks count={2} /> : state.error ? <div style={bad}>{state.error}</div> : !state.lines.length ? (
            <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>Nothing posted in this period.</div>
          ) : (
            <div className="acct-lines-wrap">
              <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
                <thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col">Account</th><th scope="col">Description</th><th scope="col" className="acct-num">Amount</th></tr></thead>
                <tbody>
                  {state.lines.map((l, i) => (
                    <tr key={`${l.entry_id || l.entry_no || 'x'}-${i}`}>
                      <td>{l.entry_date ? formatDate(l.entry_date) : '-'}</td>
                      <td>{l.entry_id ? <button type="button" className="acct-drill" onClick={() => setEntry({ id: l.entry_id, no: l.entry_no })} title="Open this journal entry">{l.entry_no || 'Open'}</button> : (l.entry_no || '-')}</td>
                      <td>{l.account_no || l.account || '-'}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 280 }} title={l.description || ''}>{l.description || l.memo || '-'}</td>
                      <td className="acct-num"><Amount value={(l.debit || 0) - (l.credit || 0)} /></td>
                    </tr>
                  ))}
                  <tr className="acct-grand"><td colSpan={4}>Total - {state.lines.length} {state.lines.length === 1 ? 'line' : 'lines'}</td><td className="acct-num"><Amount value={total} /></td></tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {entry && <div onClick={(e) => e.stopPropagation()} role="presentation"><EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} /></div>}
    </div>
  );
}

function Chip({ text }) {
  return <span style={{ fontSize: '0.66rem', fontWeight: 700, color: 'var(--text-muted)', background: 'var(--bg-secondary)', borderRadius: 999, padding: '0 6px', flexShrink: 0 }}>{text}</span>;
}

function MonthCell({ cell, width, onOpen = null }) {
  const st = STATUS[cell.status];
  if (!st) {
    // Not due this month; what was paid anyway still opens its lines.
    return (
      <td className="acct-num mre-m" style={cellStyle(width, { color: 'var(--text-muted)' })}>
        {onOpen ? <button type="button" className="acct-drill" onClick={onOpen} aria-label={`Ledger lines for ${monthLabel(cell.month)}`}><Amount value={cell.paid} zero="dash" /></button> : <Amount value={cell.paid || 0} zero="dash" />}
      </td>
    );
  }
  const title = monthTitle(cell, st.label);
  const shown = cell.status === 'missed' ? 'Missed' : cell.status === 'upcoming' && !cell.paid ? <Amount value={cell.expected} zero="dash" /> : <Amount value={cell.paid} zero="dash" />;
  return (
    <td className="acct-num mre-m" title={title} aria-label={title} data-status={cell.status}
      style={cellStyle(width, { background: st.bg, color: st.fg, fontWeight: cell.status === 'paid' ? 500 : 600, borderLeft: '1px solid var(--bg-card)', ...(cell.status === 'upcoming' ? { fontStyle: 'italic' } : {}) })}>
      {onOpen && cell.status !== 'missed'
        ? <button type="button" className="acct-drill" onClick={onOpen} aria-label={`Ledger lines for ${monthLabel(cell.month)}`} style={{ color: 'inherit', fontWeight: 'inherit' }}>{shown}</button>
        : shown}
    </td>
  );
}

function NotesCell({ line, canEdit, onSave }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(line.notes || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!canEdit) return <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{line.notes}</span>;
  if (!editing) {
    return (
      <button type="button" onClick={() => { setText(line.notes || ''); setEditing(true); setError(''); }} aria-label={`Notes for ${line.vendorName}`}
        style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: '0.78rem', textAlign: 'left', cursor: 'text', color: line.notes ? 'var(--text-secondary)' : 'var(--text-muted)', width: '100%' }}>
        {line.notes || 'Add a note'}
      </button>
    );
  }
  const save = () => {
    if (busy) return;
    if ((text || '').trim() === (line.notes || '')) { setEditing(false); return; }
    setBusy(true);
    Promise.resolve(onSave(line.id, text.trim()))
      .then(() => setEditing(false))
      .catch((e) => setError(e?.message || 'Could not save the note.'))
      .finally(() => setBusy(false));
  };
  return (
    <div>
      <input type="text" value={text} autoFocus maxLength={1000} disabled={busy} aria-label={`Notes for ${line.vendorName}`}
        onChange={(e) => setText(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') setEditing(false); }}
        style={{ ...control, width: '100%', height: 26 }} />
      {error && <div style={{ fontSize: '0.7rem', color: 'var(--bad-fg, #dc2626)' }}>{error}</div>}
    </div>
  );
}

// The vendor's card on hover or focus: name, phone, email, address - the
// records Accounting > Vendors & Customers reads. Read once per vendor.
const vendorCache = new Map();
function VendorName({ id, name }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(() => vendorCache.get(id) || null);
  const timer = useRef(null);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setOpen(true);
      if (!vendorCache.has(id)) {
        const p = api.getMreVendor(id).then((d) => ({ loaded: true, ...d })).catch((e) => ({ loaded: true, error: e?.message || 'Could not read the vendor.' }));
        vendorCache.set(id, { loading: true });
        setState({ loading: true });
        p.then((d) => { vendorCache.set(id, d); setState(d); });
      } else {
        setState(vendorCache.get(id));
      }
    }, 250);
  };
  // A short grace period, so the pointer can travel onto the card (its email link).
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 150); };
  const keep = () => clearTimeout(timer.current);
  useEffect(() => () => clearTimeout(timer.current), []);
  const v = state?.vendor;
  const addr = v ? [v.address?.line1, v.address?.line2, [v.address?.city, v.address?.state].filter(Boolean).join(', '), v.address?.zip].filter(Boolean).join(' ') : '';
  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} tabIndex={0}
      style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, cursor: 'default', textDecoration: 'underline dotted var(--border-color)', textUnderlineOffset: 3 }}>
      {name || id}
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} role="tooltip" aria-label={`${name} contact`} onMouseEnter={keep} onMouseLeave={hide}
        style={{ width: 280, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 12, display: 'grid', gap: 6, fontSize: '0.8rem', fontWeight: 400, whiteSpace: 'normal' }}>
        <div style={{ fontWeight: 700 }}>{v?.displayName || v?.name || name}</div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Vendor {id}</div>
        {state?.loading && <SkeletonBlocks count={1} />}
        {state?.error && <div style={{ color: 'var(--bad-fg, #dc2626)' }}>{state.error}</div>}
        {state?.loaded && state.available === false && <div style={{ color: 'var(--text-muted)' }}>Contact details are not available yet - the accounting app needs its update.</div>}
        {state?.loaded && state.available !== false && !state.error && !v && <div style={{ color: 'var(--text-muted)' }}>No contact details on file for this vendor.</div>}
        {v && (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Phone size={12} style={{ color: 'var(--text-muted)' }} />{v.phone || <span style={{ color: 'var(--text-muted)' }}>No phone</span>}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', wordBreak: 'break-all' }}><Mail size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />{v.email ? <a href={`mailto:${v.email}`}>{v.email}</a> : <span style={{ color: 'var(--text-muted)' }}>No email</span>}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}><MapPin size={12} style={{ color: 'var(--text-muted)', marginTop: 3, flexShrink: 0 }} />{addr || <span style={{ color: 'var(--text-muted)' }}>No address</span>}</div>
          </>
        )}
      </PopoverPanel>
    </span>
  );
}

function blankLine(entityCode, entities) {
  const e = entities.find((x) => x.code === entityCode);
  return { id: '', entityCode: entityCode || '', entityName: e?.name || '', vendorId: '', vendorName: '', expenseAccounts: [], category: 'utilities', frequency: 'monthly',
    frequencyMonths: 0, variancePct: 0, accountNumber: '', accountDetails: '', contactInfo: '',
    expectedAmount: 0, startDate: `${iso(new Date()).slice(0, 7)}-01`, endDate: '', status: 'active', notes: '' };
}

// The vendor on a line (Oct 14, Priyanka: "Vendor list should have a drop
// down"): a searchable dropdown of the Intacct vendors, each with its number
// on the LEFT of the name. Typing filters the list; a pick fills number and
// name; anything typed that is not on the list is kept as it is (free text).
function VendorCombobox({ id, vendors, text, onText, onPick }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [width, setWidth] = useState(0);
  const boxRef = useRef(null);
  const listRef = useRef(null);
  const shown = useMemo(() => matchVendors(vendors || [], text).slice(0, 200), [vendors, text]);
  const show = () => { setWidth(boxRef.current?.offsetWidth || 0); setOpen(true); };
  const pick = (v) => { onPick(v); setOpen(false); };
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, hi]);
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input id={id} type="text" role="combobox" aria-expanded={open} aria-autocomplete="list" aria-controls={`${id}-list`} autoComplete="off"
        value={text} placeholder={vendors === null ? 'Loading vendors...' : 'Search a vendor by number or name'}
        onFocus={show} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { onText(e.target.value); setHi(0); if (!open) show(); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(); else setHi((h) => Math.min(h + 1, Math.max(shown.length - 1, 0))); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') { if (open && shown[hi]) { e.preventDefault(); pick(shown[hi]); } }
          else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
        }}
        style={{ ...control, width: '100%', paddingRight: 26 }} />
      <ChevronDown size={13} style={{ position: 'absolute', right: 9, top: 9, color: 'var(--text-muted)', pointerEvents: 'none' }} />
      <AnchoredMenu anchorRef={boxRef} open={open} onClose={() => setOpen(false)} role="listbox" id={`${id}-list`} aria-label="Vendors"
        style={{ width: Math.max(width, 300), maxHeight: 320, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 4 }}>
        <div ref={listRef}>
          {vendors === null ? <div style={{ padding: '7px 10px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>Loading vendors...</div>
            : !shown.length ? <div style={{ padding: '7px 10px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>{text.trim() ? 'No vendor matches - what you typed is kept as the vendor.' : 'No vendors on the ledger yet.'}</div>
              : shown.map((v, i) => (
                <button key={v.code} type="button" role="option" aria-selected={i === hi}
                  onMouseDown={(e) => { e.preventDefault(); pick(v); }} onMouseEnter={() => setHi(i)}
                  style={{ display: 'flex', gap: 8, width: '100%', textAlign: 'left', border: 'none', borderRadius: 6, padding: '5px 8px', font: 'inherit', fontSize: '0.8rem', cursor: 'pointer', color: 'var(--text-primary)', background: i === hi ? 'var(--wk-brand-tint, #e8ecfd)' : 'none' }}>
                  <span className="acct-code" style={{ minWidth: 72, flexShrink: 0, marginRight: 0 }}>{v.code}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name || v.code}</span>
                </button>
              ))}
        </div>
      </AnchoredMenu>
    </div>
  );
}

function LineEditor({ line, entities, canDelete, onClose, onSaved }) {
  const [l, setL] = useState(() => ({ ...line, accountsText: (line.expenseAccounts || []).join(', ') }));
  const [vendors, setVendors] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const set = (p) => setL((x) => ({ ...x, ...p }));
  useEffect(() => {
    api.getAccountingDimensionValues('vendor').then((d) => setVendors(d?.values || [])).catch(() => setVendors([]));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const accounts =
 String(l.accountsText || '').split(',').map((x) => x.trim()).filter(Boolean);
  const customOk = l.frequency !== 'custom' || (Number(l.frequencyMonths) >= 1 && Number(l.frequencyMonths) <= CUSTOM_MAX_MONTHS);
  const ready = l.entityCode && l.vendorId.trim() && accounts.length && customOk;
  const body = () => ({
    entityCode: l.entityCode, entityName: entities.find((e) => e.code === l.entityCode)?.name || l.entityName || '', vendorId: l.vendorId.trim(), vendorName: l.vendorName.trim(),
    expenseAccounts: accounts, category: l.category, frequency: l.frequency, expectedAmount: Number(l.expectedAmount) || 0,
    frequencyMonths: l.frequency === 'custom' ? Math.floor(Number(l.frequencyMonths) || 0) : 0, variancePct: Number(l.variancePct) || 0,
    accountNumber: l.accountNumber || '', accountDetails: l.accountDetails || '', contactInfo: l.contactInfo || '',
    startDate: l.startDate || '', endDate: l.endDate || '', status: l.status, notes: l.notes || '',
    egnyteFolder: l.egnyteFolder || '',
  });
  const run = (work) => {
    setBusy(true);
    setError('');
    work.then((res) => onSaved(res)).catch((e) => { setError(e?.message || 'Could not save.'); setBusy(false); });
  };
  const save = () => { if (ready && !busy) run(l.id ? api.updateMreLine(l.id, body()) : api.createMreLine(body())); };
  // Oct 22 (Neil): Find Folder - the vendor's best-named Egnyte folders, to pick from.
  const [finding, setFinding] = useState(null);         // null | { busy } | { suggestions, root } | { error }
  const findFolder = () => {
    const name = (l.vendorName || l.vendorId || '').trim();
    if (!name) return;
    setFinding({ busy: true });
    api.suggestMreEgnyteFolder(name)
      .then((d) => setFinding({ suggestions: d?.suggestions || [], root: d?.root || '' }))
      .catch((e) => setFinding({ error: e?.message || 'Could not search Egnyte.' }));
  };
  // Typed text: a vendor number or "number - name" on the list is that vendor; anything else is kept as typed.
  const typeVendor = (text) => {
    const t = text.trim().toLowerCase();
    const hit = t ? (vendors || []).find((v) => (v.code || '').toLowerCase() === t || vendorLabel(v.code, v.name).toLowerCase() === t) : null;
    set(hit ? { vendorText: text, vendorId: hit.code, vendorName: hit.name || hit.code } : { vendorText: text, vendorId: text.trim(), vendorName: '' });
  };
  const pickVendor = (v) => set({ vendorId: v.code, vendorName: v.name || v.code, vendorText: vendorLabel(v.code, v.name) });
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 };
  const hint = { fontSize: '0.68rem', color: 'var(--text-muted)' };
  const vendorText = l.vendorText ?? vendorLabel(l.vendorId, l.vendorName);
  const thisYear = Number((l.startDate || '').slice(0, 4)) > new Date().getFullYear() ? Number(l.startDate.slice(0, 4)) : new Date().getFullYear();
  const dueMonths = MONTHS.filter((_m, i) => dueInMonth({ ...l, status: 'active' }, thisYear, i + 1));
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content nx-popup" role="dialog" aria-modal="true" aria-label={l.id ? 'Edit recurring expense' : 'Add recurring expense'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{l.id ? 'Edit Recurring Expense' : 'Add Recurring Expense'}</h3>
          <button type="button" onClick={onClose} aria-label="Close" style={icon}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '72vh', overflowY: 'auto' }}>
          {error && <div style={bad}>{error}</div>}
          <div style={grid}>
            <div>
              <span style={label}>Entity</span>
              <EntityPicker entities={entities} value={l.entityCode || ''} onChange={(code) => set({ entityCode: code })} active={false} style={{ width: '100%', maxWidth: 'none' }} />
            </div>
            <div>
              <label style={label} htmlFor="mre-vendor">Vendor</label>
              <VendorCombobox id="mre-vendor" vendors={vendors} text={vendorText} onText={typeVendor} onPick={pickVendor} />
            </div>
          </div>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="mre-accounts">Expense Accounts</label>
              <input id="mre-accounts" type="text" value={l.accountsText} onChange={(e) => set({ accountsText: e.target.value })} placeholder="GL codes, e.g. 62100, 62110" style={{ ...control, width: '100%' }} />
            </div>
            <div>
              <label style={label} htmlFor="mre-category">Category</label>
              <select id="mre-category" value={l.category} onChange={(e) => set({ category: e.target.value })} style={{ ...control, width: '100%' }}>
                {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="mre-amount">Expected Amount</label>
              {/* Left in its box (10/27 call, item 08 - Charmi corrected herself: "move it to the left side"). */}
              <AmountInput id="mre-amount" value={l.expectedAmount} onChange={(v) => set({ expectedAmount: v ?? 0 })} style={{ ...control, width: '100%', textAlign: 'left' }} />
            </div>
            <div>
              <label style={label} htmlFor="mre-variance">Variance</label>
              <select id="mre-variance" value={Number(l.variancePct) || 0} onChange={(e) => set({ variancePct: Number(e.target.value) })} style={{ ...control, width: '100%' }}>
                {VARIANCES.map((v) => <option key={v} value={v}>{v}%</option>)}
              </select>
              <span style={hint}>A month paid within this much of expected counts as Paid.</span>
            </div>
          </div>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="mre-frequency">Frequency</label>
              <select id="mre-frequency" value={l.frequency} onChange={(e) => set({ frequency: e.target.value, ...(e.target.value === 'custom' && !(Number(l.frequencyMonths) >= 1) ? { frequencyMonths: 2 } : {}) })} style={{ ...control, width: '100%' }}>
                {Object.entries(FREQUENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              {PERIOD_HINT[l.frequency]
                ? <span style={hint}>{PERIOD_HINT[l.frequency]}</span>
                : l.startDate && dueMonths.length > 0 && dueMonths.length < 12 && <span style={hint}>Due in {thisYear}: {dueMonths.join(', ')}.</span>}
            </div>
            {l.frequency === 'custom' && (
              <div>
                <label style={label} htmlFor="mre-every">Every (Months)</label>
                <input id="mre-every" type="number" min={1} max={CUSTOM_MAX_MONTHS} step={1} value={l.frequencyMonths || ''} onChange={(e) => set({ frequencyMonths: e.target.value === '' ? '' : Math.floor(Number(e.target.value)) })}
                  style={{ ...control, width: '100%' }} />
                <span style={{ ...hint, color: customOk ? hint.color : 'var(--bad-fg, #dc2626)' }}>{customOk ? `Falls due every ${stepMonths(l)} ${stepMonths(l) === 1 ? 'month' : 'months'} from the start month.` : `Enter 1 to ${CUSTOM_MAX_MONTHS} months.`}</span>
              </div>
            )}
          </div>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="mre-start">Start</label>
              <input id="mre-start" type="date" value={l.startDate} onChange={(e) => set({ startDate: e.target.value })} style={{ ...control, width: '100%' }} />
              <span style={hint}>A bill that is not monthly falls due from this month.</span>
            </div>
            <div>
              <label style={label} htmlFor="mre-end">End</label>
              <input id="mre-end" type="date" value={l.endDate} onChange={(e) => set({ endDate: e.target.value })} style={{ ...control, width: '100%' }} />
              <span style={hint}>Leave empty while it continues.</span>
            </div>
          </div>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="mre-account-number">Account Number</label>
              <input id="mre-account-number" type="text" value={l.accountNumber || ''} maxLength={100} onChange={(e) => set({ accountNumber: e.target.value })} placeholder="Your account number with the vendor" style={{ ...control, width: '100%' }} />
            </div>
            <div>
              <label style={label} htmlFor="mre-status">Status</label>
              <select id="mre-status" value={l.status} onChange={(e) => set({ status: e.target.value })} style={{ ...control, width: '100%' }}>
                <option value="active">Active</option>
                <option value="ended">Ended</option>
              </select>
            </div>
          </div>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="mre-account-details">Account Details</label>
              <textarea id="mre-account-details" value={l.accountDetails || ''} onChange={(e) => set({ accountDetails: e.target.value })} rows={2} maxLength={1000} placeholder="Service address, meter, plan, how it is paid" style={{ ...control, width: '100%', height: 'auto', padding: 8 }} />
            </div>
            <div>
              <label style={label} htmlFor="mre-contact">Contact Information</label>
              <textarea id="mre-contact" value={l.contactInfo || ''} onChange={(e) => set({ contactInfo: e.target.value })} rows={2} maxLength={1000} placeholder="Name, phone, email" style={{ ...control, width: '100%', height: 'auto', padding: 8 }} />
            </div>
          </div>
          <div>
            <EgnyteField id="mre-egnyte" labelText="Contract and Documents Folder (Egnyte)" value={l.egnyteFolder || ''} url={l.egnyteFolder && l.egnyteFolder === line.egnyteFolder ? line.egnyteUrl : null}
              onChange={(v) => set({ egnyteFolder: v })} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <button type="button" className="secondary-btn" onClick={findFolder} disabled={!(l.vendorName || l.vendorId) || finding?.busy}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', height: 28, padding: '0 10px' }}><FolderSearch size={13} /> {finding?.busy ? 'Finding...' : 'Find Folder'}</button>
              <span style={hint}>Looks for the vendor&apos;s folder by name{finding?.root ? ` under ${finding.root}` : ''} and in Egnyte&apos;s search. Pick one, or Browse, paste or Clear.</span>
            </div>
            {finding?.error && <div style={{ ...hint, color: 'var(--bad-fg, #dc2626)', marginTop: 4 }}>{finding.error}</div>}
            {finding?.suggestions && (finding.suggestions.length ? (
              <div role="list" aria-label="Suggested folders" style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                {finding.suggestions.map((f) => (
                  <button key={f.path} type="button" role="listitem" onClick={() => { set({ egnyteFolder: f.path }); setFinding(null); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', border: '1px solid var(--border-color)', borderRadius: 8, padding: '5px 10px', background: 'var(--bg-card)', font: 'inherit', fontSize: '0.78rem', cursor: 'pointer', color: 'var(--text-primary)' }}>
                    <FolderOpen size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path}</span>
                    <span style={{ ...hint, flexShrink: 0 }}>{f.score >= 1 ? 'Same Name' : f.score >= 0.85 ? 'Close Match' : 'Partial Match'}</span>
                  </button>
                ))}
              </div>
            ) : <div style={{ ...hint, marginTop: 4 }}>No folder named like this vendor was found. Browse for it, or set the vendor folders root in Settings.</div>)}
          </div>
          <div>
            <label style={label} htmlFor="mre-notes">Notes</label>
            <textarea id="mre-notes" value={l.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} maxLength={1000} style={{ ...control, width: '100%', height: 'auto', padding: 8 }} />
          </div>
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 24px 16px' }}>
          {l.id && canDelete && (confirm ? (
            <>
              <span style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)' }}>Delete for good? A bill that stopped should be ended instead.</span>
              <button type="button" className="secondary-btn" disabled={busy} onClick={() => run(api.deleteMreLine(l.id).then(() => ({ deleted: l.id })))}>Delete</button>
            </>
          ) : <button type="button" className="secondary-btn" onClick={() => setConfirm(true)}>Delete</button>)}
          {l.id && l.status !== 'ended' && <button type="button" className="secondary-btn" disabled={busy} onClick={() => run(api.endMreLine(l.id, iso(new Date())))}>End Today</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-btn" disabled={!ready || busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// + Add -> From the Ledger: the scan runs on the server as a background job
// (polled every three seconds with "Reading the ledger... 40 of 253
// entities"), active leaf entities only - the picked ones, or every one the
// person may read.
//
// Oct 14: no longer on the + Add menu (Charmi: "Set up ledger option needs to
// be taken out from MRE"; Urmi: slow, and the count "keeps reducing back").
// Kept for the API and tests; its progress now never goes backward
// (steadyProgress) should it be reached again.
export function MreFromLedger({ entities = [], entityLabel = 'All entities', onClose, onCreated, pollMs = POLL_MS }) {
  const [min, setMin] = useState(3);
  // The furthest progress seen per request; cleared by any final answer or error.
  const seen = useRef({});
  const steady = (key, work) => work
    .then((d) => { seen.current[key] = steadyProgress(seen.current[key], d); return seen.current[key]; })
    .catch((e) => { delete seen.current[key]; throw e; });
  const scan = useLedgerScan(() => steady(`${min}|${entities.join(',')}`, api.getMreProposals(min, entities)), [min, entities.join(',')], pollMs);
  const { progress, retry } = scan;
  // Oct 7 (Charmi: stuck at "133 of 142 entities" for 5+ minutes): the scan
  // has a time limit; what it could not read is listed with Retry for just those.
  const again = useScanRetry((codes) => steady(`retry|${min}|${codes.join(',')}`, api.getMreProposals(min, codes)), pollMs);
  const data = useMemo(() => mergeScans(scan.data, again.retries, (p) => `${p.entityCode}|${p.vendorId}`), [scan.data, again.retries]);
  const failed = data?.failed || [];
  const [error, setError] = useState(null);
  const [unticked, setUnticked] = useState(() => new Set());
  const [categories, setCategories] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const shown = error || scan.error;
  const rows = data?.proposals || [];
  const fresh = rows.filter((p) => p.status === 'new');
  const keyOf = (p) => `${p.entityCode}|${p.vendorId}`;
  const count = fresh.filter((p) => !unticked.has(keyOf(p))).length;
  const toggle = (k) => setUnticked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const create = () => {
    const items = fresh.filter((p) => !unticked.has(keyOf(p))).map((p) => ({ entityCode: p.entityCode, vendorId: p.vendorId, category: categories[keyOf(p)] || p.category }));
    if (!items.length) return;
    setBusy(true);
    setError(null);
    api.createMreFromLedger({ items, min, entities: entities.join(',') || null })
      .then((r) => { setDone(r); setBusy(false); })
      .catch((e) => { setError(e); setBusy(false); });
  };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content nx-popup" role="dialog" aria-modal="true" aria-label="Add recurring expenses from the ledger" onClick={(e) => e.stopPropagation()} style={{ width: 'max(60vw, min(100%, 1080px))' }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>Add From the Ledger</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              Vendors who posted to an expense account at a stable amount in at least {min} of the last twelve months{data?.from ? ` (${monthLabel(data.from)} to ${monthLabel(data.to)})` : ''}, {entityLabel.toLowerCase().startsWith('all') ? 'every active entity you may read' : entityLabel}. The expected amount is the most common of the last three postings; debt service is left to Loans &amp; Financing.
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={icon}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 12, maxHeight: '72vh', overflowY: 'auto' }}>
          {!done && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              At least
              <select value={min} onChange={(e) => { setMin(Number(e.target.value)); setUnticked(new Set()); again.reset(); }} aria-label="Minimum months at a stable amount" style={control}>
                {[2, 3, 4, 6, 9, 12].map((n) => <option key={n} value={n}>{n} months</option>)}
              </select>
              at a stable amount (within 10%)
            </label>
          )}
          {shown && (notAvailable(shown)
            ? <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>Not available here.</strong> The accounting service is not connected on this environment, so there is no ledger to read. Use Manual.</div>
            : (
              <div style={{ ...bad, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ flex: 1 }}>{shown.message || 'Could not read the ledger.'}</span>
                {scan.error && <button type="button" className="secondary-btn" onClick={retry} style={{ fontSize: '0.76rem' }}>Try Again</button>}
              </div>
            ))}
          {data && !done && (
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              {entitiesScannedText(data)}.
            </div>
          )}
          {data && !done && <ScanOutcome total={data.entitiesScanned ?? 0} failed={failed} onRetry={again.run} running={again.running} error={again.error} />}
          {progress ? <ScanProgress progress={progress} /> : scan.error ? null : data === null ? <SkeletonBlocks count={2} /> : done ? (
            <div style={{ fontSize: '0.86rem', display: 'grid', gap: 6 }}>
              <strong>{done.created.length} recurring {done.created.length === 1 ? 'expense' : 'expenses'} added{done.skipped.length ? `, ${done.skipped.length} skipped` : ''}.</strong>
              {done.created.map((p) => <div key={keyOf(p)}>{vendorLabel(p.vendorId, p.vendorName)} at {p.entityName} - <Amount value={p.expectedAmount} /> {FREQUENCY[p.frequency]?.toLowerCase()}</div>)}
              {done.skipped.map((p) => <div key={keyOf(p)} style={{ color: 'var(--text-muted)' }}>{p.vendorId} at {p.entityCode}: {p.why}</div>)}
            </div>
          ) : !rows.length ? (
            shown && notAvailable(shown) ? null : (
              <div style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
                <strong style={{ color: 'var(--text-primary)' }}>{failed.length ? 'No recurring vendor payments found in the entities that were read.' : 'No recurring vendor payments found.'}</strong>
                <span>Read {data.entitiesRead ?? 0} active {data.entitiesRead === 1 ? 'entity' : 'entities'}{failed.length ? ` (${failed.length} more could not be read - Retry them above before deciding)` : ''}; {data.entitiesWithExpenses ?? 0} had expense postings, but no vendor posted the same amount in at least {min} months. Lower the bar above, or add one with Manual.</span>
              </div>
            )
          ) : (
            <div className="req-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="req-table" style={{ fontVariantNumeric: 'tabular-nums' }}>
                <thead><tr><th style={{ width: 30 }} /><th>Vendor</th><th>Entity</th><th>Expense Accounts</th><th>Category</th><th>Frequency</th><th style={num}>Expected</th><th style={num}>Months Posted</th><th style={num}>Paid (12 Mo)</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((p) => {
                    const k = keyOf(p);
                    const isNew = p.status === 'new';
                    return (
                      <tr key={k} style={isNew ? undefined : { color: 'var(--text-muted)' }}>
                        <td>{isNew ? <input type="checkbox" checked={!unticked.has(k)} onChange={() => toggle(k)} aria-label={`Add ${p.vendorName} at ${p.entityName}`} /> : null}</td>
                        <td><span className="acct-code">{p.vendorId}</span>{p.vendorName}</td>
                        <td>{p.entityName}</td>
                        <td title={(p.accountTitles || []).join(', ')}>{(p.expenseAccounts || []).join(', ')}</td>
                        <td>
                          {isNew ? (
                            <select value={categories[k] || p.category} onChange={(e) => setCategories((c) => ({ ...c, [k]: e.target.value }))} aria-label={`Category for ${p.vendorName}`} style={{ ...control, height: 26 }}>
                              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                            </select>
                          ) : CATEGORY[p.category]}
                        </td>
                        <td>{FREQUENCY[p.frequency]}</td>
                        <td style={num}><Amount value={p.expectedAmount} /></td>
                        <td style={num} title={`${p.stableMonths} at the expected amount; first ${monthLabel(p.firstMonth)}, last ${monthLabel(p.lastMonth)}`}>{p.postedMonths} ({p.stableMonths} Stable)</td>
                        <td style={num}><Amount value={p.paid12} /></td>
                        <td>{isNew
                          ? <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '1px 8px', borderRadius: 999, color: '#92400e', background: 'rgba(180,83,9,0.13)' }}>New</span>
                          : <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '1px 8px', borderRadius: 999, color: 'var(--ok-fg, #15803d)', background: 'rgba(21,128,61,0.10)' }}>Set Up</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 24px 16px' }}>
          <button type="button" className="secondary-btn" onClick={done ? onCreated : onClose}>{done ? 'Done' : 'Cancel'}</button>
          {!done && rows.length > 0 && <button type="button" className="primary-btn" disabled={busy || !count} onClick={create}>{busy ? 'Adding...' : `Add ${count} ${count === 1 ? 'Expense' : 'Expenses'}`}</button>}
        </div>
      </div>
    </div>
  );
}
