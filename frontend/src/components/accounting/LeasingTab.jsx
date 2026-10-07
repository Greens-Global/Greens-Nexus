import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, Database, ExternalLink, FolderUp, Home, Landmark, Mail, Pencil, Plus, RefreshCw, Search, Tags, Trash2, UserPlus, Users, X } from 'lucide-react';
import { api } from '../../api';
import Amount, { formatAmount } from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { CustomizeButton, DENSITIES, EntitiesPicker, ExportMenu, PopoverPanel, control, usePopover } from './reportControls';
import { downloadBlob, iso } from './reportModel';
import { useAccountingPrefs } from './prefs';
import { linesFile } from './linesExport';
import SendReportDialog from './SendReportDialog';
import LeasingFromLedger from './LeasingFromLedger';
import AddMenu from './AddMenu';
import EntryDetail from './EntryDetail';

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

const SECTIONS = [{ key: 'roll', label: 'Income Roll' }, { key: 'outstanding', label: 'Outstanding' }, { key: 'tenants', label: 'Payers' }];
export const TYPES = [{ key: 'lease', label: 'Lease' }, { key: 'interest', label: 'Interest' }, { key: 'loan_payment', label: 'Loan Payment' }, { key: 'other', label: 'Other' }];
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
  outside: { label: 'Outside the Lease', fg: '#6d28d9', bg: 'rgba(109,40,217,0.10)' },
  income: { label: 'Received', fg: 'var(--text-primary)', bg: 'transparent' },
};
const LEASE_STATUS = { active: 'Active', ended: 'Ended', vacant: 'Vacant' };
// Period presets within the year (Oct 6): [first month index, last month index].
const PERIODS = [
  { key: 'year', label: 'Full Year' }, { key: 'ytd', label: 'Year-to-Date' }, { key: 'q1', label: 'Q1' }, { key: 'q2', label: 'Q2' }, { key: 'q3', label: 'Q3' }, { key: 'q4', label: 'Q4' },
  { key: 'month', label: 'This Month' }, { key: 'custom', label: 'Custom Months' },
];
function periodMonths(key, year, custom = [0, 11], today = new Date()) {
  const thisYear = today.getFullYear() === year;
  const m = today.getMonth();
  if (key === 'ytd') return [0, thisYear ? m : 11];
  if (/^q[1-4]$/.test(key)) { const q = Number(key[1]) - 1; return [q * 3, q * 3 + 2]; }
  if (key === 'month') return thisYear ? [m, m] : [11, 11];
  if (key === 'custom') return [Math.min(custom[0], custom[1]), Math.max(custom[0], custom[1])];
  return [0, 11];
}

