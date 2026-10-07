import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Database, FolderUp, Mail, MapPin, Pencil, Phone, Search, X } from 'lucide-react';
import { api } from '../../api';
import Amount, { AmountInput, formatAmount } from './Amount';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { useAccountingPrefs } from './prefs';
import { ColumnResizer, CustomizeButton, DENSITIES, EntitiesPicker, EntityPicker, ExportMenu, Pager, PopoverPanel, control } from './reportControls';
import { useColumnWidths, useCustomizePrefs, usePaged } from './tableHooks';
import { cellStyle, headStyle } from './columnStyles';
import EntryDetail from './EntryDetail';
import { downloadBlob, iso } from './reportModel';
import { linesFile } from './linesExport';
import SendReportDialog from './SendReportDialog';
import { ScanOutcome, ScanProgress, entitiesScannedText, mergeScans, useLedgerScan, useScanRetry, POLL_MS } from './LedgerScan';
import AddMenu from './AddMenu';

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
// "+ Add" offers From the Ledger (a scan of the active entities for vendors
// who posted at a stable amount in at least N of the last twelve months - the
// MRI rent heuristic) or Manual. The toolbar matches Reports: Entities,
// the year, a vendor search, category, Customize, Export.
//
// Oct 7 (items 9, 12, 21, 32, 33): the standard Customize adds Rows per Page
// (a Pager under the grid; the Total Paid row and the exports always cover
// every line), the grid's columns resize by dragging a header edge, the
// entity on a line is the module's entity picker (search by number), and a
// paid month or a line's Total opens the ledger lines behind it - what
// posted to the line's expense accounts for its vendor - each entry number
// opening the entry.

const CATEGORIES = [
  { key: 'utilities', label: 'Utilities' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'payroll_services', label: 'Payroll Services' },
  { key: 'software', label: 'Software' },
  { key: 'rent_paid', label: 'Rent Paid' },
  { key: 'other', label: 'Other' },
];
const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
const FREQUENCY = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };
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

/** The rows the toolbar leaves on screen. */
export function visibleRows(rows, { q = '', category = '', showEnded = false, showInactive = false, showZero = false } = {}) {
  const s = q.trim().toLowerCase();
  return (rows || []).filter((r) => {
    const l = r.line;
    if (!showEnded && l.status === 'ended') return false;
    if (!showInactive && r.vendorInactive) return false;
    if (category && l.category !== category) return false;
    if (!showZero && !r.paidTotal && !r.expectedYear) return false;
    return !s || [l.vendorName, l.vendorId, l.entityName, l.entityCode, l.notes].some((v) => (v || '').toLowerCase().includes(s));
  });
}

/** The grid as a table for linesExport (PDF / Excel / CSV / Email / Save to Files). */
export function mreTable(rows, year, entityLabel) {
  const columns = [
    { label: 'Vendor', width: 200 }, { label: 'Entity', width: 170 }, { label: 'Category', width: 100 }, { label: 'Frequency', width: 80 },
    { label: 'Expected', num: true, width: 80 },
    ...MONTHS.map((m) => ({ label: m, num: true, width: 70 })),
    { label: 'Total', num: true, width: 84 }, { label: 'Balance', num: true, width: 84 }, { label: 'Notes', width: 160 },
  ];
  const body = rows.map((r) => [
    r.line.vendorName, `${r.line.entityName} (${r.line.entityCode})`, CATEGORY[r.line.category] || 'Other', FREQUENCY[r.line.frequency] || 'Monthly',
    r.line.expectedAmount, ...r.months.map((c) => c.paid), r.paidTotal, r.balance, r.line.notes || '',
  ]);
  const totals = ['Total Paid', '', '', '', null, ...MONTHS.map((_m, i) => rows.reduce((s, r) => s + (r.months[i]?.paid || 0), 0)),
    rows.reduce((s, r) => s + r.paidTotal, 0), rows.reduce((s, r) => s + r.balance, 0), ''];
  return {
    title: 'Monthly Recurring Expenses', period: String(year),
    subtitle: `${entityLabel} · ${year} · paid as posted to each line's expense accounts for its vendor`,
    columns, rows: body, totals,
  };
}

