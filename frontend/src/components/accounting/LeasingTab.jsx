import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Building2, Check, ChevronDown, ExternalLink, FolderUp, Home, Landmark, Mail, Pencil, Plus, RefreshCw, Tags, Trash2, UserPlus, Users, X } from 'lucide-react';
import { api, withFreshReads } from '../../api';
import Amount, { formatAmount } from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { BarMore, BarSearch, ControlBar, CustomizeButton, DENSITIES, EntitiesPicker, EntityPicker, ExportMenu, Pager, PopoverPanel, SyncButton, control, usePopover } from './reportControls';
import { spaceBelow, useCustomizePrefs, usePaged } from './tableHooks';
import { TableViewBar, ViewHead, useTableView, viewCells, viewTable } from './tableView';
import { cellStyle, headStyle } from './columnStyles';
import { requestReportDrill } from './drill';
import { downloadBlob, iso } from './reportModel';
import { useAccountingPrefs } from './prefs';
import { linesFile } from './linesExport';
import SendReportDialog from './SendReportDialog';
import AddMenu from './AddMenu';
import EntryDetail from './EntryDetail';
import { DateField } from '../../tasks/components';
import { dialog } from '../../ui/dialog';
import SidePanel, { PanelSection } from './SidePanel';
import { CUSTOM_MAX_MONTHS, FREQUENCY, PeriodPicker, PossiblyEndedChip, RecheckStatus, RecurringSettingsButton, frequencyLabel, periodMonths, periodText, stepMonths, useStaleRecheck } from './recurringShared';
import { CompletenessButton, CompletenessPanel, gapCount, mriGaps, useJumpToRow } from './completeness';
import { ColumnFilterRow, useColumnFilters } from './columnFilters';
import { filterCellOf, filterColumnsOf } from './viewFilterColumns';

// Accounting -> Leasing: leases and monthly recurring income (Neil and
// Charmi, Sep 25). Rent was tracked in a workbook and chased by hand; this is
// the same thing as an app.
//
//   Rent Roll    every lease, every month of the year: what was expected,
//                what came in, and what that makes of the month.
//   Outstanding  who is behind, by how much, and how to reach them.
//   Tenants      the leases themselves: the tenant (an Intacct customer), the
//                dates, the late-fee rule, and the rent as it changes.
//
// What was received is read from the ledger - whatever posted to the lease's
// rental income account for that customer in that month - so nobody keys a
// payment here. A tenant who moves out is ended, not overwritten: "New Tenant
// in This Space" ends the old lease and starts the next one.
//
// Oct 6 (Charmi, MRI feedback of 10/04):
//   - Filters on the row like Reports: Entities (the shared picker, (H) off
//     unless Customize shows them), the period (a year, then Full Year /
//     Year-to-Date / a quarter / This Month / Custom months), Tenants (pick
//     the customers to see) and a text filter. No search box in the header -
//     the global search lives top right.
//   - A Total column (received in the period) and Balance instead of Owed:
//     expected less received, so a prepayment shows as a credit.
//   - A Notes column the team writes in, saved with who and when.
//   - The tenant's name opens the customer's card on hover or click (name,
//     telephone, address, email - Intacct's record).
//   - Leases link to their Intacct customer automatically (by name, on load;
//     new tenants by the ledger sync). Sync Now runs it on demand.
//   - Expired leases and customers inactive in Intacct are hidden unless
//     Customize > Show Expired / Show Inactive - and always found by the text
//     filter, marked with a chip.
//   - Banded rows with hover, a skeleton while the year loads, and the
//     Reports Export menu (Excel, CSV, PDF, Email, Save to Files).
//
// Oct 7 (Charmi, MRI items 53-55): "Don't need two different tabs here, just
// need filters. We are tracking any source of income that is coming in."
//   - ONE list of every recurring income source, with a Type column and a
//     Type filter (Lease / Interest / Loan Payment / Other). A source kept
//     here (a lease, or an interest or loan payment typed in by hand) has a
//     schedule and a payer; the interest and loan income accounts on the
//     ledger come in as rows of their own (what posted, no schedule), less
//     what the sources kept here already account for.
//   - Income Roll / Outstanding / Payers (was Tenants) stay as the views.
//   - "+ Add" with a menu (New Lease, New Interest or Loan Payment, Set Up
//     From the Ledger), last on the toolbar, like Loans and MRE.
//   - Customize > Row Density works again: the tables set it themselves
//     (the .acct-lines class reset the value the wrapper passed down).
//   - The month popup lists the journal entries behind what was received,
//     each entry number opening the entry; Open Entry when there is one.
//   - Money posted in a month the lease is not in force is shown, not
//     counted, and the row says so (a lease typed in on Oct 2 for a tenant
//     paying since January showed a 20,548.39 "prepayment" credit).
//   - The module's shared controls (items 9, 12, 21, 32, 33): the standard
//     Customize adds Rows per Page (a Pager under each list; totals and
//     exports always cover every row), the Income Roll's columns resize by
//     dragging a header edge, the entity on a lease is the module's entity
//     picker (search by number), and the Total of a ledger income account
//     opens its lines in Reports.
//
// Oct 14 (Charmi, Urmi, Neil, Priyanka - MRI feedback):
//   - No "Posted Outside Lease" chip or "Outside the Lease" figure: money
//     posted before a lease starts or after it ends shows in its month and
//     counts toward Received (never toward Expected or the Balance).
//   - + Add is New Lease, New CAM Charge (CAM is a type now) and New
//     Interest or Loan Payment; Set Up From the Ledger left the menu (its
//     endpoints and LeasingFromLedger stay).
//   - The tenant on a lease is picked from the Intacct customers (a
//     searchable dropdown), or typed when they are not in Intacct.
//   - A month (or a lease) with unsaved changes asks Keep Editing / Discard
//     Edits when clicked off or on Escape, instead of closing.
//   - Only active leases show; Customize > Show Inactive Leases brings back
//     the ended, expired and vacant ones and payers inactive in Intacct.
//   - The Notes column also lists the notes written on single months.
//   - A month the lease is not in force shows a dash, never 0.
//   - Total and Balance open the lease's ledger lines in Reports.
//   - Customer codes sit left of the name.
//
// Oct 22 (Priyanka, Charmi, Urmi, Neil):
//   - Frequency on a source - Monthly (every source saved before), Quarterly,
//     Semi-Annual, Annual or Custom every N months, like MRE. A month it does
//     not fall due shows a dash.
//   - A payment that covers more than one month settles the OLDEST open month
//     first (the server's apply_credits): that month reads Covered, with the
//     month that paid it on hover. Balances never change - expected less
//     received is the same sum.
//   - The color legend is a filter at the top: pick Paid / Short / Unpaid or
//     Late / Due / Upcoming / Covered to see the rows with a month in that
//     state within the months shown.
//   - Dates are picked with the Nexus date picker (MM/DD/YYYY whatever the
//     browser's language); the rent change table's headers sit over their
//     inputs.
//   - Possibly Ended: a source with nothing received for months (the daily
//     check, recurring_stale.py) carries a chip; Settings (full access) sets
//     how many months and runs the check now.