// Figures in text (titles, the reminder email) read as the screen shows them.
const money = formatAmount;
const whole = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const icon = { border: 'none', background: 'none', padding: 5, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' };
const bad = { border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' };
const chipStyle = (tone) => ({ display: 'inline-block', marginLeft: 6, padding: '0 7px', borderRadius: 999, fontSize: '0.66rem', fontWeight: 700, whiteSpace: 'nowrap', verticalAlign: 'middle',
  color: tone === 'bad' ? 'var(--bad-fg, #dc2626)' : 'var(--text-secondary)', background: tone === 'bad' ? 'rgba(220,38,38,0.10)' : 'var(--bg-secondary)', border: '1px solid var(--border-color)' });
const monthName = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
// Oct 7: a new source starts on the 1st of this month, and its first rent
// with it - not today (a lease typed in on the 2nd expected 30/31 of a month
// and nothing before it).
const firstOfMonth = () => `${iso(new Date()).slice(0, 7)}-01`;
const blank = (incomeType = 'lease') => ({ incomeType, propertyName: '', region: '', tenancy: 'external', landlord: '', entityCode: '', incomeAccounts: incomeType === 'lease' ? ['41101'] : [], customerId: '', tenantName: '', contactName: '', phone: '', email: '', mailingAddress: '', leaseStart: firstOfMonth(), leaseEnd: '', securityDeposit: 0, leaseTerms: '', lateFee: 0, dueDay: 1, graceDays: 5, status: 'active', notes: '', rates: [{ startDate: firstOfMonth(), rent: 0, cam: 0, other: 0, note: '' }] });
/** The name the tenant goes by: Intacct's when the customer record came with the row. */
const tenantOf = (r) => (r.kind === 'account' ? 'From the ledger' : r.lease.status === 'vacant' ? 'Vacant' : r.customer?.name || r.lease.tenantName || r.lease.customerId || '-');
/** A month that counts toward the balance: in force, past or present, read, and inside the lease. */
const counts = (c) => c.inForce && c.status !== 'upcoming' && c.status !== 'unknown' && c.status !== 'outside';
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

/** Chips for a row: Expired (an ended lease) and Inactive (the customer is inactive in Intacct). */
function StandingChips({ row }) {
  return (
    <>
      {row.expired && <span style={chipStyle()} title="The lease has ended">Expired</span>}
      {row.customerActive === false && <span style={chipStyle('bad')} title="The customer is inactive in Intacct">Inactive</span>}
      {row.outsideLease?.received > 0.005 && (
        <span style={chipStyle('bad')} title={`${money(row.outsideLease.received)} posted in ${row.outsideLease.months.map(monthName).join(', ')}, when the lease is not in force - shown, not counted. Check the Lease Start and End.`}>
          Posted Outside Lease
        </span>
      )}
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
  const [editing, setEditing] = useState(null);       // { lease, replacing? }
  const [cell, setCell] = useState(null);             // { row, month }
  const [fromLedger, setFromLedger] = useState(false); // Set Up From the Ledger (Oct 2)
  const [sending, setSending] = useState(null);       // email | egnyte
  const [sent, setSent] = useState(null);             // { text, url }
  const [exporting, setExporting] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(null);
  const seq = useRef(0);
  const showInactive = !!prefs.mriShowInactive;
  const showExpired = !!prefs.mriShowExpired;
  const density = DENSITIES.some((d) => d.key === prefs.density) ? prefs.density : 'compact';
  const py = DENSITIES.find((d) => d.key === density)?.py || '5px';
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

  const span = periodMonths(period, year, custom);
  const accountRows = useMemo(() => ledgerIncomeRows(ledger?.rows, roll?.rows, year), [ledger, roll, year]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const picked = new Set(tenants);
    const kinds = new Set(types);
    const kept = (roll?.rows || []).filter((r) => {
      const l = r.lease;
      if (kinds.size && !kinds.has(typeOf(r))) return false;
      if (picked.size && !picked.has(l.customerId)) return false;
      // A text filter finds expired leases and inactive customers too (marked); otherwise Customize decides.
      if (s) return [l.propertyName, l.tenantName, r.customer?.name, l.landlord, l.region, l.customerId, l.teamNote?.text, TYPE_LABEL[typeOf(r)]].some((v) => (v || '').toLowerCase().includes(s));
      if (!showExpired && r.expired && !picked.has(l.customerId)) return false;
      if (!showInactive && r.customerActive === false && !picked.has(l.customerId)) return false;
      return true;
    });
    // The ledger's income account rows have no payer: picking payers leaves them out.
    const ledgerRows = picked.size ? [] : accountRows.filter((r) => (!kinds.size || kinds.has(r.type))
      && (!s || [r.account.code, r.account.title, TYPE_LABEL[r.type]].some((v) => (v || '').toLowerCase().includes(s))));
    return [...kept, ...ledgerRows];
  }, [roll, accountRows, q, tenants, types, showExpired, showInactive]);
  const sources = useMemo(() => rows.filter((r) => r.kind !== 'account'), [rows]);
  const figures = useMemo(() => rows.reduce((t, r) => {
    const f = rowFigures(r, span);
    return { expected: t.expected + f.expected, received: t.received + f.received, balance: t.balance + f.balance };
  }, { expected: 0, received: 0, balance: 0 }), [rows, span]);
  const outsideTotal = sources.reduce((s, r) => s + (r.outsideLease?.received || 0), 0);
  const hidden = (roll?.rows || []).filter((r) => (r.expired && !showExpired) || (r.customerActive === false && !showInactive)).length;
  const customers = useMemo(() => {
    const by = new Map();
    (roll?.rows || []).forEach((r) => { if (r.lease.customerId && !by.has(r.lease.customerId)) by.set(r.lease.customerId, { code: r.lease.customerId, name: tenantOf(r), off: r.expired || r.customerActive === false }); });
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
  }, [roll]);
  const sum = roll?.summary || {};
  const thisMonth = iso(new Date()).slice(0, 7);
  const behind = sources.filter((r) => r.monthsBehind);
  const updateNote = (id, note) => setRoll((d) => d && { ...d, rows: d.rows.map((r) => (r.lease.id === id ? { ...r, lease: { ...r.lease, teamNote: note } } : r)) });

  // What the Export menu writes: the section on screen, as on screen.
  const entityLabel = !entities.length ? (locations.limited ? 'All my entities' : 'All entities') : entities.length === 1 ? (() => { const e = locations.entities.find((x) => x.code === entities[0]); return e?.name ? `${e.name} (${e.code})` : entities[0]; })() : `${entities.length} entities`;
  const periodLabel = `${PERIODS.find((p) => p.key === period)?.label || 'Full Year'} ${year} (${MONTHS[span[0]]}${span[1] !== span[0] ? ` - ${MONTHS[span[1]]}` : ''})`;
  const buildTable = () => {
    const title = section === 'outstanding' ? 'Income Outstanding' : section === 'tenants' ? 'Payers' : 'Monthly Recurring Income';
    const subtitle = `${entityLabel} · ${periodLabel}${types.length ? ` · ${types.map((t) => TYPE_LABEL[t]).join(', ')}` : ''}${tenants.length ? ` · ${tenants.length} ${tenants.length === 1 ? 'payer' : 'payers'}` : ''}${q.trim() ? ` · "${q.trim()}"` : ''}`;
    const standing = (r) => [r.expired ? 'Expired' : '', r.customerActive === false ? 'Inactive' : '', r.outsideLease?.received > 0.005 ? 'Posted Outside Lease' : ''].filter(Boolean).join(', ');
    if (section === 'outstanding') {
      const list = [...behind].sort((a, b) => b.owed - a.owed);
      return { title, subtitle, name: `${title} - ${year}`, columns: [{ label: 'Property or Source', width: 220 }, { label: 'Type', width: 90 }, { label: 'Payer', width: 200 }, { label: 'Months Behind', width: 160 }, { label: 'Balance Due', num: true, width: 100 }, { label: 'Late Fees', num: true, width: 90 }, { label: 'Contact', width: 200 }],
        rows: list.map((r) => [r.lease.propertyName, TYPE_LABEL[typeOf(r)], tenantOf(r), `${r.monthsBehind} - ${r.months.filter((c) => ['late', 'short', 'unpaid'].includes(c.status)).map((c) => MONTHS[Number(c.month.slice(5, 7)) - 1]).join(', ')}`, r.owed, r.lateFees, [r.lease.contactName, r.lease.phone, r.lease.email].filter(Boolean).join(' · ')]),
        totals: [`Total Outstanding - ${list.length}`, '', '', '', list.reduce((s, r) => s + r.owed, 0), list.reduce((s, r) => s + r.lateFees, 0), ''] };
    }
    if (section === 'tenants') {
      return { title, subtitle, name: `${title} - ${year}`, columns: [{ label: 'Property or Source', width: 220 }, { label: 'Type', width: 90 }, { label: 'Payer', width: 200 }, { label: 'Customer', width: 80 }, { label: 'Landlord', width: 160 }, { label: 'Start', width: 90 }, { label: 'End', width: 90 }, { label: 'Amount', num: true, width: 90 }, { label: 'CAM', num: true, width: 80 }, { label: 'Deposit', num: true, width: 90 }, { label: 'Status', width: 120 }],
        rows: sources.map((r) => { const l = r.lease; const rate = l.rates[l.rates.length - 1]; return [l.propertyName, TYPE_LABEL[typeOf(r)], tenantOf(r), l.customerId, l.landlord, l.leaseStart ? formatDate(l.leaseStart) : '', l.leaseEnd ? formatDate(l.leaseEnd) : 'Month to Month', rate ? rate.rent : 0, rate ? rate.cam : 0, l.securityDeposit || 0, [LEASE_STATUS[l.status] || l.status, standing(r)].filter(Boolean).join(', ')]; }),
        totals: null };
    }
    const shownMonths = MONTHS.slice(span[0], span[1] + 1);
    const monthTotals = shownMonths.map((_m, i) => rows.reduce((s, r) => { const c = r.months[span[0] + i]; return s + (c && counts(c) ? c.received : 0); }, 0));
    return { title, subtitle, name: `${title} - ${periodLabel}`,
      columns: [{ label: 'Property or Source', width: 200 }, { label: 'Type', width: 90 }, { label: 'Payer', width: 170 }, { label: 'Status', width: 80 }, ...shownMonths.map((m) => ({ label: m, num: true, width: 70 })), { label: 'Total', num: true, width: 85 }, { label: 'Balance', num: true, width: 85 }, { label: 'Notes', width: 180 }],
      rows: rows.map((r) => { const f = rowFigures(r, span); return [rowName(r), TYPE_LABEL[typeOf(r)], tenantOf(r), r.kind === 'account' ? '' : standing(r), ...r.months.slice(span[0], span[1] + 1).map((c) => (counts(c) ? c.received : 0)), f.received, f.balance, r.kind === 'account' ? '' : r.lease.teamNote?.text || '']; }),
      totals: ['Total Received', '', '', '', ...monthTotals, figures.received, figures.balance, ''] };
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
      .then((d) => { setSynced(d); reload(); })
      .catch((e) => setError(e?.message || 'Could not sync with the ledger.'))
      .finally(() => setSyncing(false));
  };
  const linked = [...(roll?.linked || []), ...(synced?.linked || [])];
  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 12px' };
  const noun = (n) => `${n} ${n === 1 ? 'source' : 'sources'}`;

  return (
    <AsyncSection loading={roll === null} skeleton={<SkeletonBlocks count={3} />}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
            {SECTIONS.map((s) => (
              <button key={s.key} type="button" onClick={() => setSection(s.key)} aria-pressed={section === s.key}
                style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: section === s.key ? 700 : 500, border: `1px solid ${section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: section === s.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
                {s.label}{s.key === 'outstanding' && sum.behind ? ` (${sum.behind})` : ''}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Period" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <button type="button" style={icon} aria-label="Previous year" onClick={() => setYear((y) => y - 1)}><ChevronLeft size={16} /></button>
            <strong style={{ fontSize: '0.86rem', minWidth: 40, textAlign: 'center' }}>{year}</strong>
            <button type="button" style={icon} aria-label="Next year" disabled={year >= new Date().getFullYear() + 1} onClick={() => setYear((y) => y + 1)}><ChevronRight size={16} /></button>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Months" style={control}>
              {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            {period === 'custom' && (
              <>
                <select value={custom[0]} onChange={(e) => setCustom(([, b]) => [Number(e.target.value), Math.max(b, Number(e.target.value))])} aria-label="From month" style={control}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>to</span>
                <select value={custom[1]} onChange={(e) => setCustom(([a]) => [Math.min(a, Number(e.target.value)), Number(e.target.value)])} aria-label="To month" style={control}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
              </>
            )}
          </div>
          <EntitiesPicker entities={locations.entities} value={entities} onChange={setEntities} limited={locations.limited} showHistorical={!!prefs.showHistoricalEntities} />
          <MultiPicker label="Type filter" allLabel="All Types" noun={['type', 'types']} Icon={Tags} options={TYPES.map((t) => ({ code: t.key, name: t.label }))} value={types} onChange={setTypes} showCodes={false} />
          <MultiPicker label="Payer filter" allLabel="All Payers" noun={['payer', 'payers']} Icon={Users} options={customers} value={tenants} onChange={setTenants}
            find="Find a payer by name or customer code" empty="No payer has a customer code yet." />
          <div style={{ position: 'relative', flex: '0 1 220px' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by property, payer or account" aria-label="Filter by property, payer or account" style={{ ...control, width: '100%', paddingLeft: 28 }} />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <CustomizeButton density={density} onDensity={(d) => setPrefs({ density: d })} showHistorical={!!prefs.showHistoricalEntities} onShowHistorical={(v) => setPrefs({ showHistoricalEntities: v })}
              active={showInactive || showExpired}>
              {[['mriShowInactive', showInactive, 'Show Inactive', 'Sources whose customer is inactive in Intacct.'], ['mriShowExpired', showExpired, 'Show Expired', 'Leases that have ended. The text filter finds both either way.']].map(([k, on, text, hint]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={(e) => setPrefs({ [k]: e.target.checked })} style={{ marginTop: 2 }} />
                  <span>{text}<span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>{hint}</span></span>
                </label>
              ))}
            </CustomizeButton>
            <ExportMenu disabled={!roll} items={[
              { key: 'excel', label: 'Excel', hint: 'As on screen, live totals', onPick: () => exportAs('excel'), busy: exporting === 'excel' },
              { key: 'csv', label: 'CSV', hint: 'Plain values, one row per source', onPick: () => exportAs('csv'), busy: exporting === 'csv' },
              { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: exporting === 'pdf' },
              { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, file attached', Icon: Mail, onPick: () => setSending('email') },
              { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setSending('egnyte') },
            ]} />
            {canEdit && (
              <button type="button" className="secondary-btn" onClick={syncNow} disabled={syncing} title="Link every lease to its Intacct customer and add the leases of new tenants" style={btn}>
                <RefreshCw size={14} className={syncing ? 'spin' : undefined} /> {syncing ? 'Syncing...' : 'Sync Now'}
              </button>
            )}
            {canEdit && (
              <AddMenu ariaLabel="Add an income source" items={[
                { key: 'lease', label: 'New Lease', hint: 'A tenant, the dates and the rent', Icon: Home, onPick: () => setEditing({ lease: blank('lease') }) },
                { key: 'interest', label: 'New Interest or Loan Payment', hint: 'Who pays, how much, from when', Icon: Landmark, onPick: () => setEditing({ lease: blank('interest') }) },
                { key: 'ledger', label: 'Set Up From the Ledger', hint: 'A lease for every customer who posted rent in the last twelve months', Icon: Database, onPick: () => setFromLedger(true) },
              ]} />
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums', padding: '0 4px' }}>
          <span>Expected <strong><Amount value={figures.expected} /></strong></span>
          <span>Received <strong><Amount value={figures.received} /></strong></span>
          <span title="Expected less received. A credit (in parentheses) is a prepayment.">Balance <strong style={{ color: figures.balance > 0.005 ? 'var(--bad-fg, #dc2626)' : figures.balance < -0.005 ? 'var(--ok-fg, #15803d)' : undefined }}><Amount value={figures.balance} /></strong>{figures.balance < -0.005 ? <span style={{ color: 'var(--ok-fg, #15803d)' }}> Credit</span> : null}</span>
          {outsideTotal > 0.005 && <span style={{ color: '#6d28d9' }} title="Posted in months a lease is not in force (before its start or after its end). Shown in the grid, not counted. Check the Lease Start.">Outside the Lease <strong><Amount value={outsideTotal} /></strong></span>}
          <span style={{ color: 'var(--text-muted)' }}>{periodLabel} · {noun(rows.length)}{hidden && !q.trim() ? ` · ${hidden} expired or inactive hidden (Customize)` : ''}</span>
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
            {section === 'roll' && <RentRoll rows={rows} span={span} figures={figures} year={year} thisMonth={thisMonth} py={py} onCell={(row, month) => setCell({ row, month })} onLease={(l) => setEditing({ lease: l })} any={(roll?.rows || []).length + accountRows.length > 0} canEdit={canEdit} onNote={updateNote} />}
            {section === 'outstanding' && <Outstanding rows={behind} year={year} py={py} />}
            {section === 'tenants' && <Tenants rows={sources} py={py} canEdit={canEdit} onEdit={(l) => setEditing({ lease: l })} onReplace={(l) => setEditing({ lease: { ...blank(l.incomeType || 'lease'), propertyName: l.propertyName, region: l.region, tenancy: l.tenancy, landlord: l.landlord, entityCode: l.entityCode, incomeAccounts: l.incomeAccounts, lateFee: l.lateFee, dueDay: l.dueDay, graceDays: l.graceDays }, replacing: l })} />}
          </div>
        )}
      </div>
      {cell && <MonthDetail cell={cell} canEdit={canEdit} onClose={() => setCell(null)} onSaved={() => { setCell(null); reload(); }} />}
      {editing && <LeaseEditor lease={editing.lease} replacing={editing.replacing} canDelete={canDelete} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {fromLedger && <LeasingFromLedger onClose={() => setFromLedger(false)} onCreated={() => { setFromLedger(false); reload(); }} />}
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
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
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
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
              {showCodes && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{o.code}</span>}
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
          <strong style={{ fontSize: '0.9rem' }}>{c.name || name}</strong>
          <span className="acct-code" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{code}</span>
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
function NoteCell({ lease, canEdit, onSaved }) {
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
  const body = note.text
    ? <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note.text}<span style={{ display: 'block', fontSize: '0.66rem', color: 'var(--text-muted)' }}>{who}</span></span>
    : <span style={{ color: 'var(--text-muted)' }}>{canEdit ? 'Add a note' : '-'}</span>;
  if (!canEdit) return <span title={note.text ? `${note.text} - ${who}` : undefined}>{body}</span>;
  return (
    <button type="button" onClick={() => { setText(note.text || ''); setEditing(true); }} aria-label={note.text ? `Change the note on ${lease.propertyName}` : `Add a note on ${lease.propertyName}`} title={note.text ? `${note.text} - ${who}` : 'Add a note'}
      style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: '0.76rem', color: 'var(--text-primary)', cursor: 'text', textAlign: 'left', width: '100%', minWidth: 0 }}>
      {body}
    </button>
  );
}

function RentRoll({ rows, span, figures, year, thisMonth, py, onCell, onLease, any, canEdit, onNote }) {
  if (!rows.length) {
    return <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>{any ? 'Nothing matches these filters.' : `No leases yet.${canEdit ? ' + Add > Set Up From the Ledger proposes one for every customer who posted rent in the last twelve months, or + Add > New Lease: the tenant, the dates and the rent.' : ''}`}</div>;
  }
  const [from, to] = span;
  const idx = MONTHS.map((_m, i) => i).slice(from, to + 1);
  const monthTotal = (i) => rows.reduce((s, r) => { const c = r.months[i]; return s + (c && counts(c) ? c.received : 0); }, 0);
  const monthExpected = (i) => rows.reduce((s, r) => { const c = r.months[i]; return s + (c && counts(c) ? c.expected : 0); }, 0);
  return (
    <div style={{ ...card, padding: 10 }}>
      <div className="acct-lines-wrap" style={{ maxHeight: '74vh' }}>
        <table className="acct-lines acct-roll" style={{ width: '100%', tableLayout: 'auto', '--acct-row-py': py }}>
          <thead>
            <tr>
              <th scope="col" style={{ position: 'sticky', left: 0, zIndex: 5, minWidth: 250 }}>Property or Source</th>
              <th scope="col">Type</th>
              <th scope="col" className="acct-num">Amount</th>
              {idx.map((i) => <th key={MONTHS[i]} scope="col" className="acct-num" style={`${year}-${String(i + 1).padStart(2, '0')}` === thisMonth ? { color: 'var(--wk-brand, #2b45e1)' } : undefined}>{MONTHS[i]}</th>)}
              <th scope="col" className="acct-num" title="Received in the months shown">Total</th>
              <th scope="col" className="acct-num" title="Expected less received in the months shown. A credit (in parentheses) is a prepayment.">Balance</th>
              <th scope="col" style={{ minWidth: 180 }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const f = rowFigures(r, span);
              const name = rowName(r);
              if (r.kind === 'account') {
                return (
                  <tr key={r.key}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, whiteSpace: 'normal', minWidth: 250 }}>
                      <span style={{ fontWeight: 600 }}><span className="acct-code">{r.account.code}</span>{r.account.title}</span>
                      <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>From the ledger - every posting to this account, no schedule</div>
                    </td>
                    <td><TypeChip type={r.type} /></td>
                    <td className="acct-num" style={{ color: 'var(--text-muted)' }}>-</td>
                    {idx.map((i) => {
                      const c = r.months[i];
                      if (!c || !c.inForce) return <td key={i} className="acct-num" style={{ color: 'var(--text-muted)' }}>-</td>;
                      return (
                        <td key={c.month} className="acct-num" style={{ padding: 2 }}>
                          <button type="button" onClick={() => onCell(r, c)} aria-label={`${name}, ${monthName(c.month)}: received ${money(c.received)}`} title={`Received ${money(c.received)} - click for the entries`}
                            style={{ width: '100%', border: 'none', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontVariantNumeric: 'tabular-nums', padding: '3px 6px', textAlign: 'right', background: 'transparent', color: 'var(--text-primary)' }}>
                            {whole(c.received)}
                          </button>
                        </td>
                      );
                    })}
                    <td className="acct-num" style={{ fontWeight: 700 }}>{f.received ? <Amount value={f.received} /> : '-'}</td>
                    <td className="acct-num" style={{ color: 'var(--text-muted)' }} title="No schedule, so nothing is expected">-</td>
                    <td style={{ color: 'var(--text-muted)' }}>-</td>
                  </tr>
                );
              }
              const l = r.lease;
              const rate = [...l.rates].reverse().find((x) => x.startDate <= `${thisMonth}-31`) || l.rates[0];
              return (
                <tr key={l.id} style={r.expired || r.customerActive === false ? { color: 'var(--text-secondary)' } : undefined}>
                  <td style={{ position: 'sticky', left: 0, zIndex: 1, whiteSpace: 'normal', minWidth: 250 }}>
                    <button type="button" className="acct-drill" onClick={() => onLease(l)} style={{ fontWeight: 600, textAlign: 'left' }}>{l.propertyName}</button>
                    <StandingChips row={r} />
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}><TenantName row={r} />{l.status === 'ended' ? ` · ended ${l.leaseEnd ? formatDate(l.leaseEnd) : ''}` : ''}</div>
                  </td>
                  <td><TypeChip type={typeOf(r)} /></td>
                  <td className="acct-num">{rate ? whole(rate.rent + rate.cam + rate.other) : '-'}</td>
                  {idx.map((i) => {
                    const c = r.months[i];
                    if (!c || !c.inForce) return <td key={i} className="acct-num" style={{ color: 'var(--text-muted)' }}>-</td>;
                    const s = STATUS[c.status] || STATUS.none;
                    return (
                      <td key={c.month} className="acct-num" style={{ padding: 2 }}>
                        <button type="button" onClick={() => onCell(r, c)} aria-label={`${l.propertyName}, ${monthName(c.month)}: ${s.label}, received ${money(c.received)} of ${money(c.expected)}`}
                          title={`${s.label} - received ${money(c.received)} of ${money(c.expected)}${c.note ? ` - ${c.note}` : ''}`}
                          style={{ width: '100%', border: 'none', borderRadius: 6, cursor: 'pointer', font: 'inherit', fontVariantNumeric: 'tabular-nums', padding: '3px 6px', textAlign: 'right', background: s.bg, color: s.fg, fontWeight: ['short', 'unpaid', 'late'].includes(c.status) ? 700 : 400 }}>
                          {c.status === 'upcoming' || c.status === 'due' || c.status === 'unknown' ? whole(c.expected) : whole(c.received)}{c.note ? '*' : ''}
                        </button>
                      </td>
                    );
                  })}
                  <td className="acct-num" style={{ fontWeight: 700 }}>{f.received ? <Amount value={f.received} /> : '-'}</td>
                  <td className="acct-num" style={{ fontWeight: 700, color: f.balance > 0.005 ? 'var(--bad-fg, #dc2626)' : f.balance < -0.005 ? 'var(--ok-fg, #15803d)' : 'var(--text-muted)' }}
                    title={f.balance < -0.005 ? 'Credit - paid ahead' : undefined}>
                    {Math.abs(f.balance) > 0.005 ? <Amount value={f.balance} /> : '-'}
                  </td>
                  <td style={{ maxWidth: 260, minWidth: 180, whiteSpace: 'normal' }}><NoteCell lease={l} canEdit={canEdit} onSaved={onNote} /></td>
                </tr>
              );
            })}
            <tr className="acct-grand">
              <td style={{ position: 'sticky', left: 0 }}>Received - {rows.length} {rows.length === 1 ? 'source' : 'sources'}</td><td /><td />
              {idx.map((i) => { const v = monthTotal(i); return <td key={i} className="acct-num" title={`Expected ${money(monthExpected(i))}`}>{v || monthExpected(i) ? whole(v) : '-'}</td>; })}
              <td className="acct-num"><Amount value={figures.received} /></td>
              <td className="acct-num"><Amount value={figures.balance} /></td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
        {['paid', 'short', 'unpaid', 'due', 'upcoming', 'outside'].map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: STATUS[k].bg, border: `1px solid ${STATUS[k].fg}` }} />{k === 'unpaid' ? 'Unpaid or Late' : STATUS[k].label}
          </span>
        ))}
        <span>A paid month shows what came in; a month not yet paid shows what is expected. * has a note. Click a month for the detail and its journal entries. Balance is expected less received; a credit (in parentheses) is a prepayment. Outside the Lease is money posted when the lease is not in force - shown, not counted.</span>
      </div>
    </div>
  );
}

function reminder(row, year) {
  const l = row.lease;
  const behind = row.months.filter((c) => ['late', 'short', 'unpaid'].includes(c.status));
  const lines = behind.map((c) => `  ${monthName(c.month)}: ${money(c.balance)} of ${money(c.expected)}`).join('\n');
  const body = `Hello ${l.contactName || l.tenantName},\n\nOur records for ${l.propertyName} show rent outstanding for ${year}:\n\n${lines}\n\nTotal outstanding: ${money(row.owed)}${row.lateFees ? `\nLate fees under the lease: ${money(row.lateFees)}` : ''}\n\nIf you have already paid, please reply with the date and amount so we can match it.\n\nThank you.`;
  return `mailto:${encodeURIComponent(l.email)}?subject=${encodeURIComponent(`Rent outstanding - ${l.propertyName}`)}&body=${encodeURIComponent(body)}`;
}

function Outstanding({ rows, year, py }) {
  if (!rows.length) return <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>Nobody is behind for {year}.</div>;
  const sorted = [...rows].sort((a, b) => b.owed - a.owed);
  return (
    <div style={{ ...card, padding: 10 }}>
      <div className="acct-lines-wrap">
        <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto', '--acct-row-py': py }}>
          <thead>
            <tr><th scope="col">Property or Source</th><th scope="col">Type</th><th scope="col">Payer</th><th scope="col">Months Behind</th><th scope="col" className="acct-num">Balance Due</th><th scope="col" className="acct-num">Late Fees</th><th scope="col">Contact</th><th scope="col" aria-label="Write" /></tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const l = r.lease;
              const months = r.months.filter((c) => ['late', 'short', 'unpaid'].includes(c.status)).map((c) => MONTHS[Number(c.month.slice(5, 7)) - 1]);
              return (
                <tr key={l.id}>
                  <td style={{ fontWeight: 600 }}>{l.propertyName}<StandingChips row={r} /></td>
                  <td><TypeChip type={typeOf(r)} /></td>
                  <td><TenantName row={r} /></td>
                  <td style={{ whiteSpace: 'normal' }}>{r.monthsBehind} - {months.join(', ')}</td>
                  <td className="acct-num" style={{ fontWeight: 700, color: 'var(--bad-fg, #dc2626)' }}><Amount value={r.owed} /></td>
                  <td className="acct-num">{r.lateFees ? <Amount value={r.lateFees} /> : '-'}</td>
                  <td style={{ whiteSpace: 'normal' }}>{[l.contactName, l.phone].filter(Boolean).join(' · ') || '-'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {l.email
                      ? <a className="secondary-btn" href={reminder(r, year)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', padding: '3px 10px', textDecoration: 'none' }}><Mail size={13} /> Write to Tenant</a>
                      : <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>No email on file</span>}
                  </td>
                </tr>
              );
            })}
            <tr className="acct-grand"><td colSpan={4}>Total Outstanding - {sorted.length} {sorted.length === 1 ? 'tenant' : 'tenants'}</td><td className="acct-num"><Amount value={sorted.reduce((s, r) => s + r.owed, 0)} /></td><td className="acct-num"><Amount value={sorted.reduce((s, r) => s + r.lateFees, 0)} /></td><td colSpan={2} /></tr>
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>Write to Tenant opens your own email with the months and amounts filled in. Nothing is sent until you press send.</div>
    </div>
  );
}

function Tenants({ rows, py, canEdit, onEdit, onReplace }) {
  if (!rows.length) return <div style={{ ...card, padding: 18, fontSize: '0.88rem', color: 'var(--text-secondary)' }}>No lease matches.</div>;
  return (
    <div style={{ ...card, padding: 10 }}>
      <div className="acct-lines-wrap">
        <table className="acct-lines" style={{ width: '100%', tableLayout: 'auto', '--acct-row-py': py }}>
          <thead>
            <tr><th scope="col">Property or Source</th><th scope="col">Type</th><th scope="col">Payer</th><th scope="col">Landlord</th><th scope="col">Dates</th><th scope="col" className="acct-num">Amount</th><th scope="col" className="acct-num">CAM</th><th scope="col" className="acct-num">Deposit</th><th scope="col">Status</th><th scope="col" aria-label="Change" /></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const l = r.lease;
              const rate = l.rates[l.rates.length - 1];
              return (
                <tr key={l.id}>
                  <td style={{ fontWeight: 600, whiteSpace: 'normal' }}>{l.propertyName}{l.region ? <div style={{ fontWeight: 400, fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{l.region}</div> : null}</td>
                  <td><TypeChip type={typeOf(r)} /></td>
                  <td style={{ whiteSpace: 'normal' }}><TenantName row={r} />{l.customerId ? <span className="acct-code" style={{ marginLeft: 8 }}>{l.customerId}</span> : null}</td>
                  <td style={{ whiteSpace: 'normal' }}>{l.landlord || '-'}</td>
                  <td>{l.leaseStart ? formatDate(l.leaseStart) : '-'} to {l.leaseEnd ? formatDate(l.leaseEnd) : 'Month to Month'}</td>
                  <td className="acct-num">{rate ? <Amount value={rate.rent} /> : '-'}</td>
                  <td className="acct-num">{rate?.cam ? <Amount value={rate.cam} /> : '-'}</td>
                  <td className="acct-num">{l.securityDeposit ? <Amount value={l.securityDeposit} /> : '-'}</td>
                  <td>{LEASE_STATUS[l.status] || l.status}<StandingChips row={r} /></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canEdit && (
                      <>
                        <button type="button" style={icon} aria-label={`Change ${l.propertyName}`} title="Change this lease" onClick={() => onEdit(l)}><Pencil size={14} /></button>
                        {l.status !== 'ended' && <button type="button" style={icon} aria-label={`New tenant at ${l.propertyName}`} title="New tenant in this space" onClick={() => onReplace(l)}><UserPlus size={14} /></button>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
  const entryOpen = useRef(false);
  useEffect(() => { entryOpen.current = !!entry; }, [entry]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !entryOpen.current) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const s = STATUS[month.status] || STATUS.none;
  const dirty = Number(adjustment || 0) !== Number(month.adjustment || 0) || note !== (month.note || '');
  const save = () => {
    setBusy(true);
    setError('');
    api.setLeasingMonth(row.lease.id, month.month, { adjustment: Number(adjustment) || 0, note }).then(onSaved).catch((e) => { setError(e?.message || 'Could not save.'); setBusy(false); });
  };
  const fact = (k, v, strong) => (<div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.86rem', padding: '3px 0' }}><span style={{ color: 'var(--text-secondary)' }}>{k}</span><span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: strong ? 700 : 400 }}>{v}</span></div>);
  const title = ledgerRow ? `${row.account.code} ${row.account.title}` : row.lease.propertyName;
  const edits = canEdit && !ledgerRow;
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={`${title}, ${monthName(month.month)}`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0 }}>{monthName(month.month)}</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{title} · {ledgerRow ? 'From the ledger' : row.lease.tenantName || 'Vacant'}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
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
          {month.status === 'outside' && <div style={{ fontSize: '0.78rem', color: '#6d28d9' }}>The lease is not in force this month, so this is shown and not counted. If the tenant was paying, change the Lease Start (or End).</div>}
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
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>{edits ? 'Cancel' : 'Close'}</button>
          {edits && <button type="button" className="primary-btn" onClick={save} disabled={!dirty || busy}>{busy ? 'Saving...' : 'Save'}</button>}
        </div>
      </div>
      {entry && <div onClick={(e) => e.stopPropagation()} role="presentation"><EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} /></div>}
    </div>
  );
}

function LeaseEditor({ lease, replacing, canDelete, onClose, onSaved }) {
  const [l, setL] = useState(() => ({ incomeType: 'lease', ...lease, rates: (lease.rates || []).map((r) => ({ ...r })) }));
  const isLease = (l.incomeType || 'lease') === 'lease';
  const [movedOut, setMovedOut] = useState(() => { const d = new Date(`${lease.leaseStart || iso(new Date())}T00:00:00`); d.setDate(d.getDate() - 1); return iso(d); });
  const [customers, setCustomers] = useState(null);
  const [entities, setEntities] = useState([]);
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const set = (p) => setL((x) => ({ ...x, ...p }));
  useEffect(() => {
    api.getLeasingCustomers().then((d) => setCustomers(d?.customers || [])).catch(() => setCustomers([]));
    api.getAccountingLocations().then((d) => setEntities(d?.entities || [])).catch(() => setEntities([]));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const matches = useMemo(() => {
    const s = find.trim().toLowerCase();
    if (!s) return [];
    return (customers || []).filter((c) => c.code.toLowerCase().includes(s) || (c.name || '').toLowerCase().includes(s)).slice(0, 8);
  }, [customers, find]);
  const vacant = l.status === 'vacant';
  // Oct 7: the first rent starts with the lease unless it was set apart -
  // a lease start moved to January takes its first rent along.
  const setStart = (v) => setL((x) => ({ ...x, leaseStart: v, rates: x.rates.map((r, i) => (i === 0 && (!r.startDate || r.startDate === x.leaseStart) ? { ...r, startDate: v } : r)) }));
  const ready = l.propertyName.trim() && (vacant || l.tenantName.trim()) && l.rates.every((r) => r.startDate);
  const body = () => ({ ...l, incomeType: l.incomeType || 'lease', securityDeposit: Number(l.securityDeposit) || 0, lateFee: Number(l.lateFee) || 0, dueDay: Number(l.dueDay) || 1, graceDays: Number(l.graceDays) || 0,
    incomeAccounts: String(l.incomeAccounts).split(',').map((x) => x.trim()).filter(Boolean),
    rates: l.rates.map((r) => ({ startDate: r.startDate, rent: Number(r.rent) || 0, cam: Number(r.cam) || 0, other: Number(r.other) || 0, note: r.note || '' })) });
  const save = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    const work = replacing ? api.replaceLeasingTenant(replacing.id, { ...body(), movedOut }) : l.id ? api.updateLeasingLease(l.id, body()) : api.createLeasingLease(body());
    work.then(onSaved).catch((e) => { setError(e?.message || 'Could not save the lease.'); setBusy(false); });
  };
  const field = (key, text, props = {}) => (
    <div>
      <label style={label} htmlFor={`lease-${key}`}>{text}</label>
      <input id={`lease-${key}`} type="text" value={l[key] ?? ''} onChange={(e) => set({ [key]: e.target.value })} style={{ ...control, width: '100%' }} {...props} />
    </div>
  );
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 };
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={replacing ? 'New tenant in this space' : !isLease ? (l.id ? 'Change income source' : 'New interest or loan payment') : l.id ? 'Change lease' : 'New lease'} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860 }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0 }}>{replacing ? 'New Tenant in This Space' : !isLease ? (l.id ? 'Change Income Source' : 'New Interest or Loan Payment') : l.id ? 'Change Lease' : 'New Lease'}</h3>
            {replacing && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{replacing.tenantName}'s lease is ended and kept. This starts the next one.</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ padding: '14px 24px 6px', display: 'grid', gap: 14, maxHeight: '72vh', overflowY: 'auto' }}>
          {replacing && (
            <div style={{ maxWidth: 240 }}>
              <label style={label} htmlFor="lease-moved">Last Day of {replacing.tenantName}</label>
              <input id="lease-moved" type="date" value={movedOut} onChange={(e) => setMovedOut(e.target.value)} style={{ ...control, width: '100%' }} />
            </div>
          )}
          <div style={grid}>
            <div>
              <label style={label} htmlFor="lease-type">Type</label>
              <select id="lease-type" value={l.incomeType || 'lease'} onChange={(e) => set({ incomeType: e.target.value })} style={{ ...control, width: '100%' }}>
                {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            {field('propertyName', isLease ? 'Property or Space' : 'Source', { maxLength: 200, autoFocus: true, placeholder: isLease ? '910 SECR - Ste 100, San Clemente' : 'Note receivable - Oversite Inv2' })}
            {field('region', 'Region', { maxLength: 120, placeholder: 'Orange County' })}
            {field('landlord', 'Landlord (the tenant pays)', { maxLength: 200 })}
            <div>
              <label style={label} htmlFor="lease-tenancy">Tenant Is</label>
              <select id="lease-tenancy" value={l.tenancy} onChange={(e) => set({ tenancy: e.target.value })} style={{ ...control, width: '100%' }}>
                <option value="external">External</option><option value="internal">Internal - a related company</option>
              </select>
            </div>
            <div>
              <label style={label} htmlFor="lease-status">Status</label>
              <select id="lease-status" value={l.status} onChange={(e) => set({ status: e.target.value })} style={{ ...control, width: '100%' }}>
                {Object.entries(LEASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>

          {!vacant && (
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ position: 'relative' }}>
                <label style={label} htmlFor="lease-find">{isLease ? 'Tenant' : 'Payer'} - find the Intacct customer</label>
                <input id="lease-find" type="text" value={find} onChange={(e) => setFind(e.target.value)} placeholder={customers ? 'Type a name or a customer code' : 'Loading customers...'} style={{ ...control, width: '100%' }} />
                {matches.length > 0 && (
                  <div role="listbox" aria-label="Customers" style={{ border: '1px solid var(--border-color)', borderRadius: 8, marginTop: 4, padding: 4, display: 'grid', gap: 1 }}>
                    {matches.map((c) => (
                      <button key={c.code} type="button" role="option" aria-selected={c.code === l.customerId} onClick={() => { set({ customerId: c.code, tenantName: c.name || l.tenantName }); setFind(''); }}
                        style={{ display: 'flex', gap: 8, border: 'none', background: 'none', borderRadius: 6, padding: '4px 8px', font: 'inherit', fontSize: '0.8rem', cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)' }}>
                        <span style={{ flex: 1 }}>{c.name || c.code}</span><span style={{ color: 'var(--text-muted)' }}>{c.code}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div style={grid}>
                {field('tenantName', isLease ? 'Tenant Name' : 'Payer Name', { maxLength: 200 })}
                {field('customerId', 'Intacct Customer Code', { maxLength: 60 })}
                {field('contactName', 'Primary Contact', { maxLength: 200 })}
                {field('phone', 'Phone', { maxLength: 60 })}
                {field('email', 'Email', { maxLength: 200, type: 'email' })}
                {field('mailingAddress', 'Mailing Address', { maxLength: 300 })}
              </div>
            </div>
          )}

          <div style={grid}>
            <div>
              <label style={label} htmlFor="lease-leaseStart">{isLease ? 'Lease Start' : 'Starts'}</label>
              <input id="lease-leaseStart" type="date" value={l.leaseStart || ''} onChange={(e) => setStart(e.target.value)} style={{ ...control, width: '100%' }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>When the tenant started paying. Expected rent counts from here.</div>
            </div>
            <div>
              <label style={label} htmlFor="lease-leaseEnd">{isLease ? 'Lease End' : 'Ends'}</label>
              <input id="lease-leaseEnd" type="date" value={l.leaseEnd || ''} onChange={(e) => set({ leaseEnd: e.target.value })} style={{ ...control, width: '100%' }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>Leave empty for month to month.</div>
            </div>
            {field('leaseTerms', 'Lease Terms', { maxLength: 200, placeholder: 'Annual, month to month...' })}
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
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              {l.rates.map((r, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '150px repeat(3, minmax(90px, 1fr)) minmax(120px, 2fr) 30px', gap: 6, alignItems: 'center' }}>
                  <input type="date" value={r.startDate} aria-label={`Rent ${i + 1} starts`} onChange={(e) => set({ rates: l.rates.map((x, k) => (k === i ? { ...x, startDate: e.target.value } : x)) })} style={control} />
                  {[['rent', 'Rent'], ['cam', 'CAM'], ['other', 'Other']].map(([k, text]) => (
                    <input key={k} type="number" min="0" step="0.01" value={r[k]} placeholder={text} aria-label={`${text} of rent ${i + 1}`} onChange={(e) => set({ rates: l.rates.map((x, n) => (n === i ? { ...x, [k]: e.target.value } : x)) })} style={control} />
                  ))}
                  <input type="text" value={r.note || ''} maxLength={200} placeholder="Note, such as Renewal" aria-label={`Note of rent ${i + 1}`} onChange={(e) => set({ rates: l.rates.map((x, k) => (k === i ? { ...x, note: e.target.value } : x)) })} style={control} />
                  <button type="button" style={icon} aria-label={`Remove rent ${i + 1}`} onClick={() => set({ rates: l.rates.filter((_, k) => k !== i) })}><Trash2 size={14} /></button>
                </div>
              ))}
              {!l.rates.length && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>No rent yet. Without one, nothing is expected from this lease.</div>}
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Starts On, Rent, CAM (common area maintenance), Other, Note.</div>
            </div>
          </div>

          <div style={grid}>
            <div>
              <label style={label} htmlFor="lease-entity">Entity the Income Posts To</label>
              <select id="lease-entity" value={l.entityCode} onChange={(e) => set({ entityCode: e.target.value })} style={{ ...control, width: '100%' }}>
                <option value="">Not set</option>
                {entities.map((e) => <option key={e.code} value={e.code}>{e.name ? `${e.name} (${e.code})` : e.code}</option>)}
                {l.entityCode && !entities.some((e) => e.code === l.entityCode) && <option value={l.entityCode}>{l.entityCode}</option>}
              </select>
            </div>
            <div>
              <label style={label} htmlFor="lease-accounts">{isLease ? 'Rental Income Accounts' : 'Income Accounts'}</label>
              <input id="lease-accounts" type="text" value={Array.isArray(l.incomeAccounts) ? l.incomeAccounts.join(', ') : l.incomeAccounts} onChange={(e) => set({ incomeAccounts: e.target.value })} style={{ ...control, width: '100%' }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 3 }}>GL codes, separated by commas. What posts here for the tenant counts as rent received.</div>
            </div>
          </div>
          {field('notes', 'Notes', { maxLength: 1000 })}
          {error && <div style={bad}>{error}</div>}
        </div>
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
      </div>
    </div>
  );
}