export default function MreTab({ canEdit = false, canDelete = false }) {
  const [prefs, setPrefs] = useAccountingPrefs();
  const custom = useCustomizePrefs(['density', 'pageSize', 'historicalEntities']);
  const density = custom.density;
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [picked, setPicked] = useState([]);
  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [showZero, setShowZero] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);       // a line (new or existing)
  const [fromLedger, setFromLedger] = useState(false);
  const [sending, setSending] = useState(null);       // 'email' | 'egnyte'
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState('');
  const [lines, setLines] = useState(null);           // { line, from, to, title } - the ledger lines behind a figure
  const seq = useRef(0);
  const showEnded = !!prefs.mreShowEnded;
  const showInactive = !!prefs.mreShowInactive;

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

  const rows = useMemo(() => visibleRows(data?.rows, { q, category, showEnded, showInactive, showZero }), [data, q, category, showEnded, showInactive, showZero]);
  const sum = data?.summary || {};
  const entityLabel = !picked.length ? (limited ? 'All my entities' : 'All entities')
    : picked.length === 1 ? `${entities.find((e) => e.code === picked[0])?.name || picked[0]} (${picked[0]})` : `${picked.length} entities`;
  const table = () => mreTable(rows, year, entityLabel);
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

  return (
    <AsyncSection loading={data === null} skeleton={<SkeletonBlocks count={4} />}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ ...card, padding: '8px 10px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <EntitiesPicker entities={entities} value={picked} onChange={setPicked} limited={limited} showHistorical={custom.showHistorical} />
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }} role="group" aria-label="Year">
            <button type="button" style={icon} aria-label="Previous year" onClick={() => setYear((y) => y - 1)}><ChevronLeft size={16} /></button>
            <strong style={{ fontSize: '0.86rem', minWidth: 40, textAlign: 'center' }}>{year}</strong>
            <button type="button" style={icon} aria-label="Next year" disabled={year >= new Date().getFullYear() + 1} onClick={() => setYear((y) => y + 1)}><ChevronRight size={16} /></button>
          </div>
          <div style={{ position: 'relative', flex: '1 1 200px', maxWidth: 300 }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)' }} />
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a vendor" aria-label="Search a vendor" style={{ ...control, width: '100%', paddingLeft: 28 }} />
          </div>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={control}>
            <option value="">All Categories</option>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <CustomizeButton {...custom} showZero={showZero} onShowZero={setShowZero} active={showEnded || showInactive}>
              <Toggle checked={showEnded} onChange={(v) => setPrefs({ mreShowEnded: v })} title="Show Ended"
                hint="Recurring expenses that have stopped. They keep their history; nothing is deleted." />
              <Toggle checked={showInactive} onChange={(v) => setPrefs({ mreShowInactive: v })} title="Show Inactive Vendors"
                hint="Lines whose vendor Intacct marks inactive." />
            </CustomizeButton>
            <ExportMenu disabled={!rows.length} items={[
              { key: 'excel', label: 'Excel', hint: 'Every line, months as columns, live totals', onPick: () => exportAs('excel'), busy: busy === 'excel' },
              { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => exportAs('csv'), busy: busy === 'csv' },
              { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
              { key: 'email', group: 'send', label: 'Email...', hint: 'From your own mailbox, the grid attached', Icon: Mail, onPick: () => setSending('email') },
              { key: 'egnyte', group: 'send', label: 'Save to Files...', hint: 'Into a folder in Files, named as you like', Icon: FolderUp, onPick: () => setSending('egnyte') },
            ]} />
            {canEdit && (
              <AddMenu ariaLabel="Add a recurring expense" items={[
                { key: 'ledger', label: 'From the Ledger', hint: 'Vendors paid the same amount month after month', Icon: Database, onPick: () => setFromLedger(true) },
                { key: 'manual', label: 'Manual', hint: 'One vendor, accounts and amount by hand', Icon: Pencil, onPick: () => setEditing(blankLine(picked[0], entities)) },
              ]} />
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums', padding: '0 4px' }}>
          <span>Expected to Date <strong><Amount value={sum.expectedToDate} /></strong></span>
          <span>Paid to Date <strong><Amount value={sum.paidToDate} /></strong></span>
          <span>Balance <strong style={{ color: sum.balance > 0.5 ? 'var(--bad-fg, #dc2626)' : undefined }}><Amount value={sum.balance} /></strong></span>
          <span>{sum.missed || 0} {sum.missed === 1 ? 'line' : 'lines'} with a missed month</span>
          <Legend />
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

        {loading && !data?.rows?.length ? <SkeletonBlocks count={4} /> : !rows.length ? (
          <div style={{ ...card, padding: '18px 16px', fontSize: '0.86rem', color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{(data?.rows || []).length ? 'Nothing matches these filters.' : 'No recurring expenses yet.'}</strong>
            <span>
              {(data?.rows || []).length
                ? `${hidden} ${hidden === 1 ? 'line is' : 'lines are'} hidden by the search, the category or Customize (ended lines, inactive vendors, lines with nothing this year).`
                : canEdit ? 'Use + Add: From the Ledger proposes the vendors your entities pay the same amount month after month; Manual adds one by hand.' : 'Someone with edit access to Accounting adds them from the ledger or by hand.'}
            </span>
          </div>
        ) : (
          <Grid rows={rows} totals={data?.totals || []} year={year} density={density} loading={loading} canEdit={canEdit}
            pageSize={custom.pageSize} pageKey={[year, picked, q, category, showEnded, showInactive, showZero]} onLines={setLines}
            onEdit={(l) => setEditing(l)} onNotes={(id, notes) => api.setMreNotes(id, notes).then((line) => setData((d) => ({ ...d, rows: d.rows.map((r) => (r.line.id === id ? { ...r, line } : r)) })))} />
        )}
      </div>

      {editing && (
        <LineEditor line={editing} entities={entities} canDelete={canDelete} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
      {lines && <LedgerLines {...lines} onClose={() => setLines(null)} />}
      {fromLedger && (
        <MreFromLedger entities={picked} entityLabel={entityLabel} onClose={() => setFromLedger(false)} onCreated={() => { setFromLedger(false); load(); }} />
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

function Legend() {
  return (
    <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, flexWrap: 'wrap' }} aria-label="Legend">
      {['paid', 'short', 'over', 'missed', 'upcoming'].map((k) => (
        <span key={k} style={{ fontSize: '0.7rem', fontWeight: 700, color: STATUS[k].fg, background: STATUS[k].bg, border: k === 'upcoming' ? '1px dashed var(--border-color)' : 'none', borderRadius: 999, padding: '1px 8px' }}>{STATUS[k].label}</span>
      ))}
    </span>
  );
}

// The grid's resizable columns (Oct 7, item 32), saved per viewer: vendor,
// entity, category, expected, each month (m0..m11), total, balance, notes.
const MRE_COLUMNS = [['vendor', 'Vendor'], ['entity', 'Entity'], ['category', 'Category'], ['expected', 'Expected', true]];

function Grid({ rows, totals, year, density, loading, canEdit, onEdit, onNotes, pageSize = 0, pageKey = '', onLines = null }) {
  const py = DENSITIES.find((d) => d.key === density)?.py || '5px';
  const cw = useColumnWidths('mre');
  // Rows per Page: this page's lines; the Total Paid row adds up every line.
  const paged = usePaged(rows, pageSize, pageKey);
  const totalPaid = rows.reduce((s, r) => s + r.paidTotal, 0);
  const totalBalance = rows.reduce((s, r) => s + r.balance, 0);
  const monthPaid = MONTHS.map((_m, i) => rows.reduce((s, r) => s + (r.months[i]?.paid || 0), 0));
  return (
    <div className="acct-report-wrap" style={{ opacity: loading ? 0.6 : 1 }}>
      <table className="acct-report" style={{ '--acct-row-py': py }} aria-label={`Recurring expenses ${year}`}>
        <thead>
          <tr>
            {MRE_COLUMNS.map(([k, l, isNum]) => (
              <th key={k} aria-label={l} className={k === 'vendor' ? 'acct-label acct-head' : isNum ? 'acct-num' : undefined} style={headStyle(cw.width(k))}>{l}<ColumnResizer {...cw.resizer(k, l)} /></th>
            ))}
            {MONTHS.map((m, i) => <th key={m} aria-label={m} className="acct-num" style={headStyle(cw.width(`m${i}`))}>{m}<ColumnResizer {...cw.resizer(`m${i}`, m)} /></th>)}
            <th aria-label="Total" className="acct-num" style={headStyle(cw.width('total'), { fontWeight: 800 })}>Total<ColumnResizer {...cw.resizer('total', 'Total')} /></th>
            <th aria-label="Balance" className="acct-num" style={headStyle(cw.width('balance'))}>Balance<ColumnResizer {...cw.resizer('balance', 'Balance')} /></th>
            <th aria-label="Notes" style={headStyle(cw.width('notes'), { minWidth: cw.width('notes') || 180 })}>Notes<ColumnResizer {...cw.resizer('notes', 'Notes')} /></th>
          </tr>
        </thead>
        <tbody>
          {paged.rows.map((r) => (
            <tr key={r.line.id}>
              <td className="acct-label" style={cw.width('vendor') ? cellStyle(cw.width('vendor')) : { maxWidth: 260 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
                  <VendorName id={r.line.vendorId} name={r.line.vendorName} />
                  {r.line.status === 'ended' && <Chip text="Ended" />}
                  {r.vendorInactive && <Chip text="Inactive" />}
                  {canEdit && <button type="button" style={{ ...icon, padding: 2 }} onClick={() => onEdit(r.line)} aria-label={`Edit ${r.line.vendorName}`} title="Edit"><Pencil size={12} /></button>}
                </span>
              </td>
              <td title={`${r.line.entityName} (${r.line.entityCode})`} style={cw.width('entity') ? cellStyle(cw.width('entity')) : { maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}><span className="acct-code">{r.line.entityCode}</span>{r.line.entityName}</td>
              <td style={cellStyle(cw.width('category'))}>{CATEGORY[r.line.category] || 'Other'}</td>
              <td className="acct-num" style={cellStyle(cw.width('expected'))} title={`${FREQUENCY[r.line.frequency]} from ${formatDate(r.line.startDate) || 'the start'}${r.line.endDate ? ` to ${formatDate(r.line.endDate)}` : ''}`}>
                <Amount value={r.line.expectedAmount} />
                <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{FREQUENCY[r.line.frequency] || 'Monthly'}</span>
              </td>
              {r.months.map((c, i) => <MonthCell key={c.month} cell={c} width={cw.width(`m${i}`)} onOpen={onLines && Math.abs(Number(c.paid) || 0) > 0.005 ? () => onLines({ line: r.line, ...monthRange(c.month), title: monthLabel(c.month) }) : null} />)}
              <td className="acct-num" style={cellStyle(cw.width('total'), { fontWeight: 700 })}>
                {onLines && Math.abs(Number(r.paidTotal) || 0) > 0.005
                  ? <button type="button" className="acct-drill" onClick={() => onLines({ line: r.line, from: `${year}-01-01`, to: `${year}-12-31`, title: String(year) })} aria-label={`Ledger lines behind ${r.line.vendorName}'s total for ${year}`} title="The ledger lines behind this total"><Amount value={r.paidTotal} zero="dash" /></button>
                  : <Amount value={r.paidTotal} zero="dash" />}
              </td>
              <td className="acct-num" style={cellStyle(cw.width('balance'), { color: r.balance > 0.5 ? 'var(--bad-fg, #dc2626)' : undefined })} title="Expected less paid, to date"><Amount value={r.balance} zero="dash" /></td>
              <td style={cw.width('notes') ? cellStyle(cw.width('notes'), { whiteSpace: 'normal' }) : { whiteSpace: 'normal', minWidth: 180 }}><NotesCell line={r.line} canEdit={canEdit} onSave={onNotes} /></td>
            </tr>
          ))}
          <tr className="acct-grand">
            <td className="acct-label">Total Paid</td>
            <td /><td /><td />
            {monthPaid.map((v, i) => <td key={i} className="acct-num" title={`Expected ${formatAmount(totals[i]?.expected || 0)}`}><Amount value={v} zero="dash" /></td>)}
            <td className="acct-num"><Amount value={totalPaid} zero="dash" /></td>
            <td className="acct-num"><Amount value={totalBalance} zero="dash" /></td>
            <td />
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
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={`${line.vendorName}, ${title}`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, width: '100%' }}>
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
      <td className="acct-num" style={cellStyle(width, { color: 'var(--text-muted)' })}>
        {onOpen ? <button type="button" className="acct-drill" onClick={onOpen} aria-label={`Ledger lines for ${monthLabel(cell.month)}`}><Amount value={cell.paid} zero="dash" /></button> : <Amount value={cell.paid || 0} zero="dash" />}
      </td>
    );
  }
  const title = `${monthLabel(cell.month)} - ${st.label}. Expected ${formatAmount(cell.expected)}, paid ${formatAmount(cell.paid)}.`;
  const shown = cell.status === 'missed' ? 'Missed' : cell.status === 'upcoming' && !cell.paid ? <Amount value={cell.expected} zero="dash" /> : <Amount value={cell.paid} zero="dash" />;
  return (
    <td className="acct-num" title={title} aria-label={title} data-status={cell.status}
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
      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, cursor: 'default', textDecoration: 'underline dotted var(--border-color)', textUnderlineOffset: 3 }}>
      {name}
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
    expectedAmount: 0, startDate: `${iso(new Date()).slice(0, 7)}-01`, endDate: '', status: 'active', notes: '' };
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
  const ready = l.entityCode && l.vendorId.trim() && accounts.length;
  const body = () => ({
    entityCode: l.entityCode, entityName: entities.find((e) => e.code === l.entityCode)?.name || l.entityName || '', vendorId: l.vendorId.trim(), vendorName: l.vendorName.trim(),
    expenseAccounts: accounts, category: l.category, frequency: l.frequency, expectedAmount: Number(l.expectedAmount) || 0,
    startDate: l.startDate || '', endDate: l.endDate || '', status: l.status, notes: l.notes || '',
  });
  const run = (work) => {
    setBusy(true);
    setError('');
    work.then(onSaved).catch((e) => { setError(e?.message || 'Could not save.'); setBusy(false); });
  };
  const save = () => { if (ready && !busy) run(l.id ? api.updateMreLine(l.id, body()) : api.createMreLine(body())); };
  const pickVendor = (text) => {
    const hit = (vendors || []).find((v) => v.code === text || `${v.name} (${v.code})` === text);
    set(hit ? { vendorId: hit.code, vendorName: hit.name || hit.code, vendorText: `${hit.name || hit.code} (${hit.code})` } : { vendorText: text, vendorId: text, vendorName: l.vendorName || '' });
  };
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 };
  const vendorText = l.vendorText ?? (l.vendorId ? `${l.vendorName || l.vendorId} (${l.vendorId})` : '');
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-label={l.id ? 'Edit recurring expense' : 'Add recurring expense'} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
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
              <input id="mre-vendor" type="text" list="mre-vendor-list" value={vendorText} onChange={(e) => pickVendor(e.target.value)} placeholder={vendors === null ? 'Loading vendors...' : 'Search a vendor by name or code'} style={{ ...control, width: '100%' }} />
              <datalist id="mre-vendor-list">
                {(vendors || []).slice(0, 2000).map((v) => <option key={v.code} value={`${v.name || v.code} (${v.code})`} />)}
              </datalist>
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
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Debt service is under Loans &amp; Financing.</span>
            </div>
          </div>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="mre-amount">Expected Amount</label>
              <AmountInput id="mre-amount" value={l.expectedAmount} onChange={(v) => set({ expectedAmount: v ?? 0 })} style={{ ...control, width: '100%' }} />
            </div>
            <div>
              <label style={label} htmlFor="mre-frequency">Frequency</label>
              <select id="mre-frequency" value={l.frequency} onChange={(e) => set({ frequency: e.target.value })} style={{ ...control, width: '100%' }}>
                {Object.entries(FREQUENCY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          <div style={grid}>
            <div>
              <label style={label} htmlFor="mre-start">Start</label>
              <input id="mre-start" type="date" value={l.startDate} onChange={(e) => set({ startDate: e.target.value })} style={{ ...control, width: '100%' }} />
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>A quarterly or annual bill falls due from this month.</span>
            </div>
            <div>
              <label style={label} htmlFor="mre-end">End</label>
              <input id="mre-end" type="date" value={l.endDate} onChange={(e) => set({ endDate: e.target.value })} style={{ ...control, width: '100%' }} />
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Leave empty while it continues.</span>
            </div>
          </div>
          <div>
            <label style={label} htmlFor="mre-status">Status</label>
            <select id="mre-status" value={l.status} onChange={(e) => set({ status: e.target.value })} style={{ ...control, width: 200 }}>
              <option value="active">Active</option>
              <option value="ended">Ended</option>
            </select>
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
              <button type="button" className="secondary-btn" disabled={busy} onClick={() => run(api.deleteMreLine(l.id))}>Delete</button>
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
export function MreFromLedger({ entities = [], entityLabel = 'All entities', onClose, onCreated, pollMs = POLL_MS }) {
  const [min, setMin] = useState(3);
  const scan = useLedgerScan(() => api.getMreProposals(min, entities), [min, entities.join(',')], pollMs);
  const { progress, retry } = scan;
  // Oct 7 (Charmi: stuck at "133 of 142 entities" for 5+ minutes): the scan
  // has a time limit; what it could not read is listed with Retry for just those.
  const again = useScanRetry((codes) => api.getMreProposals(min, codes), pollMs);
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
      <div className="modal-content" role="dialog" aria-modal="true" aria-label="Add recurring expenses from the ledger" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 1080 }}>
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
              {done.created.map((p) => <div key={keyOf(p)}>{p.vendorName} at {p.entityName} - <Amount value={p.expectedAmount} /> {FREQUENCY[p.frequency]?.toLowerCase()}</div>)}
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
                        <td><div>{p.vendorName}</div><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{p.vendorId}</div></td>
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