const SECTIONS = [{ key: 'roll', label: 'Income Roll' }, { key: 'outstanding', label: 'Outstanding' }, { key: 'tenants', label: 'Payers' }];
export const TYPES = [{ key: 'lease', label: 'Lease' }, { key: 'cam', label: 'CAM' }, { key: 'interest', label: 'Interest' }, { key: 'loan_payment', label: 'Loan Payment' }, { key: 'other', label: 'Other' }];
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.key, t.label]));
/** The income accounts read from the ledger as rows of their own: interest and loan income, never the lease rent. */
export const isRecurringIncomeAccount = (r) => ['revenue', 'other_income'].includes(r.section) && /interest|loan|note receivable|mortgage income/i.test(r.title || '');
/** What an income account row is: a loan payment (loan / note / mortgage) or interest. */
export const accountType = (title) => (/\bloan|note receivable|mortgage/i.test(title || '') ? 'loan_payment' : 'interest');
/** A row's type: the source's own, or the account row's. */
export const typeOf = (r) => (r.kind === 'account' ? r.type : (r.lease?.incomeType || 'lease'));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS = {
  paid: { label: 'Paid', fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' },
  short: { label: 'Short', fg: '#92400e', bg: 'rgba(180,83,9,0.13)' },
  unpaid: { label: 'Unpaid', fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
  late: { label: 'Late', fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
  due: { label: 'Due', fg: 'var(--text-secondary)', bg: 'var(--bg-secondary)' },
  upcoming: { label: 'Upcoming', fg: 'var(--text-muted)', bg: 'transparent' },
  unknown: { label: 'Not Read', fg: 'var(--text-muted)', bg: 'var(--bg-secondary)' },
  none: { label: 'Nothing Due', fg: 'var(--text-muted)', bg: 'transparent' },
  // Oct 14: posted while the lease is not in force - a plain received month, no separate concept.
  outside: { label: 'Received', fg: 'var(--text-primary)', bg: 'transparent' },
  // Oct 22: settled by an overpayment in another month (the oldest open month first).
  covered: { label: 'Covered', fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.06)' },
  income: { label: 'Received', fg: 'var(--text-primary)', bg: 'transparent' },
};
const LEASE_STATUS = { active: 'Active', ended: 'Ended', vacant: 'Vacant' };
// The legend as a filter (Oct 22, Neil: "should be a filter option at the top").
export const STATE_FILTERS = [
  { key: 'paid', label: 'Paid', statuses: ['paid'] }, { key: 'short', label: 'Short', statuses: ['short'] },
  { key: 'unpaid', label: 'Unpaid or Late', statuses: ['unpaid', 'late'] }, { key: 'due', label: 'Due', statuses: ['due'] },
  { key: 'upcoming', label: 'Upcoming', statuses: ['upcoming'] }, { key: 'covered', label: 'Covered', statuses: ['covered'] },
];
/** Whether a row has a month in one of the picked states within the months shown. Ledger account rows have no schedule: never. */
export function rowInStates(row, picked, [from, to]) {
  if (!picked.length) return true;
  if (row.kind === 'account') return false;
  const want = new Set(STATE_FILTERS.filter((f) => picked.includes(f.key)).flatMap((f) => f.statuses));
  return row.months.slice(from, to + 1).some((c) => c && c.inForce && !blankMonth(c) && want.has(c.status));
}
// Figures in text (titles, the reminder email) read as the screen shows them.
const money = formatAmount;
const whole = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
// The Nexus date picker in a box shaped like the other inputs (Oct 22, Urmi:
// native date inputs showed dd-mm-yyyy in a browser set to another language).
const dateBox = { ...control, display: 'flex', alignItems: 'center', width: '100%' };
const chipStyle = (tone) => ({ display: 'inline-block', marginLeft: 6, padding: '0 7px', borderRadius: 999, fontSize: '0.66rem', fontWeight: 700, whiteSpace: 'nowrap', verticalAlign: 'middle',
  color: tone === 'bad' ? 'var(--bad-fg, #dc2626)' : 'var(--text-secondary)', background: tone === 'bad' ? 'rgba(220,38,38,0.10)' : 'var(--bg-secondary)', border: '1px solid var(--border-color)' });
const monthName = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
// Oct 7: a new source starts on the 1st of this month, and its first rent
// with it - not today (a lease typed in on the 2nd expected 30/31 of a month
// and nothing before it).
const firstOfMonth = () => `${iso(new Date()).slice(0, 7)}-01`;
const blank = (incomeType = 'lease') => ({ incomeType, frequency: 'monthly', frequencyMonths: 0, propertyName: '', region: '', tenancy: 'external', landlord: '', entityCode: '', incomeAccounts: leaseLike(incomeType) ? ['41101'] : [], customerId: '', tenantName: '', contactName: '', phone: '', email: '', mailingAddress: '', leaseStart: firstOfMonth(), leaseEnd: '', securityDeposit: 0, leaseTerms: '', termType: '', termMonths: null, lateFee: 0, dueDay: 1, graceDays: 5, status: 'active', notes: '', rates: [{ startDate: firstOfMonth(), rent: 0, cam: 0, other: 0, note: '' }] });
// Oct 15 (Charmi + Neil): the lease term is a pick - Annual, Month to Month or
// Custom with a whole number of months - never free text a typo can break.
const TERM_OPTIONS = [['annual', 'Annual'], ['month_to_month', 'Month to Month'], ['custom', 'Custom']];
const TERM_MAX_MONTHS = 600;
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
/** Old free-text Lease Terms read as a term, best-effort (the server does the
 *  same): "Annual" / "12 months" / "1 year" -> annual, "Month to month" /
 *  "MTM" -> month to month, "18 months" / "2 years" -> custom. null when it
 *  cannot be read. */
export function parseLeaseTerm(text) {
  const s = String(text || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim().replace(/^[ .]+|[ .]+$/g, '');
  if (!s) return null;
  if (['annual', 'annually', 'yearly', 'annual lease', 'annual term', 'annual renewal'].includes(s)) return { termType: 'annual', termMonths: 12 };
  if (['mtm', 'm2m', 'month to month', 'monthly', 'month to month lease'].includes(s)) return { termType: 'month_to_month', termMonths: null };
  let m = s.match(/^(\d{1,3}) ?(?:months?|mos?|mths?)(?: lease| term)?$/);
  let n = m ? Number(m[1]) : null;
  if (!m) {
    m = s.match(/^(\d{1,2}|one|two|three|four|five) ?(?:years?|yrs?)(?: lease| term)?$/);
    if (m) n = (WORD_NUM[m[1]] || Number(m[1])) * 12;
  }
  if (!m || !(n > 0 && n <= TERM_MAX_MONTHS)) return null;
  return n === 12 ? { termType: 'annual', termMonths: 12 } : { termType: 'custom', termMonths: n };
}
/** The term a lease row carries: its pick, else its old text read best-effort. */
const termOf = (l) => {
  if (TERM_OPTIONS.some(([k]) => k === l?.termType)) return { termType: l.termType, termMonths: l.termType === 'annual' ? 12 : l.termType === 'custom' ? (l.termMonths ?? null) : null, termLegacy: '' };
  const parsed = parseLeaseTerm(l?.leaseTerms);
  return parsed ? { ...parsed, termLegacy: '' } : { termType: '', termMonths: null, termLegacy: l?.termLegacy || String(l?.leaseTerms || '').trim() };
};
/** "Annual", "Month to Month", "Custom - 18 Months"; the old text when it could not be read. */
export function leaseTermLabel(l) {
  const t = termOf(l);
  if (t.termType === 'annual') return 'Annual';
  if (t.termType === 'month_to_month') return 'Month to Month';
  if (t.termType === 'custom' && t.termMonths) return `Custom - ${t.termMonths} Months`;
  return t.termLegacy;
}
/** The name the tenant goes by: Intacct's when the customer record came with the row. */
const tenantOf = (r) => (r.kind === 'account' ? 'From the ledger' : r.lease.status === 'vacant' ? 'Vacant' : r.customer?.name || r.lease.tenantName || r.lease.customerId || '-');
/** A month that counts: in force, past or present, and read. A month posted
 *  outside the lease dates counts toward Received only (its expected and
 *  balance are 0 from the server). */
const counts = (c) => c.inForce && c.status !== 'upcoming' && c.status !== 'unknown';
/** A month with nothing to show: not in force, or outside the lease dates with nothing posted (Urmi, 10/14: a dash, not 0). */
const blankMonth = (c) => !c || !c.inForce || ((c.status === 'outside' || c.offCycle) && Math.abs(c.received || 0) <= 0.005);
/** Lease-like types: a tenant, a space and lease dates. */
const leaseLike = (t) => (t || 'lease') === 'lease' || t === 'cam';
/** Not an active lease (Urmi, 10/14): ended, vacant, past its end, or the payer is inactive in Intacct. */
const inactiveRow = (r) => !!r.expired || r.customerActive === false || (r.lease?.status || 'active') !== 'active';
/** The notes written on single months, as one line: "Mar: text; Jun: text". */
const monthNotesText = (row) => (row.months || []).filter((c) => c.note).map((c) => `${MONTHS[Number(c.month.slice(5, 7)) - 1]}: ${c.note}`).join('; ');
/** How an overpayment was applied to a month, in words (Oct 22). */
export function coverText(c) {
  const parts = [];
  if (c?.covered) parts.push(`${money(c.covered)} covered by the ${(c.coveredBy || []).map(monthName).join(', ')} payment${(c.coveredBy || []).length === 1 ? '' : 's'}${c.prepaid ? ' (prepaid)' : ''}`);
  if (c?.applied) parts.push(`${money(c.applied)} of this payment applied to ${(c.appliedTo || []).map(monthName).join(', ')} - the oldest open month first`);
  return parts.join('. ');
}
const rowKey = (r) => (r.kind === 'account' ? r.key : r.lease.id);
const rowName = (r) => (r.kind === 'account' ? `${r.account.code} ${r.account.title}` : r.lease.propertyName);

/** The interest and loan income accounts on the ledger as rows of their own:
 *  what posted each month (credit - debit), less what the sources kept here
 *  already read from that account that month - so nothing counts twice. */
export function ledgerIncomeRows(bucketRows, sourceRows, year) {
  const by = new Map();
  (bucketRows || []).filter(isRecurringIncomeAccount).forEach((r) => {
    const m = Number((r.bucket || '').slice(5, 7)) - 1;
    if (m < 0 || m > 11) return;
    const cur = by.get(r.account_no) || { code: r.account_no, title: r.title, months: new Array(12).fill(0) };
    cur.months[m] = Math.round((cur.months[m] + (r.credit || 0) - (r.debit || 0)) * 100) / 100;
    by.set(r.account_no, cur);
  });
  (sourceRows || []).forEach((row) => row.months.forEach((c, i) => {
    Object.entries(c.byAccount || {}).forEach(([code, v]) => { const a = by.get(code); if (a) a.months[i] = Math.round((a.months[i] - v) * 100) / 100; });
  }));
  return [...by.values()].sort((a, b) => a.code.localeCompare(b.code, 'en-US', { numeric: true })).map((a) => ({
    kind: 'account', key: `acct:${a.code}`, type: accountType(a.title), account: { code: a.code, title: a.title },
    months: a.months.map((v, i) => {
      const month = `${year}-${String(i + 1).padStart(2, '0')}`;
      return Math.abs(v) > 0.005 ? { month, inForce: true, expected: 0, received: v, balance: 0, status: 'income' } : { month, inForce: false };
    }),
  })).filter((r) => r.months.some((c) => c.inForce));
}

/** One row's figures over the months shown: received (the Total column), expected and the balance. */
function rowFigures(row, [from, to]) {
  const cells = row.months.slice(from, to + 1);
  const sum = (f) => Math.round(cells.reduce((s, c) => s + (counts(c) ? f(c) : 0), 0) * 100) / 100;
  return { received: sum((c) => c.received), expected: sum((c) => c.expected), balance: sum((c) => c.balance) };
}

/** Expired / Inactive in words, for the export. */
const standingText = (r) => [r.expired ? 'Expired' : '', r.customerActive === false ? 'Inactive' : '', r.lease?.possiblyEnded ? 'Possibly Ended' : ''].filter(Boolean).join(', ');
/** The team note and the notes written on single months, for the export. */
const notesText = (r) => [r.lease.teamNote?.text || '', monthNotesText(r)].filter(Boolean).join(' - ');
/** The rate in force this month (the Amount column). */
const rateNow = (l, thisMonth) => [...(l.rates || [])].reverse().find((x) => x.startDate <= `${thisMonth}-31`) || (l.rates || [])[0];
/** What a month's cell shows: received, or what is expected when not yet paid; null for a dash. */
const monthShown = (c) => {
  if (!c || !c.inForce || blankMonth(c)) return null;
  if (c.status === 'covered') return c.received + (c.covered || 0);
  if (c.status === 'upcoming' || c.status === 'due' || c.status === 'unknown') return c.expected;
  return c.received;
};

/**
 * The Income Roll's columns for the standard table view (10/23 meeting, item
 * 01): the property pinned first, the Amount, each month shown, Total and
 * Balance as amounts (the totals line adds up the months, Total and Balance
 * as it always did), the notes. Payer and Status export beside the property,
 * as before.
 */
function mriRollColumns([from, to], thisMonth) {
  const money = (v) => (v == null ? '' : whole(v));
  const amountOf = (r) => { if (r.kind === 'account') return null; const rate = rateNow(r.lease, thisMonth); return rate ? rate.rent + rate.cam + rate.other : null; };
  return [
    { key: 'property', label: 'Property or Source', fixed: true, text: rowName, sortBy: (r) => rowName(r).toLowerCase(),
      exportAs: [{ label: 'Property or Source', width: 200, get: rowName }, { label: 'Payer', width: 170, get: tenantOf }, { label: 'Status', width: 80, get: (r) => (r.kind === 'account' ? '' : standingText(r)) }] },
    { key: 'type', label: 'Type', text: (r) => TYPE_LABEL[typeOf(r)] || 'Other', exportAs: [{ label: 'Type', width: 90, get: (r) => TYPE_LABEL[typeOf(r)] }] },
    { key: 'amount', label: 'Amount', type: 'amount', value: amountOf, text: (r) => money(amountOf(r)), exportAs: [{ label: 'Amount', num: true, width: 80, get: (r) => amountOf(r) ?? '' }] },
    ...MONTHS.map((m, i) => ({
      key: `m${i}`, label: m, type: 'amount', value: (r) => monthShown(r.months[i]), text: (r) => money(monthShown(r.months[i])),
      exportAs: [{ label: m, num: true, width: 70, total: true, get: (r) => { const c = r.months[i]; return blankMonth(c) ? '-' : counts(c) ? c.received : 0; } }],
    })).slice(from, to + 1),
    { key: 'total', label: 'Total', type: 'amount', total: true, value: (r) => rowFigures(r, [from, to]).received, text: (r) => money(rowFigures(r, [from, to]).received) },
    { key: 'balance', label: 'Balance', type: 'amount', total: true, value: (r) => rowFigures(r, [from, to]).balance, text: (r) => money(rowFigures(r, [from, to]).balance) },
    { key: 'notes', label: 'Notes', text: (r) => (r.kind === 'account' ? '' : notesText(r)), exportAs: [{ label: 'Notes', width: 180, get: (r) => (r.kind === 'account' ? '' : notesText(r)) }] },
  ];
}

const behindMonths = (r) => r.months.filter((c) => ['late', 'short', 'unpaid'].includes(c.status)).map((c) => MONTHS[Number(c.month.slice(5, 7)) - 1]);
const contactText = (l) => [l.contactName, l.phone].filter(Boolean).join(' · ');
const ACTIONS = { fixed: true, noFilter: true, noSort: true, exportAs: [], text: () => '' };

// 10/27: the boxes under the headings (columnFilters.jsx). The Property box
// also finds the payer and the customer code the cell shows under it.
const rollFilterColumns = (columns) => filterColumnsOf(columns, { instead: { property: (r) => (r.kind === 'account' ? rowName(r) : `${rowName(r)} ${tenantOf(r)} ${r.lease.customerId || ''}`) } });
const filterCell = filterCellOf('property');

/** Outstanding's columns for the standard table view (item 01): who owes the most first. */
const OUTSTANDING_COLUMNS = [
  { key: 'property', label: 'Property or Source', fixed: true, text: (r) => r.lease.propertyName || '', exportAs: [{ label: 'Property or Source', width: 220, get: (r) => r.lease.propertyName }] },
  { key: 'type', label: 'Type', text: (r) => TYPE_LABEL[typeOf(r)] || 'Other', exportAs: [{ label: 'Type', width: 90, get: (r) => TYPE_LABEL[typeOf(r)] }] },
  { key: 'payer', label: 'Payer', text: tenantOf, exportAs: [{ label: 'Payer', width: 200, get: tenantOf }] },
  { key: 'behind', label: 'Months Behind', type: 'number', value: (r) => r.monthsBehind || 0, text: (r) => `${r.monthsBehind} - ${behindMonths(r).join(', ')}`,
    exportAs: [{ label: 'Months Behind', width: 160, get: (r) => `${r.monthsBehind} - ${behindMonths(r).join(', ')}` }] },
  { key: 'owed', label: 'Balance Due', type: 'amount', total: true, value: (r) => r.owed || 0, text: (r) => whole(r.owed) },
  { key: 'lateFees', label: 'Late Fees', type: 'amount', total: true, value: (r) => r.lateFees || 0, text: (r) => (r.lateFees ? whole(r.lateFees) : '') },
  { key: 'contact', label: 'Contact', text: (r) => contactText(r.lease), exportAs: [{ label: 'Contact', width: 200, get: (r) => [r.lease.contactName, r.lease.phone, r.lease.email].filter(Boolean).join(' · ') }] },
  { key: 'write', label: 'Write', ...ACTIONS },
];
const OUTSTANDING_SORT = { col: 'owed', dir: 'desc' };

/** Payers' columns for the standard table view (item 01). */
const PAYER_COLUMNS = [
  { key: 'property', label: 'Property or Source', fixed: true, text: (r) => r.lease.propertyName || '', exportAs: [{ label: 'Property or Source', width: 220, get: (r) => r.lease.propertyName }] },
  { key: 'type', label: 'Type', text: (r) => TYPE_LABEL[typeOf(r)] || 'Other', exportAs: [{ label: 'Type', width: 90, get: (r) => TYPE_LABEL[typeOf(r)] }] },
  { key: 'payer', label: 'Payer', text: (r) => `${r.lease.customerId ? `${r.lease.customerId} ` : ''}${tenantOf(r)}`, exportAs: [{ label: 'Payer', width: 200, get: tenantOf }, { label: 'Customer', width: 80, get: (r) => r.lease.customerId }] },
  { key: 'landlord', label: 'Landlord', text: (r) => r.lease.landlord || '', exportAs: [{ label: 'Landlord', width: 160, get: (r) => r.lease.landlord }] },
  { key: 'dates', label: 'Dates', type: 'date', value: (r) => r.lease.leaseStart || '', text: (r) => `${r.lease.leaseStart ? formatDate(r.lease.leaseStart) : '-'} to ${r.lease.leaseEnd ? formatDate(r.lease.leaseEnd) : 'Month to Month'}`,
    exportAs: [{ label: 'Start', width: 90, get: (r) => (r.lease.leaseStart ? formatDate(r.lease.leaseStart) : '') }, { label: 'End', width: 90, get: (r) => (r.lease.leaseEnd ? formatDate(r.lease.leaseEnd) : 'Month to Month') }, { label: 'Term', width: 130, get: (r) => leaseTermLabel(r.lease) }] },
  { key: 'amount', label: 'Amount', type: 'amount', value: (r) => { const x = r.lease.rates[r.lease.rates.length - 1]; return x ? x.rent : null; }, text: (r) => { const x = r.lease.rates[r.lease.rates.length - 1]; return x ? whole(x.rent) : ''; },
    exportAs: [{ label: 'Amount', num: true, width: 90, get: (r) => { const x = r.lease.rates[r.lease.rates.length - 1]; return x ? x.rent : 0; } }] },
  { key: 'cam', label: 'CAM', type: 'amount', value: (r) => { const x = r.lease.rates[r.lease.rates.length - 1]; return x?.cam || null; }, text: (r) => { const x = r.lease.rates[r.lease.rates.length - 1]; return x?.cam ? whole(x.cam) : ''; },
    exportAs: [{ label: 'CAM', num: true, width: 80, get: (r) => { const x = r.lease.rates[r.lease.rates.length - 1]; return x ? x.cam : 0; } }] },
  { key: 'deposit', label: 'Deposit', type: 'amount', value: (r) => r.lease.securityDeposit || null, text: (r) => (r.lease.securityDeposit ? whole(r.lease.securityDeposit) : ''),
    exportAs: [{ label: 'Deposit', num: true, width: 90, get: (r) => r.lease.securityDeposit || 0 }] },
  { key: 'status', label: 'Status', text: (r) => [LEASE_STATUS[r.lease.status] || r.lease.status, standingText(r)].filter(Boolean).join(', '),
    exportAs: [{ label: 'Status', width: 120, get: (r) => [LEASE_STATUS[r.lease.status] || r.lease.status, standingText(r)].filter(Boolean).join(', ') }] },
  { key: 'change', label: 'Change', ...ACTIONS },
];
const OUTSTANDING_FILTERS = filterColumnsOf(OUTSTANDING_COLUMNS);
// The Dates box searches the cell as shown (start to end, or Month to Month).
const PAYER_FILTERS = filterColumnsOf(PAYER_COLUMNS, { instead: { dates: PAYER_COLUMNS.find((c) => c.key === 'dates').text } });

/** Chips for a row: Expired (an ended lease) and Inactive (the customer is inactive in Intacct). */
function StandingChips({ row }) {
  return (
    <>
      {row.expired && <span style={chipStyle()} title="The lease has ended">Expired</span>}
      {row.customerActive === false && <span style={chipStyle('bad')} title="The customer is inactive in Intacct">Inactive</span>}
    </>
  );
}

/** A row's Type as a quiet chip. */
function TypeChip({ type }) {
  return <span style={{ ...chipStyle(), marginLeft: 0 }}>{TYPE_LABEL[type] || 'Other'}</span>;
}

export default function LeasingTab({ canEdit = false, canDelete = false }) {
  const [prefs, setPrefs] = useAccountingPrefs();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [roll, setRoll] = useState(null);
  const [ledger, setLedger] = useState(null);         // the income accounts by month (Oct 7)
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [section, setSection] = useState('roll');
  const [q, setQ] = useState('');
  const [entities, setEntities] = useState([]);       // picked entity codes ([] = all)
  const [locations, setLocations] = useState({ entities: [], limited: false });
  const [tenants, setTenants] = useState([]);         // picked customer codes ([] = all)
  const [types, setTypes] = useState([]);             // picked types ([] = all)
  const [period, setPeriod] = useState('year');
  const [custom, setCustom] = useState([0, 11]);
  const [states, setStates] = useState([]);           // picked month states ([] = all) - the legend as a filter
  const [editing, setEditingNow] = useState(null);    // { lease, replacing? }
  // Item 03 (10/23): the lease opens in a side panel with the list still
  // clickable, so another lease (or Add) can replace it - unsaved edits are
  // asked about first, never dropped quietly.
  const editorDirty = useRef(false);
  const setEditing = useCallback(async (next) => {
    if (next && editorDirty.current) {
      const ok = await dialog.confirm('The lease open on the right has unsaved changes. Discard them and open this one?', { title: 'Unsaved Changes', confirmText: 'Discard Edits', cancelText: 'Keep Editing', danger: true });
      if (!ok) return;
    }
    editorDirty.current = false;
    setEditingNow(next);
  }, []);
  const [cell, setCell] = useState(null);             // { row, month }
  const [sending, setSending] = useState(null);       // email | egnyte
  const [sent, setSent] = useState(null);             // { text, url }
  const [exporting, setExporting] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(null);
  const seq = useRef(0);
  const showInactive = !!prefs.mriShowInactiveLeases;   // Oct 14: one switch, off by default
  const cz = useCustomizePrefs(['density', 'pageSize', 'historicalEntities']);
  const py = DENSITIES.find((d) => d.key === cz.density)?.py || '5px';
  const entityKey = entities.join(',');

  const load = useCallback((y, ents) => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    // The interest and loan income accounts come from the ledger beside the
    // rent roll; the screen never waits on them or fails over them.
    const income = api.getAccountingBucketsFor
      ? api.getAccountingBucketsFor({ from: `${y}-01-01`, to: `${y}-12-31`, by: 'month', locations: ents }).catch(() => ({ rows: [], unread: true }))
      : Promise.resolve({ rows: [] });
    return Promise.all([api.getLeasingRentRollFor(y, { entities: ents }), income])
      .then(([d, b]) => { if (mine === seq.current) { setRoll(d); setLedger(b); } })
      .catch((e) => { if (mine === seq.current) { setRoll((r) => r || { rows: [], totals: [], summary: {} }); setError(e?.message || 'Could not load the rent roll.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, []);
  useEffect(() => { load(year, entityKey ? entityKey.split(',') : []); }, [year, entityKey, load]);
  useEffect(() => { api.getAccountingLocations().then((d) => setLocations({ entities: d?.entities || [], limited: !!d?.limited })).catch(() => {}); }, []);
  const reload = () => load(year, entities);
  // 10/27 (Urmi): a new Possibly Ended setting re-checks every source on the
  // server; when it is done the rent roll is read again (flags, counts, export).
  const recheck = useStaleRecheck(useCallback(() => withFreshReads(() => load(year, entityKey ? entityKey.split(',') : [])), [load, year, entityKey]));

  const span = periodMonths(period, year, custom);
  const [spanFrom, spanTo] = span;
  const accountRows = useMemo(() => ledgerIncomeRows(ledger?.rows, roll?.rows, year), [ledger, roll, year]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const picked = new Set(tenants);
    const kinds = new Set(types);
    const kept = (roll?.rows || []).filter((r) => {
      const l = r.lease;
      if (kinds.size && !kinds.has(typeOf(r))) return false;
      if (picked.size && !picked.has(l.customerId)) return false;
      if (!rowInStates(r, states, [spanFrom, spanTo])) return false;
      // A text filter finds inactive leases too (marked); otherwise Customize decides.
      if (s) return [l.propertyName, l.tenantName, r.customer?.name, l.landlord, l.region, l.customerId, l.teamNote?.text, monthNotesText(r), TYPE_LABEL[typeOf(r)]].some((v) => (v || '').toLowerCase().includes(s));
      if (!showInactive && inactiveRow(r) && !picked.has(l.customerId)) return false;
      return true;
    });
    // The ledger's income account rows have no payer: picking payers leaves them out.
    const ledgerRows = picked.size || states.length ? [] : accountRows.filter((r) => (!kinds.size || kinds.has(r.type))
      && (!s || [r.account.code, r.account.title, TYPE_LABEL[r.type]].some((v) => (v || '').toLowerCase().includes(s))));
    return [...kept, ...ledgerRows];
  }, [roll, accountRows, q, tenants, types, showInactive, states, spanFrom, spanTo]);
  const sources = useMemo(() => rows.filter((r) => r.kind !== 'account'), [rows]);
  const thisMonth = iso(new Date()).slice(0, 7);
  // 10/23 meeting, item 01: the Income Roll's standard view over what the
  // pickers, the colors and the search leave; the figures above it, its
  // totals line and its export follow it. (Widths dragged before: 'mriRoll'.)
  const rollColumns = useMemo(() => mriRollColumns([spanFrom, spanTo], thisMonth), [spanFrom, spanTo, thisMonth]);
  // 10/27: a filter box under every heading (columnFilters.jsx, as on MRE) on
  // all three tables; they stack with the bar's filters, and the figures, the
  // totals and Export follow what they leave.
  const rollBoxes = useMemo(() => rollFilterColumns(rollColumns), [rollColumns]);
  const rollFilters = useColumnFilters(rows, rollBoxes);
  const rollView = useTableView('mri-roll', rollColumns, rollFilters.rows, { widthsKey: 'mriRoll' });
  const rollRows = rollView.rows;
  const figures = useMemo(() => rollRows.reduce((t, r) => {
    const f = rowFigures(r, span);
    return { expected: t.expected + f.expected, received: t.received + f.received, balance: t.balance + f.balance };
  }, { expected: 0, received: 0, balance: 0 }), [rollRows, span]);
  const hidden = showInactive ? 0 : (roll?.rows || []).filter(inactiveRow).length;
  const customers = useMemo(() => {
    const by = new Map();
    (roll?.rows || []).forEach((r) => { if (r.lease.customerId && !by.has(r.lease.customerId)) by.set(r.lease.customerId, { code: r.lease.customerId, name: tenantOf(r), off: inactiveRow(r) }); });
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
  }, [roll]);
  const sum = roll?.summary || {};
  const behind = useMemo(() => sources.filter((r) => r.monthsBehind), [sources]);
  // Outstanding and Payers have their own views (item 01) and their own boxes.
  const outFilters = useColumnFilters(behind, OUTSTANDING_FILTERS);
  const payerFilters = useColumnFilters(sources, PAYER_FILTERS);
  const outView = useTableView('mri-outstanding', OUTSTANDING_COLUMNS, outFilters.rows, { sort: OUTSTANDING_SORT });
  const payersView = useTableView('mri-payers', PAYER_COLUMNS, payerFilters.rows);
  const sectionView = section === 'outstanding' ? outView : section === 'tenants' ? payersView : rollView;
  const sectionFilters = section === 'outstanding' ? outFilters : section === 'tenants' ? payerFilters : rollFilters;
  // Rows per Page: back to page 1 whenever the filters or the section change.
  const pageKey = [section, year, entities, tenants, types, period, custom, cz.pageSize, q, showInactive, states, sectionView.state, JSON.stringify(sectionFilters.typed)];
  const pageSize = cz.pageSize;
  // A ledger income account's Total opens its lines in Reports for the months shown (item 33).
  const drillWindow = () => {
    const last = new Date(year, span[1] + 1, 0).getDate();
    return { from: `${year}-${String(span[0] + 1).padStart(2, '0')}-01`, to: `${year}-${String(span[1] + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
  };
  const drillAccount = (r) => {
    requestReportDrill({ account: r.account.code, accountName: r.account.title, ...drillWindow(), entity: entities.length === 1 ? entities[0] : '' });
  };
  // Oct 14 (Charmi: "we should be able to drill down"): a lease's Total and
  // Balance open its ledger lines in Reports - the customer, over the months
  // shown, on its income account when it has just one (several: every line
  // of the customer, to narrow there).
  const drillLease = (r) => {
    const l = r.lease;
    if (!l.customerId) return;
    const accounts = l.incomeAccounts || [];
    requestReportDrill({ ...(accounts.length === 1 ? { account: accounts[0], accountName: '' } : {}), ...drillWindow(),
      party: { kind: 'customer', code: l.customerId, name: tenantOf(r) }, entity: l.entityCode || (entities.length === 1 ? entities[0] : '') });
  };
  const updateNote = (id, note) => setRoll((d) => d && { ...d, rows: d.rows.map((r) => (r.lease.id === id ? { ...r, lease: { ...r.lease, teamNote: note } } : r)) });

  // What the Export menu writes: the section on screen, as on screen.
  const entityLabel = !entities.length ? (locations.limited ? 'All my entities' : 'All entities') : entities.length === 1 ? (() => { const e = locations.entities.find((x) => x.code === entities[0]); return e?.name ? `${e.name} (${e.code})` : entities[0]; })() : `${entities.length} entities`;
  const periodLabel = periodText(period, year, span);
  const buildTable = () => {
    const title = section === 'outstanding' ? 'Income Outstanding' : section === 'tenants' ? 'Payers' : 'Monthly Recurring Income';
    const subtitle = `${entityLabel} · ${periodLabel}${types.length ? ` · ${types.map((t) => TYPE_LABEL[t]).join(', ')}` : ''}${tenants.length ? ` · ${tenants.length} ${tenants.length === 1 ? 'payer' : 'payers'}` : ''}${q.trim() ? ` · "${q.trim()}"` : ''}`;
    // Each section: exactly what its view leaves - rows, order and columns (item 01).
    if (section === 'outstanding') return { ...viewTable(outView.rows, outView.columns, { title, subtitle, totalLabel: 'Total Outstanding' }), name: `${title} - ${year}` };
    if (section === 'tenants') return { ...viewTable(payersView.rows, payersView.columns, { title, subtitle, totals: false }), name: `${title} - ${year}` };
    // The Income Roll: exactly what its view leaves - rows, order and columns.
    return { ...viewTable(rollRows, rollView.columns, { title, subtitle, totalLabel: 'Total Received' }), name: `${title} - ${periodLabel}` };
  };
  const exportAs = async (format) => {
    if (exporting) return;
    setExporting(format);
    try {
      const file = await linesFile(buildTable(), format);
      downloadBlob(file.name, file);
    } catch (e) {
      setError(e?.message || 'Could not export.');
    } finally {
      setExporting('');
    }
  };
  const syncNow = () => {
    setSyncing(true);
    setSynced(null);
    api.syncLeasingFromLedger()
      .then((d) => { setSynced(d); return withFreshReads(reload); })   // item 13 (10/23): past the server's cache
      .catch((e) => setError(e?.message || 'Could not sync with the ledger.'))
      .finally(() => setSyncing(false));
  };
  const linked = [...(roll?.linked || []), ...(synced?.linked || [])];
  const possiblyEnded = rollRows.filter((r) => r.lease?.possiblyEnded).length;
  // 10/27 (Neil, item 07): the completeness check over the entities and the
  // period picked; a click on a gap shows its source on the Income Roll,
  // clearing the quick filters that hide it.
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeNote, setCompleteNote] = useState('');
  const [focus, setFocus] = useState(null);
  const gaps = useMemo(() => mriGaps(roll?.rows, [spanFrom, spanTo]), [roll, spanFrom, spanTo]);
  const pickGap = (g) => {
    setCompleteNote('');
    setSection('roll');
    const r = (roll?.rows || []).find((x) => x.lease?.id === g.id);
    if (r && !rollRows.some((x) => x.lease?.id === g.id)) {
      setQ('');
      setTenants([]);
      setTypes([]);
      setStates([]);
      rollFilters.clear();
      if (inactiveRow(r) && !showInactive) setPrefs({ mriShowInactiveLeases: true });
    }
    setFocus((f) => ({ id: g.id, n: (f?.n || 0) + 1 }));
  };
  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' };
  const noun = (n) => `${n} ${n === 1 ? 'source' : 'sources'}`;

  return (
    <AsyncSection loading={roll === null} skeleton={<SkeletonBlocks count={3} />}>
      {/* One column no wider than the screen: a wide year scrolls inside the
          Income Roll box (its property column and total stay pinned), not the page. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}>
        <ControlBar style={{ ...card, padding: '8px 10px' }}>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
            {SECTIONS.map((s) => (
              <button key={s.key} type="button" onClick={() => setSection(s.key)} aria-pressed={section === s.key}
                style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: section === s.key ? 700 : 500, border: `1px solid ${section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: section === s.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
                {s.label}{s.key === 'outstanding' && sum.behind ? ` (${sum.behind})` : ''}
              </button>
            ))}
          </div>
          <PeriodPicker year={year} onYear={setYear} period={period} onPeriod={setPeriod} custom={custom} onCustom={setCustom} />
          {/* Round 3 (UI test 10/24: two lines at 1100, the page scrolling): Entities and Sync are the fourth to move into More, Export the fifth. */}
          <BarMore level={4} active={entities.length ? 1 : 0}>
          <EntitiesPicker entities={locations.entities} value={entities} onChange={setEntities} limited={locations.limited} showHistorical={!!prefs.showHistoricalEntities} />
          </BarMore>
          <BarMore level={2} active={(types.length ? 1 : 0) + (tenants.length ? 1 : 0)}>
          <MultiPicker label="Type filter" allLabel="All Types" noun={['type', 'types']} Icon={Tags} options={TYPES.map((t) => ({ code: t.key, name: t.label }))} value={types} onChange={setTypes} showCodes={false} />
          <MultiPicker label="Payer filter" allLabel="All Payers" noun={['payer', 'payers']} Icon={Users} options={customers} value={tenants} onChange={setTenants}
            find="Find a payer by name or customer code" empty="No payer has a customer code yet." />
          </BarMore>
          {/* 10/23 meeting, item 02 (fix 10/24): the search is an icon until used; Customize and Settings move into More on a narrow row. */}
          <BarSearch value={q} onChange={setQ} label="Filter by property, payer or account" placeholder="Filter by property, payer or account" width={240} />
          <TableViewBar key={section} view={sectionView} />
          <div className="acct-bar-end">
            <BarMore level={3} active={gapCount(gaps) ? 1 : 0}>
            <CompletenessButton count={gapCount(gaps)} open={completeOpen} onClick={() => setCompleteOpen((o) => !o)} />
            </BarMore>
            <BarMore level={1} active={showInactive ? 1 : 0}>
            <CustomizeButton {...cz} active={showInactive}>
              {[['mriShowInactiveLeases', showInactive, 'Show Inactive Leases', 'Ended, expired and vacant leases, and payers inactive in Intacct. The text filter finds them either way.']].map(([k, on, text, hint]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={(e) => setPrefs({ [k]: e.target.checked })} style={{ marginTop: 2 }} />
                  <span>{text}<span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{hint}</span></span>
                </label>
              ))}
            </CustomizeButton>
            {canDelete && <RecurringSettingsButton onChecked={reload} recheck={recheck} />}
            </BarMore>
            <BarMore level={5}>
            <ExportMenu disabled={!roll} items={[
              { key: 'excel', label: 'Excel', hint: 'As on screen, live totals', onPick: () => exportAs('excel'), busy: exporting === 'excel' },
              { key: 'csv', label: 'CSV', hint: 'Plain values, one row per source', onPick: () => exportAs('csv'), busy: exporting === 'csv' },
              { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: exporting === 'pdf' },
              { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, file attached', Icon: Mail, onPick: () => setSending('email') },
              { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setSending('egnyte') },
            ]} />
            </BarMore>
            {/* 10/23 meeting, item 13: a viewer's Sync reads this table again; an editor's Sync Now also links the leases first. */}
            <BarMore level={4}>
            {!canEdit && <SyncButton onSync={() => { setSyncing(true); withFreshReads(reload).finally(() => setSyncing(false)); }} busy={syncing} />}
            {canEdit && (
              <button type="button" className="secondary-btn" onClick={syncNow} disabled={syncing} aria-label={syncing ? 'Syncing...' : 'Sync Now'} title="Link every lease to its Intacct customer and add the leases of new tenants" style={btn}>
                <RefreshCw size={14} className={syncing ? 'spin' : undefined} /> <span className="acct-bar-label">{syncing ? 'Syncing...' : 'Sync Now'}</span>
              </button>
            )}
            </BarMore>
            {/* The last to move into More, at 1100 with the sidebar open (the three section buttons stay). */}
            {canEdit && (
              <BarMore level={6}>
              <AddMenu ariaLabel="Add an income source" items={[
                { key: 'lease', label: 'New Lease', hint: 'A tenant, the dates and the rent', Icon: Home, onPick: () => setEditing({ lease: blank('lease') }) },
                { key: 'cam', label: 'New CAM Charge', hint: 'Common area maintenance billed to a tenant', Icon: Building2, onPick: () => setEditing({ lease: blank('cam') }) },
                { key: 'interest', label: 'New Interest or Loan Payment', hint: 'Who pays, how much, from when', Icon: Landmark, onPick: () => setEditing({ lease: blank('interest') }) },
              ]} />
              </BarMore>
            )}
          </div>
        </ControlBar>

        {section === 'roll' && <StateFilter value={states} onChange={setStates} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums', padding: '0 4px' }}>
          <span>Expected <strong><Amount value={figures.expected} /></strong></span>
          <span>Received <strong><Amount value={figures.received} /></strong></span>
          <span title="Expected less received. A credit (in parentheses) is a prepayment.">Balance <strong style={{ color: figures.balance > 0.005 ? 'var(--bad-fg, #dc2626)' : figures.balance < -0.005 ? 'var(--ok-fg, #15803d)' : undefined }}><Amount value={figures.balance} /></strong>{figures.balance < -0.005 ? <span style={{ color: 'var(--ok-fg, #15803d)' }}> Credit</span> : null}</span>
          <span style={{ color: 'var(--text-muted)' }}>{periodLabel} · {noun(rollRows.length)}{rollView.count || rollFilters.filtering ? ` of ${rows.length} (filtered)` : ''}{hidden && !q.trim() ? ` · ${hidden} inactive ${hidden === 1 ? 'lease' : 'leases'} hidden (Customize)` : ''}</span>
          {possiblyEnded > 0 && <span data-testid="possibly-ended-count">{possiblyEnded} Possibly Ended</span>}
          <RecheckStatus recheck={recheck} />
        </div>

        {error && <div style={bad}>{error}</div>}
        {roll?.warning && (
          <div style={{ ...card, padding: '8px 12px', borderColor: '#b45309', display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.82rem', color: '#92400e' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />{roll.warning}
          </div>
        )}
        {(linked.length > 0 || synced?.created?.length > 0) && (
          <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '0.82rem', color: 'var(--ok-fg, #15803d)' }}>
            <span style={{ flex: 1 }}>
              {linked.length > 0 && <>Linked {linked.length} {linked.length === 1 ? 'lease' : 'leases'} to the Intacct customer by name: {linked.map((x) => `${x.tenantName || x.propertyName} (${x.customerId})`).join(', ')}. </>}
              {synced?.created?.length > 0 && <>Added {synced.created.length} new {synced.created.length === 1 ? 'tenant' : 'tenants'} from the ledger: {synced.created.map((x) => `${x.tenantName} at ${x.entityName}`).join(', ')}.</>}
            </span>
            <button type="button" onClick={() => { setSynced(null); setRoll((d) => d && { ...d, linked: [] }); }} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}><X size={14} /></button>
          </div>
        )}
        {synced && !linked.length && !synced.created?.length && <div role="status" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '0 4px' }}>The ledger sync found nothing new: every lease is linked and no new tenant posted rent.</div>}
        {sent && (
          <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.82rem', color: 'var(--ok-fg, #15803d)' }}>
            <span style={{ flex: 1 }}>{sent.text}{sent.url && <> <a href={sent.url} target="_blank" rel="noreferrer">Open the File</a></>}</span>
            <button type="button" onClick={() => setSent(null)} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}><X size={14} /></button>
          </div>
        )}

        {loading ? <SkeletonBlocks count={4} /> : (
          <div>
            {section === 'roll' && <RentRoll view={rollView} filters={{ ...rollFilters, columns: rollBoxes }} rows={rollRows} span={span} figures={figures} year={year} thisMonth={thisMonth} py={py} onCell={(row, month) => setCell({ row, month })} onLease={(l) => setEditing({ lease: l })} any={(roll?.rows || []).length + accountRows.length > 0} canEdit={canEdit} onNote={updateNote}
              pageSize={pageSize} pageKey={pageKey} onDrillAccount={drillAccount} onDrillLease={drillLease}
              focus={focus} onMissing={() => setCompleteNote("That source is hidden by the table view's filters. Clear them in the bar to see it.")} />}
            {section === 'outstanding' && <Outstanding view={outView} filters={{ ...outFilters, columns: OUTSTANDING_FILTERS }} rows={outView.rows} year={year} py={py} pageSize={pageSize} pageKey={pageKey} />}
            {section === 'tenants' && <Tenants view={payersView} filters={{ ...payerFilters, columns: PAYER_FILTERS }} rows={payersView.rows} py={py} canEdit={canEdit} pageSize={pageSize} pageKey={pageKey} onEdit={(l) => setEditing({ lease: l })} onReplace={(l) => setEditing({ lease: { ...blank(l.incomeType || 'lease'), propertyName: l.propertyName, region: l.region, tenancy: l.tenancy, landlord: l.landlord, entityCode: l.entityCode, incomeAccounts: l.incomeAccounts, lateFee: l.lateFee, dueDay: l.dueDay, graceDays: l.graceDays }, replacing: l })} />}
          </div>
        )}
      </div>
      {completeOpen && !editing && (
        <CompletenessPanel caption={`MRI · ${entityLabel} · ${periodLabel}`} groups={gaps} note={completeNote} onPick={pickGap} onClose={() => setCompleteOpen(false)}
          rule="A gap is a month that is over and reads Unpaid with no note on it, or an active source with no amount or no frequency. Ended and vacant sources are left out." />
      )}
      {cell && <MonthDetail cell={cell} canEdit={canEdit} onClose={() => setCell(null)} onSaved={() => { setCell(null); reload(); }} />}
      {editing && <LeaseEditor key={`${editing.lease.id || `new-${editing.lease.incomeType}`}|${editing.replacing?.id || ''}`} lease={editing.lease} replacing={editing.replacing} canDelete={canDelete}
        onDirty={(d) => { editorDirty.current = d; }} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {sending && (() => {
        const t = buildTable();
        return (
          <SendReportDialog mode={sending} title={t.title} baseName={t.name} what="lines" makeFile={async (format, name) => linesFile(buildTable(), format, name)}
            onClose={() => setSending(null)} onDone={(text, url) => { setSending(null); setSent({ text, url }); }} />
        );
      })()}
    </AsyncSection>
  );
}

// The color legend as a multi-select filter at the top of the Income Roll
// (Oct 22 - Charmi: "make the legend clickable"; Neil: "should be a filter
// option at the top"). Nothing picked = every row.
function StateFilter({ value, onChange }) {
  const on = new Set(value);
  const toggle = (k) => { const n = new Set(on); if (n.has(k)) n.delete(k); else n.add(k); onChange(STATE_FILTERS.map((f) => f.key).filter((x) => n.has(x))); };
  return (
    <div role="group" aria-label="Show rows with a month that is" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: '0.74rem', padding: '0 4px' }}>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Show Rows With:</span>
      {STATE_FILTERS.map((f) => {
        const st = STATUS[f.key];
        const picked = on.has(f.key);
        return (
          <button key={f.key} type="button" aria-pressed={picked} onClick={() => toggle(f.key)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '2px 10px', font: 'inherit', fontWeight: picked ? 700 : 500, cursor: 'pointer',
              border: `1px solid ${picked ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, background: picked ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)', color: 'var(--text-primary)' }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: st.bg, border: `1px solid ${st.fg}` }} />{f.label}
            {picked && <Check size={12} style={{ color: 'var(--wk-brand, #2b45e1)' }} />}
          </button>
        );
      })}
      {value.length > 0 && <button type="button" onClick={() => onChange([])} style={{ border: 'none', background: 'none', padding: '2px 4px', font: 'inherit', color: 'var(--wk-brand, #2b45e1)', cursor: 'pointer' }}>Clear</button>}
    </div>
  );
}

// A multi-select filter (Charmi, 10/04: "if we want to see only certain
// customers we should be able to"; Oct 7: the same for the Type). The payer
// list is the payers of the sources loaded; expired and inactive ones are marked.
function MultiPicker({ label: aria, allLabel, noun, Icon, options, value, onChange, showCodes = true, find: findHint = 'Find', empty = 'Nothing to pick.' }) {
  const [open, setOpen, ref] = usePopover();
  const [find, setFind] = useState('');
  const chosen = new Set(value);
  const s = find.trim().toLowerCase();
  const shown = (s ? options.filter((o) => o.code.toLowerCase().includes(s) || o.name.toLowerCase().includes(s)) : options).slice(0, 400);
  const one = value.length === 1 ? options.find((o) => o.code === value[0]) : null;
  const text = !value.length ? allLabel : one ? one.name : `${value.length} ${noun[1]}`;
  const toggle = (code) => { const n = new Set(chosen); if (n.has(code)) n.delete(code); else n.add(code); onChange([...n]); };
  const on = value.length > 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} aria-label={aria} title={text}
        style={{ ...control, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', maxWidth: 260, whiteSpace: 'nowrap', border: `1px solid ${on ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: on ? 'var(--wk-brand, #2b45e1)' : 'var(--text-primary)', fontWeight: on ? 600 : 400 }}>
        <Icon size={14} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
        <span className={value.length ? undefined : 'acct-bar-label-2'} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} role="listbox" aria-label={allLabel.replace(/^All /, '')} aria-multiselectable="true"
        style={{ width: showCodes ? 380 : 240, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 10 }}>
        {showCodes && <input type="text" value={find} onChange={(e) => setFind(e.target.value)} placeholder={findHint} aria-label={findHint} autoFocus style={{ ...control, width: '100%' }} />}
        <div style={{ maxHeight: 'min(480px, calc(100vh - 230px))', overflowY: 'auto', marginTop: showCodes ? 6 : 0, display: 'grid', gap: 1 }}>
          {!s && (
            <button type="button" onClick={() => onChange([])} style={{ display: 'flex', alignItems: 'center', gap: 8, border: 'none', borderRadius: 6, background: !value.length ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', padding: '5px 8px', font: 'inherit', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)' }}>
              <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{!value.length ? <Check size={14} /> : null}</span>{allLabel}
            </button>
          )}
          {shown.map((o) => (
            <button key={o.code} type="button" role="option" aria-selected={chosen.has(o.code)} onClick={() => toggle(o.code)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, border: 'none', borderRadius: 6, background: chosen.has(o.code) ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', padding: '5px 8px', font: 'inherit', fontSize: '0.8rem', cursor: 'pointer', textAlign: 'left', color: o.off ? 'var(--text-muted)' : 'var(--text-primary)' }}>
              <span style={{ width: 14, display: 'inline-flex', color: 'var(--wk-brand, #2b45e1)' }}>{chosen.has(o.code) ? <Check size={14} /> : null}</span>
              {showCodes && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>{o.code}</span>}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
            </button>
          ))}
          {!shown.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: 6 }}>{options.length ? 'No match.' : empty}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
        </div>
      </PopoverPanel>
    </div>
  );
}

// The tenant's name: hover (or click, for touch and keyboard) opens the
// customer's card - Name, Telephone Number, Address, Email Address
// (Charmi, 10/04). Read once per customer per visit.
const customerCache = new Map();
function TenantName({ row, style }) {
  const [open, setOpen, ref] = usePopover();
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState('');
  const timer = useRef(null);
  const l = row.lease;
  const code = l.customerId;
  const name = tenantOf(row);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!code || l.status === 'vacant') return <span style={style}>{name}</span>;
  const fetchInfo = () => {
    if (info || customerCache.has(code)) { if (!info) setInfo(customerCache.get(code)); return; }
    api.getLeasingCustomer(code).then((d) => { customerCache.set(code, d); setInfo(d); }).catch((e) => setFailed(e?.message || 'Could not read the customer.'));
  };
  const show = () => { clearTimeout(timer.current); timer.current = setTimeout(() => { fetchInfo(); setOpen(true); }, 250); };
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 200); };
  const c = info || row.customer || {};
  const fact = (k, v) => (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, fontSize: '0.8rem', padding: '2px 0' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{k}</span><span style={{ overflowWrap: 'anywhere' }}>{v || <span style={{ color: 'var(--text-muted)' }}>Not on file</span>}</span>
    </div>
  );
  return (
    <span ref={ref} style={{ display: 'inline-block', maxWidth: '100%' }} onMouseEnter={show} onMouseLeave={hide}>
      <button type="button" onClick={() => { fetchInfo(); setOpen((v) => !v); }} aria-haspopup="dialog" aria-expanded={open} aria-label={`${name}, customer details`}
        style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'left', textDecoration: 'underline dotted', textDecorationColor: 'var(--text-muted)', textUnderlineOffset: 3, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', ...style }}>
        {name}
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} role="dialog" aria-label={`${name} details`} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={hide}
        style={{ width: 340, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 12, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className="acct-code" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginRight: 0 }}>{code}</span>
          <strong style={{ fontSize: '0.9rem' }}>{c.name || name}</strong>
          {(info ? info.active === false : row.customerActive === false) && <span style={chipStyle('bad')}>Inactive</span>}
          {row.expired && <span style={chipStyle()}>Expired</span>}
        </div>
        {failed ? <div style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)' }}>{failed}</div> : !info && !row.customer ? <SkeletonBlocks count={2} /> : (
          <div>
            {fact('Name', c.name || name)}
            {fact('Telephone Number', c.phone || l.phone)}
            {fact('Address', c.address || l.mailingAddress)}
            {fact('Email Address', c.email || l.email)}
            {(c.contactName || l.contactName) ? fact('Contact', c.contactName || l.contactName) : null}
          </div>
        )}
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{c.source === 'intacct' ? 'From the Intacct customer record.' : 'From the ledger and the lease - Intacct contact details show here once the accounting app shares them.'}</div>
      </PopoverPanel>
    </span>
  );
}

// The team's note on a lease, written in the row (Charmi, 10/04): click,
// type, Enter or leaving the box saves it; who wrote it and when shows on hover.
// Oct 14 (Urmi): the notes written on single months show under it too.
function NoteCell({ lease, canEdit, onSaved, monthNotes = '' }) {
  const note = lease.teamNote || { text: '' };
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const who = note.text ? `${note.byName || note.by}${note.at ? `, ${formatDateTime(note.at)}` : ''}` : '';
  const save = () => {
    if ((text || '').trim() === (note.text || '')) { setEditing(false); return; }
    setBusy(true);
    setError('');
    api.setLeasingNote(lease.id, text)
      .then((d) => { onSaved(lease.id, d); setEditing(false); })
      .catch((e) => setError(e?.message || 'Could not save the note.'))
      .finally(() => setBusy(false));
  };
  if (editing) {
    return (
      <input type="text" value={text} autoFocus maxLength={1000} disabled={busy} aria-label={`Note on ${lease.propertyName}`} title={error || undefined}
        onChange={(e) => setText(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { setText(note.text || ''); setEditing(false); } }}
        style={{ ...control, height: 26, width: '100%', borderColor: error ? 'var(--bad-fg, #dc2626)' : undefined }} />
    );
  }
  const months = monthNotes
    ? <span data-testid="month-notes" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{monthNotes}</span>
    : null;
  const body = note.text
    ? <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note.text}<span style={{ display: 'block', fontSize: '0.66rem', color: 'var(--text-muted)' }}>{who}</span>{months}</span>
    : months ? <span style={{ display: 'block', minWidth: 0 }}>{months}</span> : <span style={{ color: 'var(--text-muted)' }}>{canEdit ? 'Add a note' : '-'}</span>;
  const tip = [note.text ? `${note.text} - ${who}` : '', monthNotes].filter(Boolean).join('\n');
  if (!canEdit) return <span title={tip || undefined}>{body}</span>;
  return (
    <button type="button" onClick={() => { setText(note.text || ''); setEditing(true); }} aria-label={note.text ? `Change the note on ${lease.propertyName}` : `Add a note on ${lease.propertyName}`} title={tip ? `${tip}${note.text ? '' : '\nClick to add a note'}` : 'Add a note'}
      style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: '0.76rem', color: 'var(--text-primary)', cursor: 'text', textAlign: 'left', width: '100%', minWidth: 0 }}>
      {body}
    </button>
  );
}

// The Income Roll box ends on the screen (Viral, 10/22: "Received - 27
// sources is hide when scroll up"): its height is what is left below its top
// with the page scrolled up, at most 74% of the screen and at least 320px, so
// the pinned total row is in view while the rows scroll. `below` is what the
// page still shows under the box - the pager and the note under the roll
// (10/23 meeting, item 05, UI test 10/24: the note pushed the page ~90px past
// the bottom, so the whole page scrolled). Outstanding and Tenants fit the same way.
// Item 02, round 3 (UI test 10/24: at 1100 x 700 the page still scrolled):
// the least it keeps is 240px - a few rows and the total - not 320, which ran
// past the bottom of a 700px window.
export function fitRollHeight(top, screenHeight, below = 12) {
  return Math.round(Math.max(240, Math.min(screenHeight * 0.74, screenHeight - top - below)));
}

function useFitToScreen(ref, active) {
  const [height, setHeight] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return undefined;
    const measure = () => {
      let top = el.getBoundingClientRect().top + window.scrollY;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) top += p.scrollTop;
      setHeight(fitRollHeight(top, window.innerHeight, spaceBelow(el) + 8));
    };
    measure();
    // Re-fit when anything above it moves it: a banner, the toolbar wrapping.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(document.body);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [ref, active]);
  return height;
}

// The Income Roll (Oct 7, item 32: resizable columns, saved per viewer). 10/23
// meeting, item 01: the headings are the standard view's - a click opens the
// menu (sort, filter, width, move, hide), the funnel a value list - and the
// cells and the Received line follow its column order; the property stays
// pinned first.
function RentRoll({ view, filters = null, rows, span, figures, year, thisMonth, py, onCell, onLease, any, canEdit, onNote, pageSize = 0, pageKey = '', onDrillAccount = null, onDrillLease = null, focus = null, onMissing = null }) {
  const paged = usePaged(rows, pageSize, pageKey);
  useJumpToRow(focus, rows, (r) => r.lease?.id, paged, pageSize, onMissing);
  const wrapRef = useRef(null);
  // With a box typed the table stays, so the box can be changed or cleared.
  const boxed = !!filters?.filtering;
  const fitHeight = useFitToScreen(wrapRef, rows.length > 0 || boxed);
  if (!rows.length && !boxed) {
    return (
      <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>{any ? 'Nothing matches these filters.' : `No leases yet.${canEdit ? ' + Add > New Lease: the tenant, the dates and the rent.' : ''}`}</span>
        {any && view.dirty && <button type="button" className="secondary-btn" onClick={view.clear} style={{ fontSize: '0.76rem' }}>Clear</button>}
      </div>
    );
  }
  const [from, to] = span;
  const idx = MONTHS.map((_m, i) => i).slice(from, to + 1);
  const w = (k) => view.manualWidth(k);
  const monthTotal = (i) => rows.reduce((s, r) => { const c = r.months[i]; return s + (c && counts(c) ? c.received : 0); }, 0);
  const monthExpected = (i) => rows.reduce((s, r) => { const c = r.months[i]; return s + (c && counts(c) ? c.expected : 0); }, 0);
  const propertyCell = (children) => (
    <td style={{ position: 'sticky', left: 0, zIndex: 1, whiteSpace: 'normal', minWidth: w('property') || 250, ...(w('property') ? { width: w('property'), maxWidth: w('property'), overflow: 'hidden' } : {}) }}>{children}</td>
  );
  const head = (c) => {
    if (c.key === 'property') return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} style={headStyle(w('property'), { position: 'sticky', left: 0, zIndex: 5, minWidth: w('property') || 250 })} />;
    if (c.key === 'total') return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className="acct-num" title="Received in the months shown" style={headStyle(w('total'))} />;
    if (c.key === 'balance') return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className="acct-num" title="Expected less received in the months shown. A credit (in parentheses) is a prepayment." style={headStyle(w('balance'))} />;
    if (c.key === 'notes') return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} style={headStyle(w('notes'), { minWidth: w('notes') || 180 })} />;
    if (/^m\d+$/.test(c.key)) {
      const i = Number(c.key.slice(1));
      return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className="acct-num" style={headStyle(w(c.key), `${year}-${String(i + 1).padStart(2, '0')}` === thisMonth ? { color: 'var(--wk-brand, #2b45e1)' } : null)} />;
    }
    return <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className={c.type === 'amount' ? 'acct-num' : undefined} style={headStyle(w(c.key))} />;
  };
  return (
    <div style={{ ...card, padding: 10 }}>
      <div ref={wrapRef} className="acct-lines-wrap" style={{ maxHeight: fitHeight || '74vh' }}>
        <table className="acct-lines acct-roll acct-sticky-head" style={{ width: '100%', tableLayout: 'auto', '--acct-row-py': py }}>
          {/* The headings and the boxes under them pin as one block (acct-sticky-head). */}
          <thead>
            <tr>{view.columns.map(head)}</tr>
            {filters && <ColumnFilterRow columns={view.columns} filterColumns={filters.columns} typed={filters.typed} onChange={filters.setFilter} cellProps={filterCell} />}
          </thead>
          <tbody>
            {!rows.length && <NoMatch span={view.columns.length} onClear={filters?.clear} />}
            {paged.rows.map((r) => {
              const f = rowFigures(r, span);
              const name = rowName(r);
              if (r.kind === 'account') {
                const months = Object.fromEntries(idx.map((i) => {
                  const c = r.months[i];
                  if (!c || !c.inForce) return [`m${i}`, <td className="acct-num" style={{ color: 'var(--text-muted)' }}>-</td>];
                  return [`m${i}`, (
                    <td className="acct-num" style={{ padding: 2 }}>
                      <button type="button" onClick={() => onCell(r, c)} aria-label={`${name}, ${monthName(c.month)}: received ${money(c.received)}`} title={`Received ${money(c.received)} - click for the entries`}
                        style={{ width: '100%', border: 'none', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontVariantNumeric: 'tabular-nums', padding: '3px 6px', textAlign: 'right', background: 'transparent', color: 'var(--text-primary)' }}>
                        {whole(c.received)}
                      </button>
                    </td>
                  )];
                }));
                return (
                  <tr key={r.key}>
                    {viewCells(view, {
                      property: propertyCell(
                        <>
                          <span style={{ fontWeight: 600 }}><span className="acct-code">{r.account.code}</span>{r.account.title}</span>
                          <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>From the ledger - every posting to this account, no schedule</div>
                        </>,
                      ),
                      type: <td><TypeChip type={r.type} /></td>,
                      amount: <td className="acct-num" style={{ color: 'var(--text-muted)' }}>-</td>,
                      ...months,
                      total: (
                        <td className="acct-num" style={{ fontWeight: 700 }}>
                          {f.received && onDrillAccount
                            ? <button type="button" className="acct-drill" onClick={() => onDrillAccount(r)} aria-label={`Ledger lines behind the total of ${name}`} title="Open the ledger lines in Reports"><Amount value={f.received} /></button>
                            : f.received ? <Amount value={f.received} /> : '-'}
                        </td>
                      ),
                      balance: <td className="acct-num" style={{ color: 'var(--text-muted)' }} title="No schedule, so nothing is expected">-</td>,
                      notes: <td style={{ color: 'var(--text-muted)' }}>-</td>,
                    })}
                  </tr>
                );
              }
              const l = r.lease;
              const rate = rateNow(l, thisMonth);
              const months = Object.fromEntries(idx.map((i) => {
                const c = r.months[i];
                if (!c || !c.inForce) return [`m${i}`, <td className="acct-num" style={{ color: 'var(--text-muted)' }}>-</td>];
                const st = STATUS[c.status] || STATUS.none;
                const dash = blankMonth(c);
                const off = c.offCycle && dash;
                const credit = coverText(c);
                return [`m${i}`, (
                  <td className="acct-num" style={{ padding: 2 }}>
                    <button type="button" onClick={() => onCell(r, c)} aria-label={`${l.propertyName}, ${monthName(c.month)}: ${off ? 'Not Due This Month' : dash ? 'Not in Force' : st.label}, received ${money(c.received)} of ${money(c.expected)}${credit ? `. ${credit}` : ''}`}
                      title={`${off ? 'Not due this month' : dash ? 'Not in force' : st.label} - received ${money(c.received)} of ${money(c.expected)}${credit ? ` - ${credit}` : ''}${c.note ? ` - ${c.note}` : ''}`}
                      style={{ width: '100%', border: 'none', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontVariantNumeric: 'tabular-nums', padding: '3px 6px', textAlign: 'right', background: dash ? 'transparent' : st.bg, color: dash ? 'var(--text-muted)' : st.fg, fontWeight: ['short', 'unpaid', 'late'].includes(c.status) ? 700 : 400, fontStyle: c.status === 'covered' ? 'italic' : undefined }}>
                      {dash ? '-' : c.status === 'covered' ? whole(c.received + (c.covered || 0)) : c.status === 'upcoming' || c.status === 'due' || c.status === 'unknown' ? whole(c.expected) : whole(c.received)}{c.note ? '*' : ''}
                      {c.covered ? <sup data-testid="covered-mark" aria-hidden="true" style={{ marginLeft: 1, fontSize: '0.6rem', color: 'var(--ok-fg, #15803d)' }}>c</sup> : null}
                    </button>
                  </td>
                )];
              }));
              return (
                <tr key={l.id} data-row-id={l.id} style={r.expired || r.customerActive === false ? { color: 'var(--text-secondary)' } : undefined}>
                  {viewCells(view, {
                    property: propertyCell(
                      <>
                        <button type="button" className="acct-drill" onClick={() => onLease(l)} style={{ fontWeight: 600, textAlign: 'left' }}>{l.propertyName}</button>
                        <StandingChips row={r} />
                        <PossiblyEndedChip flag={l.possiblyEnded} kind="mri" />
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}><TenantName row={r} />{l.status === 'ended' ? ` · ended ${l.leaseEnd ? formatDate(l.leaseEnd) : ''}` : ''}</div>
                      </>,
                    ),
                    type: <td><TypeChip type={typeOf(r)} /></td>,
                    amount: <td className="acct-num">{rate ? whole(rate.rent + rate.cam + rate.other) : '-'}{stepMonths(l) > 1 ? <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{frequencyLabel(l)}</span> : null}</td>,
                    ...months,
                    total: (
                      <td className="acct-num" style={{ fontWeight: 700 }}>
                        {f.received && onDrillLease && l.customerId
                          ? <button type="button" className="acct-drill" onClick={() => onDrillLease(r)} aria-label={`Ledger lines behind the total of ${l.propertyName}`} title="Open the ledger lines in Reports"><Amount value={f.received} /></button>
                          : f.received ? <Amount value={f.received} /> : '-'}
                      </td>
                    ),
                    balance: (
                      <td className="acct-num" style={{ fontWeight: 700, color: f.balance > 0.005 ? 'var(--bad-fg, #dc2626)' : f.balance < -0.005 ? 'var(--ok-fg, #15803d)' : 'var(--text-muted)' }}
                        title={f.balance < -0.005 ? 'Credit - paid ahead' : undefined}>
                        {Math.abs(f.balance) > 0.005
                          ? (onDrillLease && l.customerId
                            ? <button type="button" className="acct-drill" onClick={() => onDrillLease(r)} aria-label={`Ledger lines behind the balance of ${l.propertyName}`} title="Open the ledger lines in Reports" style={{ color: 'inherit' }}><Amount value={f.balance} /></button>
                            : <Amount value={f.balance} />)
                          : '-'}
                      </td>
                    ),
                    notes: <td style={w('notes') ? cellStyle(w('notes'), { whiteSpace: 'normal' }) : { maxWidth: 260, minWidth: 180, whiteSpace: 'normal' }}><NoteCell lease={l} canEdit={canEdit} onSaved={onNote} monthNotes={monthNotesText(r)} /></td>,
                  })}
                </tr>
              );
            })}
            <tr className="acct-grand">
              {viewCells(view, {
                property: <td className="acct-roll-label">Received - {rows.length} {rows.length === 1 ? 'source' : 'sources'}</td>,
                ...Object.fromEntries(idx.map((i) => { const v = monthTotal(i); return [`m${i}`, <td className="acct-num" title={`Expected ${money(monthExpected(i))}`}>{v || monthExpected(i) ? whole(v) : '-'}</td>]; })),
                total: <td className="acct-num"><Amount value={figures.received} /></td>,
                balance: <td className="acct-num"><Amount value={figures.balance} /></td>,
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <Pager {...paged} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
        <span>A paid month shows what came in; a month not yet paid shows what is expected. * has a note. Click a month for the detail and its journal entries. A dash is a month the lease is not in force (or, for a source that is not monthly, a month it does not fall due). A payment above what a month expects settles the oldest open month first: that month reads Covered, and a small c marks a month part or wholly settled that way. Balance is expected less received; a credit (in parentheses) is a prepayment. Total and Balance open the ledger lines. The colors filter the rows above the table.</span>
      </div>
    </div>
  );
}

function reminder(row, year) {
  const l = row.lease;
  const behind = row.months.filter((c) => ['late', 'short', 'unpaid'].includes(c.status));
  const lines = behind.map((c) => `  ${monthName(c.month)}: ${money(c.balance - (c.covered || 0))} of ${money(c.expected)}`).join('\n');
  const body = `Hello ${l.contactName || l.tenantName},\n\nOur records for ${l.propertyName} show rent outstanding for ${year}:\n\n${lines}\n\nTotal outstanding: ${money(row.owed)}${row.lateFees ? `\nLate fees under the lease: ${money(row.lateFees)}` : ''}\n\nIf you have already paid, please reply with the date and amount so we can match it.\n\nThank you.`;
  return `mailto:${encodeURIComponent(l.email)}?subject=${encodeURIComponent(`Rent outstanding - ${l.propertyName}`)}&body=${encodeURIComponent(body)}`;
}

/** The row a table shows when the boxes under its headings leave nothing. */
function NoMatch({ span, onClear }) {
  return (
    <tr>
      <td colSpan={span || 1} style={{ padding: 14, color: 'var(--text-secondary)', fontSize: '0.84rem', whiteSpace: 'normal' }}>
        Nothing matches these column filters.
        {onClear && <button type="button" className="acct-drill" onClick={onClear} style={{ marginLeft: 8 }}>Clear Column Filters</button>}
      </td>
    </tr>
  );
}

function Outstanding({ view, filters = null, rows, year, py, pageSize = 0, pageKey = '' }) {
  // Who owes the most first is the view's built-in sort (item 01).
  const sorted = rows;
  const paged = usePaged(sorted, pageSize, pageKey);
  const wrapRef = useRef(null);
  const boxed = !!filters?.filtering;
  const fitHeight = useFitToScreen(wrapRef, rows.length > 0 || boxed);
  if (!rows.length && !boxed) return <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{view.count ? 'Nobody behind passes the filters.' : `Nobody is behind for ${year}.`}</div>;
  return (
    <div style={{ ...card, padding: 10 }}>
      <div ref={wrapRef} className="acct-lines-wrap" data-testid="mri-outstanding-box" style={fitHeight ? { maxHeight: fitHeight } : undefined}>
        <table className="acct-lines acct-sticky-head" style={{ width: '100%', tableLayout: 'auto', '--acct-row-py': py }}>
          <thead>
            <tr>{view.columns.map((c) => (c.key === 'write' ? <th key={c.key} scope="col" aria-label="Write" />
              : <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className={c.type === 'amount' ? 'acct-num' : undefined} style={headStyle(view.manualWidth(c.key))} />))}</tr>
            {filters && <ColumnFilterRow columns={view.columns} filterColumns={filters.columns} typed={filters.typed} onChange={filters.setFilter} cellProps={filterCell} />}
          </thead>
          <tbody>
            {!rows.length && <NoMatch span={view.columns.length} onClear={filters?.clear} />}
            {paged.rows.map((r) => {
              const l = r.lease;
              const months = behindMonths(r);
              return (
                <tr key={l.id}>
                  {viewCells(view, {
                    property: <td style={{ fontWeight: 600 }}>{l.propertyName}<StandingChips row={r} /></td>,
                    type: <td><TypeChip type={typeOf(r)} /></td>,
                    payer: <td><TenantName row={r} /></td>,
                    behind: <td style={{ whiteSpace: 'normal' }}>{r.monthsBehind} - {months.join(', ')}</td>,
                    owed: <td className="acct-num" style={{ fontWeight: 700, color: 'var(--bad-fg, #dc2626)' }}><Amount value={r.owed} /></td>,
                    lateFees: <td className="acct-num">{r.lateFees ? <Amount value={r.lateFees} /> : '-'}</td>,
                    contact: <td style={{ whiteSpace: 'normal' }}>{contactText(l) || '-'}</td>,
                    write: (
                      <td style={{ textAlign: 'right' }}>
                        {l.email
                          ? <a className="secondary-btn" href={reminder(r, year)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', padding: '3px 10px', textDecoration: 'none' }}><Mail size={13} /> Write to Tenant</a>
                          : <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>No email on file</span>}
                      </td>
                    ),
                  })}
                </tr>
              );
            })}
            <tr className="acct-grand">
              {viewCells(view, {
                property: <td style={{ whiteSpace: 'nowrap' }}>Total Outstanding - {sorted.length} {sorted.length === 1 ? 'tenant' : 'tenants'}</td>,
                owed: <td className="acct-num"><Amount value={sorted.reduce((s, r) => s + r.owed, 0)} /></td>,
                lateFees: <td className="acct-num"><Amount value={sorted.reduce((s, r) => s + r.lateFees, 0)} /></td>,
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <Pager {...paged} />
      <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>Write to Tenant opens your own email with the months and amounts filled in. Nothing is sent until you press send.</div>
    </div>
  );
}

function Tenants({ view, filters = null, rows, py, canEdit, onEdit, onReplace, pageSize = 0, pageKey = '' }) {
  const paged = usePaged(rows, pageSize, pageKey);
  const wrapRef = useRef(null);
  const boxed = !!filters?.filtering;
  const fitHeight = useFitToScreen(wrapRef, rows.length > 0 || boxed);
  if (!rows.length && !boxed) return <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{view.count ? 'No lease passes the filters.' : 'No lease matches.'}</div>;
  return (
    <div style={{ ...card, padding: 10 }}>
      <div ref={wrapRef} className="acct-lines-wrap" data-testid="mri-tenants-box" style={fitHeight ? { maxHeight: fitHeight } : undefined}>
        <table className="acct-lines acct-sticky-head" style={{ width: '100%', tableLayout: 'auto', '--acct-row-py': py }}>
          <thead>
            <tr>{view.columns.map((c) => (c.key === 'change' ? <th key={c.key} scope="col" aria-label="Change" />
              : <ViewHead key={c.key} view={view} col={c} aria-label={c.label} className={c.type === 'amount' ? 'acct-num' : undefined} style={headStyle(view.manualWidth(c.key))} />))}</tr>
            {filters && <ColumnFilterRow columns={view.columns} filterColumns={filters.columns} typed={filters.typed} onChange={filters.setFilter} cellProps={filterCell} />}
          </thead>
          <tbody>
            {!rows.length && <NoMatch span={view.columns.length} onClear={filters?.clear} />}
            {paged.rows.map((r) => {
              const l = r.lease;
              const rate = l.rates[l.rates.length - 1];
              return (
                <tr key={l.id}>
                  {viewCells(view, {
                    property: <td style={{ fontWeight: 600, whiteSpace: 'normal' }}>{l.propertyName}{l.region ? <div style={{ fontWeight: 400, fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{l.region}</div> : null}</td>,
                    type: <td><TypeChip type={typeOf(r)} /></td>,
                    payer: <td style={{ whiteSpace: 'normal' }}>{l.customerId ? <span className="acct-code">{l.customerId}</span> : null}<TenantName row={r} /></td>,
                    landlord: <td style={{ whiteSpace: 'normal' }}>{l.landlord || '-'}</td>,
                    dates: <td>{l.leaseStart ? formatDate(l.leaseStart) : '-'} to {l.leaseEnd ? formatDate(l.leaseEnd) : 'Month to Month'}{leaseTermLabel(l) ? <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>Term: {leaseTermLabel(l)}</div> : null}</td>,
                    amount: <td className="acct-num">{rate ? <Amount value={rate.rent} /> : '-'}</td>,
                    cam: <td className="acct-num">{rate?.cam ? <Amount value={rate.cam} /> : '-'}</td>,
                    deposit: <td className="acct-num">{l.securityDeposit ? <Amount value={l.securityDeposit} /> : '-'}</td>,
                    status: <td>{LEASE_STATUS[l.status] || l.status}<StandingChips row={r} /><PossiblyEndedChip flag={l.possiblyEnded} kind="mri" /></td>,
                    change: (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button type="button" style={icon} aria-label={`Change ${l.propertyName}`} title="Change this lease" onClick={() => onEdit(l)}><Pencil size={14} /></button>
                            {l.status !== 'ended' && <button type="button" style={icon} aria-label={`New tenant at ${l.propertyName}`} title="New tenant in this space" onClick={() => onReplace(l)}><UserPlus size={14} /></button>}
                          </>
                        )}
                      </td>
                    ),
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager {...paged} />
    </div>
  );
}

// The journal entries behind one month of one row (Charmi, 10/07: "go
// straight to the JOURNAL entry for the detail / itemization"): what posted
// to the row's income accounts that month - for the payer, on a source kept
// here; every posting, on a ledger account row - each entry number opening
// the entry in EntryDetail.
export function monthEntriesQuery(row, monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const from = `${monthKey}-01`;
  const to = `${monthKey}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  if (row.kind === 'account') return [{ account: row.account.code, from, to, limit: 100 }];
  if (!row.lease.customerId) return [];
  return (row.lease.incomeAccounts || []).map((account) => ({ account, party_kind: 'customer', party: row.lease.customerId, from, to, limit: 100 }));
}

function MonthEntries({ row, month, onOpen }) {
  const queries = useMemo(() => monthEntriesQuery(row, month.month), [row, month.month]);
  const [state, setState] = useState({ lines: null, error: '' });
  useEffect(() => {
    let alive = true;
    if (!queries.length) return undefined;
    Promise.all(queries.map((p) => api.searchAccountingLedger(p)))
      .then((answers) => { if (alive) setState({ lines: answers.flatMap((d) => d?.rows || []), error: '' }); })
      .catch((e) => { if (alive) setState({ lines: [], error: e?.message || 'Could not read the entries.' }); });
    return () => { alive = false; };
  }, [queries]);
  if (!queries.length) return <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>No customer code on this source, so no entries can be matched to it.</div>;
  if (state.lines === null) return <SkeletonBlocks count={2} />;
  if (state.error) return <div style={{ fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)' }}>{state.error}</div>;
  const ids = [...new Set(state.lines.filter((l) => l.entry_id).map((l) => l.entry_id))];
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...label, marginBottom: 0, flex: 1 }}>Journal Entries ({state.lines.length})</span>
        {ids.length === 1 && (
          <button type="button" className="secondary-btn" onClick={() => { const l = state.lines.find((x) => x.entry_id === ids[0]); onOpen({ id: l.entry_id, no: l.entry_no }); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', padding: '3px 10px' }}>
            <ExternalLink size={13} /> Open Entry
          </button>
        )}
      </div>
      {!state.lines.length ? <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Nothing posted this month.</div> : (
        <div className="acct-lines-wrap" style={{ maxHeight: 220 }}>
          <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto' }}>
            <thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col">Description</th><th scope="col" className="acct-num">Amount</th></tr></thead>
            <tbody>
              {state.lines.map((l, i) => (
                <tr key={`${l.entry_id || l.entry_no || 'x'}-${i}`}>
                  <td>{l.entry_date ? formatDate(l.entry_date) : '-'}</td>
                  <td>{l.entry_id ? <button type="button" className="acct-drill" onClick={() => onOpen({ id: l.entry_id, no: l.entry_no })} title="Open this journal entry">{l.entry_no || 'Open'}</button> : (l.entry_no || '-')}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 220 }} title={l.description || ''}>{l.description || l.memo || '-'}</td>
                  <td className="acct-num"><Amount value={(l.credit || 0) - (l.debit || 0)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// One month of one row: the figures, the journal entries behind them, and -
// on a source kept here - the deduction and note only a person can know (the
// tenant fixed the AC and took it off the rent).
function MonthDetail({ cell, canEdit, onClose, onSaved }) {
  const { row, month } = cell;
  const ledgerRow = row.kind === 'account';
  const [adjustment, setAdjustment] = useState(month.adjustment || 0);
  const [note, setNote] = useState(month.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [entry, setEntry] = useState(null);           // { id, no } open in EntryDetail
  const s = STATUS[month.status] || STATUS.none;
  const edits = canEdit && row.kind !== 'account';
  const dirty = Number(adjustment || 0) !== Number(month.adjustment || 0) || note !== (month.note || '');
  // Oct 14 (Neil): clicking off a month with unsaved changes (or Escape) asks
  // Keep Editing / Discard Edits instead of closing.
  const [leaving, setLeaving] = useState(false);
  const live = useRef({ entry: false, unsaved: false, leaving: false });
  useEffect(() => { live.current = { entry: !!entry, unsaved: edits && dirty, leaving }; }, [entry, edits, dirty, leaving]);
  const tryClose = useCallback(() => { if (live.current.unsaved) setLeaving(true); else onClose(); }, [onClose]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || live.current.entry) return;
      if (live.current.leaving) setLeaving(false); else tryClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tryClose]);
  const save = () => {
    setBusy(true);
    setError('');
    api.setLeasingMonth(row.lease.id, month.month, { adjustment: Number(adjustment) || 0, note }).then(onSaved).catch((e) => { setError(e?.message || 'Could not save.'); setBusy(false); });
  };
  const fact = (k, v, strong) => (<div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.86rem', padding: '3px 0' }}><span style={{ color: 'var(--text-secondary)' }}>{k}</span><span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: strong ? 700 : 400 }}>{v}</span></div>);
  const title = ledgerRow ? `${row.account.code} ${row.account.title}` : row.lease.propertyName;
  return (
    <div className="modal-overlay" onClick={tryClose} role="presentation">
      <div className="modal-content nx-popup" role="dialog" aria-modal="true" aria-label={`${title}, ${monthName(month.month)}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>{monthName(month.month)}</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{title} · {ledgerRow ? 'From the ledger' : row.lease.tenantName || 'Vacant'}</div>
          </div>
          <button type="button" onClick={tryClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 10, maxHeight: '70vh', overflowY: 'auto' }}>
          {!ledgerRow && <span style={{ justifySelf: 'start', padding: '2px 10px', borderRadius: 999, fontSize: '0.76rem', fontWeight: 700, color: s.fg, background: s.bg, border: `1px solid ${s.fg}` }}>{s.label}</span>}
          <div>
            {!ledgerRow && fact('Expected', money(month.expected))}
            {month.adjustment ? fact('Includes a deduction of', money(month.adjustment)) : null}
            {fact('Received', month.status === 'unknown' ? 'Not read' : money(month.received))}
            {!ledgerRow && fact('Balance', month.status === 'unknown' ? '-' : money(month.balance), true)}
            {month.lateFee ? fact('Late fee under the lease', money(month.lateFee)) : null}
          </div>
          {month.status === 'outside' && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Nothing is expected this month under the lease dates.</div>}
          {month.offCycle && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Not a month this source falls due ({frequencyLabel(row.lease)}).</div>}
          {coverText(month) && <div data-testid="cover-text" style={{ fontSize: '0.78rem', color: 'var(--ok-fg, #15803d)' }}>{coverText(month)}.</div>}
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {ledgerRow ? `Received is everything that posted to account ${row.account.code} this month, less what the sources in this list already count.` : `Received is what posted to account ${row.lease.incomeAccounts.join(', ')} for customer ${row.lease.customerId || '(none set)'} in this month.`}
          </div>
          {month.status !== 'unknown' && <MonthEntries row={row} month={month} onOpen={setEntry} />}
          {edits && (
            <>
              <div>
                <label style={label} htmlFor="lease-m-adj">Agreed Deduction</label>
                <input id="lease-m-adj" type="number" min="0" step="0.01" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} style={{ ...control, width: 160 }} />
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Taken off what is expected this month, such as a repair the tenant paid for.</div>
              </div>
              <div>
                <label style={label} htmlFor="lease-m-note">Note</label>
                <input id="lease-m-note" type="text" value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} style={{ ...control, width: '100%' }} />
              </div>
            </>
          )}
          {!edits && month.note && <div style={{ fontSize: '0.84rem' }}>{month.note}</div>}
          {error && <div style={bad}>{error}</div>}
        </div>
        {leaving ? <LeaveConfirm onKeep={() => setLeaving(false)} onDiscard={onClose} /> : (
          <div className="modal-footer">
            <button type="button" className="secondary-btn" onClick={onClose}>{edits ? 'Cancel' : 'Close'}</button>
            {edits && <button type="button" className="primary-btn" onClick={save} disabled={!dirty || busy}>{busy ? 'Saving...' : 'Save'}</button>}
          </div>
        )}
      </div>
      {entry && <div onClick={(e) => e.stopPropagation()} role="presentation"><EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} /></div>}
    </div>
  );
}

// The inline question a dialog with unsaved changes asks when it is clicked
// off or Escaped (Neil, 10/14) - never window.confirm.
function LeaveConfirm({ onKeep, onDiscard }) {
  const keep = useRef(null);
  useEffect(() => { keep.current?.focus(); }, []);
  return (
    <div className="modal-footer" role="alertdialog" aria-label="Unsaved changes" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={14} style={{ color: '#b45309' }} />You have unsaved changes.</span>
      <span style={{ display: 'inline-flex', gap: 8 }}>
        <button type="button" className="secondary-btn" onClick={onDiscard} style={{ color: 'var(--bad-fg, #dc2626)' }}>Discard Edits</button>
        <button type="button" ref={keep} className="primary-btn" onClick={onKeep}>Keep Editing</button>
      </span>
    </div>
  );
}

function LeaseEditor({ lease, replacing, canDelete, onClose, onSaved, onDirty }) {
  const [l, setL] = useState(() => { const t = termOf(lease); return { incomeType: 'lease', ...lease, termType: t.termType, termMonths: t.termMonths, termLegacy: t.termLegacy, rates: (lease.rates || []).map((r) => ({ ...r })) }; });
  const [initial] = useState(() => JSON.stringify(l));
  const isLease = leaseLike(l.incomeType);
  const isCam = l.incomeType === 'cam';
  const [movedOut, setMovedOut] = useState(() => { const d = new Date(`${lease.leaseStart || iso(new Date())}T00:00:00`); d.setDate(d.getDate() - 1); return iso(d); });
  const [customers, setCustomers] = useState(null);
  const [entities, setEntities] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const set = (p) => setL((x) => ({ ...x, ...p }));
  // Oct 14 (Neil): unsaved changes ask Keep Editing / Discard Edits when the
  // form is clicked off or Escaped.
  const [initialMoved] = useState(movedOut);
  const dirty = JSON.stringify(l) !== initial || (!!replacing && movedOut !== initialMoved);
  const [leaving, setLeaving] = useState(false);
  const live = useRef({ unsaved: false, leaving: false });
  useEffect(() => { live.current = { unsaved: dirty, leaving }; onDirty?.(dirty); }, [dirty, leaving]); // eslint-disable-line react-hooks/exhaustive-deps
  const tryClose = useCallback(() => { if (live.current.unsaved) setLeaving(true); else onClose(); }, [onClose]);
  useEffect(() => {
    api.getLeasingCustomers().then((d) => setCustomers(d?.customers || [])).catch(() => setCustomers([]));
    api.getAccountingLocations().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
  }, []);
  useEffect(() => {
    // A popup open over the panel (a month's detail) takes its own Escape.
    const onKey = (e) => { if (e.key !== 'Escape' || document.querySelector('.modal-overlay')) return; if (live.current.leaving) setLeaving(false); else tryClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tryClose]);
  const vacant = l.status === 'vacant';
  // Oct 7: the first rent starts with the lease unless it was set apart -
  // a lease start moved to January takes its first rent along.
  const setStart = (v) => setL((x) => ({ ...x, leaseStart: v, rates: x.rates.map((r, i) => (i === 0 && (!r.startDate || r.startDate === x.leaseStart) ? { ...r, startDate: v } : r)) }));
  const customMonths = Number(l.termMonths);
  const termOk = l.termType !== 'custom' || (Number.isInteger(customMonths) && customMonths >= 1 && customMonths <= TERM_MAX_MONTHS);
  const freqOk = l.frequency !== 'custom' || (Number(l.frequencyMonths) >= 1 && Number(l.frequencyMonths) <= CUSTOM_MAX_MONTHS);
  const ready = l.propertyName.trim() && (vacant || l.tenantName.trim()) && l.rates.every((r) => r.startDate) && termOk && freqOk;
  const pickTerm = (v) => set({ termType: v, termMonths: v === 'annual' ? 12 : v === 'custom' ? (l.termType === 'custom' ? l.termMonths : '') : null });
  const body = () => ({ ...l, termLegacy: undefined, termType: l.termType || '', termMonths: l.termType === 'annual' ? 12 : l.termType === 'custom' ? customMonths : null,
    frequency: l.frequency || 'monthly', frequencyMonths: l.frequency === 'custom' ? Math.floor(Number(l.frequencyMonths) || 0) : 0,
    incomeType: l.incomeType || 'lease', securityDeposit: Number(l.securityDeposit) || 0, lateFee: Number(l.lateFee) || 0, dueDay: Number(l.dueDay) || 1, graceDays: Number(l.graceDays) || 0,
    incomeAccounts: String(l.incomeAccounts).split(',').map((x) => x.trim()).filter(Boolean),
    rates: l.rates.map((r) => ({ startDate: r.startDate, rent: Number(r.rent) || 0, cam: Number(r.cam) || 0, other: Number(r.other) || 0, note: r.note || '' })) });
  const save = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    const work = replacing ? api.replaceLeasingTenant(replacing.id, { ...body(), movedOut }) : l.id ? api.updateLeasingLease(l.id, body()) : api.createLeasingLease(body());
    work.then(onSaved).catch((e) => { setError(e?.message || 'Could not save the lease.'); setBusy(false); });
  };
  // Oct 15 (Charmi): picking the tenant fills the empty contact fields from
  // the Intacct customer record - never over something typed. A field filled
  // this way says so until it is edited; picking another customer replaces
  // only what the last pick filled.
  const [fromIntacct, setFromIntacct] = useState({});
  const pickCustomer = (c) => {
    const p = { customerId: c.code, tenantName: c.name || c.code };
    const marked = { customerId: true };
    for (const [k, v] of [['phone', c.phone], ['email', c.email], ['mailingAddress', c.address]]) {
      const value = String(v || '').trim();
      if (value && (!String(l[k] ?? '').trim() || fromIntacct[k])) { p[k] = value; marked[k] = true; }
      else if (!value && fromIntacct[k]) p[k] = '';
    }
    set(p);
    setFromIntacct(marked);
  };
  const field = (key, text, props = {}) => (
    <div>
      <label style={label} htmlFor={`lease-${key}`}>{text}</label>
      <input id={`lease-${key}`} type="text" value={l[key] ?? ''} onChange={(e) => { set({ [key]: e.target.value }); if (fromIntacct[key]) setFromIntacct((f) => ({ ...f, [key]: false })); }} style={{ ...control, width: '100%' }} {...props} />
      {fromIntacct[key] && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Filled from Intacct</div>}
    </div>
  );
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 };
  const heading = replacing ? 'New Tenant in This Space' : isCam ? (l.id ? 'Change CAM Charge' : 'New CAM Charge') : !isLease ? (l.id ? 'Change Income Source' : 'New Interest or Loan Payment') : l.id ? 'Change Lease' : 'New Lease';
  const who = isLease ? 'Tenant' : 'Payer';
  // Item 04 (Neil, 10/23: "It should be like the tenant info, lease info, and
  // then comments"): the same fields as before, in three titled groups - no
  // tabs ("there's not that much on there where you need two tabs").
  return (
    <SidePanel label={replacing ? 'New tenant in this space' : isCam ? (l.id ? 'Change CAM charge' : 'New CAM charge') : !isLease ? (l.id ? 'Change income source' : 'New interest or loan payment') : l.id ? 'Change lease' : 'New lease'}
      title={heading}
      caption={replacing ? `${replacing.tenantName}'s lease is ended and kept. This starts the next one.` : l.id ? [lease.propertyName, lease.tenantName].filter(Boolean).join(' - ') : 'The list stays open beside this while you fill it in.'}
      onClose={tryClose}
      footer={leaving ? <LeaveConfirm onKeep={() => setLeaving(false)} onDiscard={onClose} /> : (
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <span>
            {canDelete && l.id && !replacing && (confirm ? (
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: '0.8rem' }}>
                Entered by mistake?
                <button type="button" className="secondary-btn" style={{ color: 'var(--bad-fg, #dc2626)' }} onClick={() => api.deleteLeasingLease(l.id).then(onSaved).catch((e) => setError(e?.message || 'Could not delete.'))}>Delete Lease</button>
                <button type="button" className="secondary-btn" onClick={() => setConfirm(false)}>Keep</button>
              </span>
            ) : <button type="button" style={{ ...icon, fontSize: '0.78rem', gap: 5, alignItems: 'center' }} onClick={() => setConfirm(true)}><Trash2 size={13} /> Delete</button>)}
          </span>
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="primary-btn" onClick={save} disabled={!ready || busy}>{busy ? 'Saving...' : 'Save'}</button>
          </span>
        </div>
      )}>
      <PanelSection title={isLease ? 'Tenant Info' : 'Payer Info'} caption={isLease ? 'Who pays the rent, and how to reach them.' : 'Who pays, and how to reach them.'}>
        <div style={{ display: 'grid', gap: 10 }}>
          {replacing && (
            <div style={{ maxWidth: 240 }}>
              <span style={label}>Last Day of {replacing.tenantName}</span>
              <div id="lease-moved" style={dateBox}><DateField value={movedOut} onChange={(v) => setMovedOut(v || '')} placeholder="MM/DD/YYYY" title={`Last Day of ${replacing.tenantName}`} style={{ width: '100%' }} /></div>
            </div>
          )}
          <div style={grid}>
            <div>
              <label style={label} htmlFor="lease-tenancy">{who} Is</label>
              <select id="lease-tenancy" value={l.tenancy} onChange={(e) => set({ tenancy: e.target.value })} style={{ ...control, width: '100%' }}>
                <option value="external">External</option><option value="internal">Internal - a related company</option>
              </select>
            </div>
          </div>
          {vacant ? (
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>The space is vacant - no {who.toLowerCase()} until the status changes.</p>
          ) : (
            <div style={grid}>
              <CustomerCombo id="lease-tenantName" text={isLease ? 'Tenant Name' : 'Payer Name'} value={l.tenantName || ''} customers={customers} picked={l.customerId}
                onType={(v) => set({ tenantName: v })} onPick={pickCustomer} />
              {field('customerId', 'Intacct Customer Code', { maxLength: 60 })}
              {field('contactName', 'Primary Contact', { maxLength: 200 })}
              {field('phone', 'Phone', { maxLength: 60 })}
              {field('email', 'Email', { maxLength: 200, type: 'email' })}
              {field('mailingAddress', 'Mailing Address', { maxLength: 300 })}
            </div>
          )}
        </div>
      </PanelSection>

      <PanelSection title={isLease ? 'Lease Info' : 'Income Info'} caption="The space, the dates, the rent and where the income posts.">
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="lease-type">Type</label>
              <select id="lease-type" value={l.incomeType || 'lease'} onChange={(e) => set({ incomeType: e.target.value })} style={{ ...control, width: '100%' }}>
                {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            {field('propertyName', isLease ? 'Property or Space' : 'Source', { maxLength: 200, placeholder: isLease ? '910 SECR - Ste 100, San Clemente' : 'Note receivable - Oversite Inv2' })}
            {field('region', 'Region', { maxLength: 120, placeholder: 'Orange County' })}
            {field('landlord', 'Landlord (the tenant pays)', { maxLength: 200 })}
            <div>
              <label style={label} htmlFor="lease-status">Status</label>
              <select id="lease-status" value={l.status} onChange={(e) => set({ status: e.target.value })} style={{ ...control, width: '100%' }}>
                {Object.entries(LEASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>

          <div style={grid}>
            <div>
              <span style={label}>{isLease ? 'Lease Start' : 'Starts'}</span>
              <div id="lease-leaseStart" style={dateBox}><DateField value={l.leaseStart || ''} onChange={(v) => setStart(v || '')} placeholder="MM/DD/YYYY" title={isLease ? 'Lease Start' : 'Starts'} style={{ width: '100%' }} /></div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>When the tenant started paying. Expected rent counts from here.</div>
            </div>
            <div>
              <span style={label}>{isLease ? 'Lease End' : 'Ends'}</span>
              <div id="lease-leaseEnd" style={dateBox}><DateField value={l.leaseEnd || ''} onChange={(v) => set({ leaseEnd: v || '' })} placeholder="MM/DD/YYYY" title={isLease ? 'Lease End' : 'Ends'} style={{ width: '100%' }} /></div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Leave empty for month to month.</div>
            </div>
            <div>
              <label style={label} htmlFor="lease-termType">Lease Term</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select id="lease-termType" value={l.termType || ''} onChange={(e) => pickTerm(e.target.value)} style={{ ...control, flex: 1, minWidth: 0 }}>
                  {!l.termType && <option value="" disabled>Pick a Term</option>}
                  {TERM_OPTIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {l.termType === 'custom' && (
                  <input id="lease-termMonths" type="number" inputMode="numeric" min={1} max={TERM_MAX_MONTHS} step={1} value={l.termMonths ?? ''} placeholder="Months" aria-label="Lease Term in Months"
                    onChange={(e) => set({ termMonths: e.target.value.replace(/\D/g, '') })} style={{ ...control, width: 90 }} />
                )}
              </div>
              {l.termType === 'custom' && !termOk && <div style={{ fontSize: '0.7rem', color: 'var(--bad-fg, #dc2626)', marginTop: 3 }}>A whole number of months, 1 to {TERM_MAX_MONTHS}.</div>}
              {!l.termType && l.termLegacy && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }} data-testid="lease-term-legacy">Saved as "{l.termLegacy}" - pick a term.</div>}
            </div>
            <div>
              <label style={label} htmlFor="lease-frequency">Frequency</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select id="lease-frequency" value={l.frequency || 'monthly'} onChange={(e) => set({ frequency: e.target.value, frequencyMonths: e.target.value === 'custom' ? (Number(l.frequencyMonths) >= 1 ? l.frequencyMonths : 2) : 0 })} style={{ ...control, flex: 1, minWidth: 0 }}>
                  {Object.entries(FREQUENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {l.frequency === 'custom' && (
                  <input id="lease-every" type="number" inputMode="numeric" min={1} max={CUSTOM_MAX_MONTHS} step={1} value={l.frequencyMonths || ''} placeholder="Months" aria-label="Every (Months)"
                    onChange={(e) => set({ frequencyMonths: e.target.value === '' ? '' : Math.floor(Number(e.target.value)) })} style={{ ...control, width: 90 }} />
                )}
              </div>
              <div style={{ fontSize: '0.7rem', color: freqOk ? 'var(--text-muted)' : 'var(--bad-fg, #dc2626)', marginTop: 3 }}>
                {!freqOk ? `Enter 1 to ${CUSTOM_MAX_MONTHS} months.` : stepMonths(l) > 1 ? `Falls due every ${stepMonths(l)} months from the start month; the rent below is the amount each time.` : 'Due every month.'}
              </div>
            </div>
            {field('securityDeposit', 'Security Deposit', { type: 'number', min: 0, step: '0.01' })}
            {field('lateFee', 'Late Fee', { type: 'number', min: 0, step: '0.01' })}
            {field('dueDay', 'Rent Due on Day', { type: 'number', min: 1, max: 28 })}
            {field('graceDays', 'Late After (days past due)', { type: 'number', min: 0, max: 60 })}
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={label}>Rent - each change is a new line, in force until the next one</span>
              <button type="button" className="secondary-btn" onClick={() => set({ rates: [...l.rates, { startDate: '', rent: l.rates[l.rates.length - 1]?.rent || 0, cam: l.rates[l.rates.length - 1]?.cam || 0, other: 0, note: '' }] })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', padding: '3px 10px' }}><Plus size={12} /> Add Rent Change</button>
            </div>
            {/* Oct 15 (Neil): a normal table - the labels sit over their inputs. */}
            <div style={{ overflowX: 'auto', marginTop: 4 }}>
              {l.rates.length > 0 && (
                <table aria-label="Rent Changes" style={{ width: '100%', minWidth: 620, borderCollapse: 'separate', borderSpacing: '6px 4px', tableLayout: 'fixed', margin: '0 -6px' }}>
                  <colgroup>
                    <col style={{ width: 150 }} /><col style={{ width: '16%' }} /><col style={{ width: '16%' }} /><col style={{ width: '16%' }} /><col /><col style={{ width: 30 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {[['Effective Date', 'The date this rent starts'], ['Rent', ''], ['CAM', 'Common area maintenance'], ['Other', ''], ['Note', '']].map(([text, hint]) => (
                        <th key={text} scope="col" title={hint || undefined} style={{ ...label, display: 'table-cell', textAlign: 'left', verticalAlign: 'bottom', padding: 0, margin: 0 }}>{text}</th>
                      ))}
                      <th scope="col" aria-label="Remove" style={{ padding: 0 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {l.rates.map((r, i) => (
                      <tr key={i}>
                        <td style={{ padding: 0 }}><div style={dateBox}><DateField value={r.startDate} onChange={(v) => set({ rates: l.rates.map((x, k) => (k === i ? { ...x, startDate: v || '' } : x)) })} placeholder="MM/DD/YYYY" title={`Rent ${i + 1} starts`} style={{ width: '100%' }} /></div></td>
                        {[['rent', 'Rent'], ['cam', 'CAM'], ['other', 'Other']].map(([k, text]) => (
                          <td key={k} style={{ padding: 0 }}><input type="number" min="0" step="0.01" value={r[k]} aria-label={`${text} of rent ${i + 1}`} onChange={(e) => set({ rates: l.rates.map((x, n) => (n === i ? { ...x, [k]: e.target.value } : x)) })} style={{ ...control, width: '100%' }} /></td>
                        ))}
                        <td style={{ padding: 0 }}><input type="text" value={r.note || ''} maxLength={200} placeholder="Such as Renewal" aria-label={`Note of rent ${i + 1}`} onChange={(e) => set({ rates: l.rates.map((x, k) => (k === i ? { ...x, note: e.target.value } : x)) })} style={{ ...control, width: '100%' }} /></td>
                        <td style={{ padding: 0 }}><button type="button" style={icon} aria-label={`Remove rent ${i + 1}`} onClick={() => set({ rates: l.rates.filter((_, k) => k !== i) })}><Trash2 size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!l.rates.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>No rent yet. Without one, nothing is expected from this lease.</div>}
            </div>
          </div>

          <div style={grid}>
            <div>
              <span style={label}>Entity the Income Posts To</span>
              <EntityPicker entities={entities} value={l.entityCode || ''} onChange={(code) => set({ entityCode: code })} noneLabel="Not Set"
                ariaLabel="Entity the Income Posts To" active={false} style={{ width: '100%', maxWidth: 'none' }} />
            </div>
            <div>
              <label style={label} htmlFor="lease-accounts">{isLease ? 'Rental Income Accounts' : 'Income Accounts'}</label>
              <input id="lease-accounts" type="text" value={Array.isArray(l.incomeAccounts) ? l.incomeAccounts.join(', ') : l.incomeAccounts} onChange={(e) => set({ incomeAccounts: e.target.value })} style={{ ...control, width: '100%' }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>GL codes, separated by commas. What posts here for the tenant counts as rent received.</div>
            </div>
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Comments" caption="Anything the team should know about this lease.">
        <label style={label} htmlFor="lease-notes">Notes</label>
        <textarea id="lease-notes" rows={4} value={l.notes ?? ''} maxLength={1000} onChange={(e) => set({ notes: e.target.value })} style={{ ...control, width: '100%', height: 'auto', minHeight: 84, padding: '6px 8px', resize: 'vertical', fontFamily: 'inherit' }} />
      </PanelSection>
      {error && <div style={bad}>{error}</div>}
    </SidePanel>
  );
}

// The tenant (or payer) on a lease (Priyanka, 10/14: "give a dropdown for
// lease tenant"): a searchable dropdown of the Intacct customers - code left
// of the name - that still takes a typed name for someone not in Intacct.
function CustomerCombo({ id, text, value, customers, picked, onType, onPick }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blur = useRef(null);
  useEffect(() => () => clearTimeout(blur.current), []);
  const options = useMemo(() => {
    const s = value.trim().toLowerCase();
    const list = customers || [];
    const hit = s && !list.some((c) => c.code === picked && (c.name || '').toLowerCase() === s)
      ? list.filter((c) => c.code.toLowerCase().includes(s) || (c.name || '').toLowerCase().includes(s))
      : list;
    return hit.slice(0, 50);
  }, [customers, value, picked]);
  const choose = (c) => { onPick(c); setOpen(false); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); choose(options[active]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); e.nativeEvent?.stopImmediatePropagation?.(); setOpen(false); }
  };
  return (
    <div style={{ position: 'relative' }}>
      <label style={label} htmlFor={id}>{text}</label>
      <div style={{ position: 'relative' }}>
        <input id={id} type="text" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off" maxLength={200} value={value}
          placeholder={customers ? 'Pick an Intacct customer or type a name' : 'Loading customers...'}
          onChange={(e) => { onType(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
          onBlur={() => { blur.current = setTimeout(() => setOpen(false), 150); }} onKeyDown={onKey}
          style={{ ...control, width: '100%', paddingRight: 26 }} />
        <ChevronDown size={14} aria-hidden="true" style={{ position: 'absolute', right: 8, top: 9, color: 'var(--text-muted)', pointerEvents: 'none' }} />
      </div>
      {open && customers && (
        <div id={`${id}-list`} role="listbox" aria-label="Customers" onMouseDown={(e) => e.preventDefault()}
          style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 20, marginTop: 2, maxHeight: 240, overflowY: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 4, display: 'grid', gap: 1 }}>
          {options.map((c, i) => (
            <button key={c.code} type="button" role="option" aria-selected={c.code === picked} onClick={() => choose(c)} onMouseEnter={() => setActive(i)}
              style={{ display: 'flex', gap: 8, border: 'none', background: i === active ? 'var(--wk-brand-tint, #e8ecfd)' : 'none', borderRadius: 6, padding: '4px 8px', font: 'inherit', fontSize: '0.8rem', cursor: 'pointer', textAlign: 'left', color: c.active === false ? 'var(--text-muted)' : 'var(--text-primary)' }}>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{c.code}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.code}</span>
              {c.active === false && <span style={chipStyle('bad')}>Inactive</span>}
            </button>
          ))}
          {!options.length && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', padding: 6 }}>{customers.length ? 'No Intacct customer matches - the name typed is kept.' : 'No Intacct customers to pick from - type the name.'}</div>}
        </div>
      )}
    </div>
  );
}
