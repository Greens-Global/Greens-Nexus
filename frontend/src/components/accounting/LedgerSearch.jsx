import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { api, withFreshReads } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { useIsMobile } from '../../lib/useIsMobile';
import EntryDetail from './EntryDetail';
import AskAccountantDialog, { AskButton, lineFromSearch } from './AskAccountantDialog';
import Amount from './Amount';
import { useAccountingPrefs } from './prefs';
import { ColumnFilterRow, columnFiltersActive, filterRowsByColumns } from './columnFilters';
import { linesBaseName } from './linesExport';
import { useFitHeight, usePaged } from './tableHooks';
import { TableViewBar, ViewHead, applyView, useTableView } from './tableView';
import { DIM_KINDS, bookOptions, bookTitle, glLineParams, lineMatchesDims, numberFilterHit, parseFigure } from './reportModel';

// Search results and report drill-downs for Accounting -> Reports.
//
// Neil (Sep 17): "if I type in a vendor I should see every single payment made
// to them ... without having to call the accounting team." Charmi: anything
// that CONTAINS what was typed shows up, then you filter down. Neil: pick the
// entity first, keep funnelling, but never 18 clicks.
//
// So: the entity and the words come from the Reports toolbar above; this panel
// shows every matching posted line, the totals over the WHOLE result (not just
// the page), and one-click chips built from the matches themselves - the
// vendors, customers, accounts and journals they involve. A drill-down from a
// report is the same thing started from an account instead of a word.
//
// Sep 25 (Neil, Charmi) - the grid works like an Intacct list:
//   - a filter box under every column, and they stack ("%amazon", then a date,
//     then an amount that ends in .55); the server applies them to the whole
//     result, so the totals and the page count follow;
//   - every column can be dragged wider or narrower, shown or hidden, and the
//     layout is the person's own (Doc No is off until someone turns it on);
//   - one typeface, banded rows, and the hover fills the whole row so the eye
//     can follow a line across a wide monitor to its amount.
//
// Sep 30 (Charmi, call of 09/29): the columns read Date, Entry, Account,
// Description, Entity, then Vendor and Customer as two columns (the joint
// "Vendor / Customer" is gone); the description no longer takes every spare
// pixel - the spare width is shared out over the text columns; the vendor /
// customer / account / journal chips are dropdowns.
//
// Oct 2 (Charmi): the grid scrolls WITH the page - no box of its own with a
// scrollbar - so a tall window shows that many more lines; only full screen
// keeps the inner scroller. A total on a report drills here with no account
// (every line of the period); the report's Journals filter follows the lines.
//
// Call of 10/27 with Charmi, item 17 (14:48, her Intacct General Ledger): the
// lines read like Intacct's General Ledger report - Doc, Item, Employee and
// Department show without being turned on, in Intacct's order (Location =
// Entity, then Vendor, Customer, Item, Employee, Department), and a
// drill-down adds a running Balance with its closing figure on the totals
// row. A click anywhere on a line opens the transaction behind it on the
// right (EntryDetail's panel, with Open Full), the lines still beside it
// (15:41: the Ramp card charge one click under its ledger line). A person's
// own saved layout still wins over these defaults.

const PAGE = 100;
const EXPORT_CAP = 10000;
// 10/23 meeting, item 01: a view's filters read at most this many lines.
const ALL_CAP = 10000;

const money = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.005) return '';
  return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const named = (name, id) => name || id || '';
// Oct 14 (Charmi): a vendor's or customer's number before the
// name - "V00412 Home Depot" - everywhere in the accounting module.
const numbered = (name, id) => (id && name && name !== id ? `${id} ${name}` : name || id || '');
const partyText = (p) => (p.kind === 'employee' ? named(p.name, p.code) : numbered(p.name, p.code));

// Every column the grid can show. `filter`: the server can narrow by it.
// `off`: hidden until the person turns it on.
export const LINE_COLUMNS = [
  { key: 'date', label: 'Date', width: 96, filter: true, text: (r) => formatDate(r.entry_date) },
  { key: 'entry', label: 'Entry', width: 108, filter: true, text: (r) => r.entry_no || '' },
  { key: 'doc', label: 'Doc No', width: 120, filter: true, text: (r) => r.doc || '' },
  { key: 'account', label: 'Account', width: 250, filter: true, text: (r) => `${r.gl_code} ${r.account_name}`.trim() },
  { key: 'description', label: 'Description', width: 300, filter: true, text: (r) => r.description || '' },
  { key: 'memo', label: 'Memo', width: 240, off: true, text: (r) => r.memo || '' },
  { key: 'entity', label: 'Entity', width: 190, filter: true, text: (r) => r.location_name || r.location || '' },
  { key: 'vendor', label: 'Vendor', width: 180, filter: true, text: (r) => numbered(r.vendor_name, r.vendor_id) },
  { key: 'customer', label: 'Customer', width: 180, filter: true, text: (r) => numbered(r.customer_name, r.customer_id) },
  { key: 'item', label: 'Item', width: 140, text: (r) => named(r.item_name, r.item_id) },
  { key: 'employee', label: 'Employee', width: 170, filter: true, text: (r) => named(r.employee_name, r.employee_id) },
  { key: 'department', label: 'Department', width: 150, filter: true, text: (r) => named(r.department_name, r.department) },
  { key: 'project', label: 'Project-Job', width: 180, off: true, text: (r) => named(r.project_name, r.project_id) },
  { key: 'journal', label: 'Journal', width: 88, filter: true, text: (r) => r.journal || '' },
  { key: 'debit', label: 'Debit', width: 118, num: true, filter: true, text: (r) => money(r.debit) },
  { key: 'credit', label: 'Credit', width: 118, num: true, filter: true, text: (r) => money(r.credit) },
  // A drill-down only (item 17): the lines' running total, oldest first.
  { key: 'balance', label: 'Balance', width: 124, num: true, drillOnly: true, text: (r) => (r.balance == null ? '' : money(r.balance)) },
];
/**
 * The lines oldest first - by date, then entry and line - whatever order they
 * arrive in, each with its running `balance` (debits less credits), as
 * Intacct's General Ledger carries it down the page (item 17). Each line keeps
 * its own balance however the person then sorts or filters the grid.
 */
export function withBalance(lines) {
  const order = [...lines].sort((a, b) => String(a.entry_date || '').localeCompare(String(b.entry_date || ''))
    || String(a.entry_no || '').localeCompare(String(b.entry_no || ''), undefined, { numeric: true })
    || String(a.line_id || '').localeCompare(String(b.line_id || ''), undefined, { numeric: true }));
  let run = 0;
  return order.map((l) => { run += (Number(l.debit) || 0) - (Number(l.credit) || 0); return { ...l, balance: Math.round(run * 100) / 100 }; });
}
const MIN_WIDTH = 60;
// What the standard table view needs to filter and sort a column as a date or
// an amount (item 01). A zero debit or credit is a blank cell, so it is blank.
const figure = (key) => (r) => { const v = Number(r[key]) || 0; return Math.abs(v) < 0.005 ? null : v; };
const LINE_TYPES = {
  date: { type: 'date', value: (r) => r.entry_date || '' },
  debit: { type: 'amount', value: figure('debit'), total: true },
  credit: { type: 'amount', value: figure('credit'), total: true },
};
// The box under every heading (columnFilters.jsx, the one every Accounting
// table uses since 10/27). The columns the ledger narrows by (`filter`) still
// go to the server, so the totals and the pages follow; Memo, Project-Job and
// Item, which it cannot, are checked here - on every line of the search, read
// in full once one is typed, as the view's own filters are.
const LINE_FILTERS = LINE_COLUMNS.filter((c) => !c.drillOnly).map((c) => ({
  key: c.key, label: c.label, text: c.text, server: !!c.filter,
  ...(c.num ? { num: true, value: (r) => Number(r[c.key]) || 0 } : null),
  ...(c.key === 'date' ? { placeholder: 'MM/DD/YYYY' } : null),
}));
const LOCAL_FILTERS = LINE_FILTERS.filter((c) => !c.server);
// The filter row's cells: the shared row draws <td>, the lines grid styled <th>.
const FILTER_CSS = '.acct-lines .acct-filter-row td { padding: 3px 4px 4px; background: var(--bg-card); }';
// Oct 15 (Neil): the Ask My Accountant action at the end of every line.
const ASK_WIDTH = 34;
const ASK_CELL = { key: 'ask' };   // its filter cell stays empty
const DENSITY_PY = { comfortable: '9px', compact: '5px', condensed: '2px' };

const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: '0.75rem', cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-primary)', maxWidth: 260, fontFamily: 'inherit' };
const activeChip = { ...chip, cursor: 'default', border: '1px solid var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)', fontWeight: 600 };

function ActiveChip({ label, onClear }) {
  return (
    <span style={activeChip}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <button type="button" onClick={onClear} aria-label={`Remove ${label}`} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'inherit', display: 'inline-flex' }}><X size={12} /></button>
    </span>
  );
}

// On a phone (Oct 1) the 1,600 px grid gives way to one card per line: what
// it was and how much on the first line, the account and entity on the
// second, the date, entry number and other party on the third. Tapping the
// card opens the journal entry. The desktop grid is untouched.
function LineCard({ r, onOpen }) {
  const amount = Number(r.debit) > 0 ? money(r.debit) : Number(r.credit) > 0 ? `(${money(r.credit)})` : '0.00';
  const party = numbered(r.vendor_name, r.vendor_id) || numbered(r.customer_name, r.customer_id) || named(r.employee_name, r.employee_id);
  const Tag = r.entry_id ? 'button' : 'div';
  return (
    <Tag type={r.entry_id ? 'button' : undefined} onClick={r.entry_id ? onOpen : undefined} className="acct-line-card"
      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--border-color)', background: 'none', fontFamily: 'inherit', color: 'var(--text-primary)', cursor: r.entry_id ? 'pointer' : 'default' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: '0.86rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description || r.memo || r.entry_no || 'Ledger line'}</span>
        <span style={{ fontSize: '0.86rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{amount}</span>
      </div>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span className="acct-code">{r.gl_code}</span>{r.account_name}{r.location_name || r.location ? ` · ${r.location_name || r.location}` : ''}
      </div>
      <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ whiteSpace: 'nowrap' }}>{[r.entry_date ? formatDate(r.entry_date) : '', r.entry_no].filter(Boolean).join(' · ')}</span>
        {party && <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{party}</span>}
      </div>
    </Tag>
  );
}

// The report's filters follow the lines (Oct 7, Charmi): the entities, and
// every dimension picked on the report - departments, vendors, customers,
// employees, Project-Jobs, items and journals - go to the search as the same
// comma-separated lists the report reads take (glLineParams). One vendor,
// customer or employee also narrows as the search's own party, the narrowing
// the ledger has always applied. Each one shows as a chip and can be lifted
// here without changing the report.
function applyDims(dims, entities) {
  const place = entities.length === 1 ? { location: entities[0] } : entities.length ? { locations: entities.join(',') } : {};
  if (!dims) return { place, party: null, picked: [] };
  const { party_kind: kind, party: code, ...lists } = glLineParams(dims);
  Object.assign(place, lists);
  const picked = DIM_KINDS.filter((k) => dims[k.key]?.length).map((k) => ({ key: k.key, kind: k.kind, label: k.plural.charAt(0).toUpperCase() + k.plural.slice(1), one: k.one || k.label, codes: dims[k.key] }));
  return { place, party: kind ? { kind, code, name: code } : null, picked };
}
const dimChipText = (d, names) => {
  const shown = d.codes.slice(0, 3).map((c) => { const n = names?.[d.kind]?.[c]; return n ? `${n} (${c})` : c; });
  const more = d.codes.length > 3 ? ` +${d.codes.length - 3} more` : '';
  return `${d.codes.length === 1 ? d.one : d.label}: ${shown.join(', ')}${more}`;
};
// A comparison on Debit or Credit (Oct 7, item 26d - the Reports tables'
// operators): "=" keeps the server's match over the whole result; >, <, >=,
// <= and Between are checked here, on the lines loaded.
const opSet = (f) => !!f && (String(f.a ?? '').trim() || String(f.b ?? '').trim());
// What a filter box sends to the server: the text, or an amount box's "=" value.
const filterText = (c, v) => (c.num ? (v && (v.op || '=') === '=' ? String(v.a || '') : '') : String(v || ''));
// An operator box as the ledger's query params (10/07): debit_op=gt&debit_v=100.
// "=" travels as typed text in `cols`; an open-ended Between is >= or <=.
const OP_PARAM = { '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };
function opQuery(key, f) {
  const a = parseFigure(f.a);
  const b = parseFigure(f.b);
  const op = f.op || '=';
  if (op === 'between') {
    if (!Number.isNaN(a) && !Number.isNaN(b)) return { [`${key}_op`]: 'between', [`${key}_v`]: a, [`${key}_v2`]: b };
    if (!Number.isNaN(a)) return { [`${key}_op`]: 'gte', [`${key}_v`]: a };
    if (!Number.isNaN(b)) return { [`${key}_op`]: 'lte', [`${key}_v`]: b };
    return {};
  }
  return OP_PARAM[op] && !Number.isNaN(a) ? { [`${key}_op`]: OP_PARAM[op], [`${key}_v`]: a } : {};
}
const opText = (label, f) => (f.op === 'between' ? `${label} between ${f.a || '...'} and ${f.b || '...'}` : `${label} ${f.op} ${f.a}`);

// `initialEntry` ({ id, no }) opens that journal entry on top of the lines
// as soon as the grid mounts - the dashboard's Find a Transaction tile hands
// it over with the words typed (Oct 1). `onEntryClosed` lets the owner forget
// it, so closing the modal does not reopen it on the next render.
export default function LedgerSearch({ term, entities = [], entityName, drill, onClearDrill, onClose, backLabel = '', onBusy, onExport, dims = null, dimNames = null, full = false, initialEntry = null, onEntryClosed, syncTick = 0 }) {
  const entitiesKey = entities.join(',');
  // The report's filters, plus any a drill from another tab brought with it
  // (requestReportDrill's `dims`), less the ones lifted here with a chip's x.
  const [dropped, setDropped] = useState([]);
  const dimsKey = JSON.stringify([dims, drill?.dims || null, dropped]);
  const effectiveDims = useMemo(() => {
    const all = { ...(dims || {}), ...(drill?.dims || {}) };
    dropped.forEach((k) => { delete all[k]; });
    return Object.keys(all).some((k) => all[k]?.length) ? all : null;
  }, [dimsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const applied = useMemo(() => applyDims(effectiveDims, entities), [effectiveDims, entitiesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Narrowing picked from the chips. A drill-down arrives with its account set.
  const [party, setParty] = useState(null);       // { kind, code, name }
  const [account, setAccount] = useState(null);   // { code, name }
  const [journal, setJournal] = useState('');
  const [book, setBook] = useState('all');
  const [scope, setScope] = useState('all');      // all | period (a drill-down always uses its period)
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const isPhone = useIsMobile('(max-width: 640px)');
  const [openEntry, setOpenEntry] = useState(null); // { id, no } - the entry number clicked
  const [asking, setAsking] = useState(null);       // the line in the Ask My Accountant dialog
  const [asked, setAsked] = useState(null);         // the question just sent
  useEffect(() => { if (initialEntry?.id) setOpenEntry({ id: initialEntry.id, no: initialEntry.no || '' }); }, [initialEntry?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeEntry = () => { setOpenEntry(null); onEntryClosed?.(); };
  const openLine = (r) => setOpenEntry({ id: r.entry_id, no: r.entry_no, line: r.line_id });
  const seq = useRef(0);

  // The person's own layout: which columns show and how wide. Since 10/24 it
  // is the standard table view (item 01) - the layout chosen before (prefs
  // `lines`) is the person's built-in default.
  const [prefs] = useAccountingPrefs();
  const layout = prefs.lines || {};
  // The running Balance is a drill-down's (one account, one period); a typed
  // search across accounts has no balance to run.
  const balanceOn = !!drill;
  const viewColumns = useMemo(() => LINE_COLUMNS.filter((c) => !c.drillOnly || balanceOn).map((c) => ({
    ...c, ...(LINE_TYPES[c.key] || {}),
    off: !(layout.visible?.[c.key] ?? !c.off),
    width: Math.max(MIN_WIDTH, Number(layout.widths?.[c.key]) || c.width),
  })), [layout.visible, layout.widths, balanceOn]);
  // The grid uses the whole width it is given (Neil, Sep 25: "it should take up
  // much more screen"): whatever is left over on a wide monitor is shared out
  // over the text columns the reader has not sized by hand (Charmi, 09/29:
  // the description must not take all of it).
  const [wrap, setWrap] = useState(null);   // the grid's scroll box, once it is on screen
  const [room, setRoom] = useState(0);
  useEffect(() => {
    if (!wrap || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setRoom(wrap.clientWidth));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [wrap]);
  // UI test 10/23 (item 18): what sits above the lines (the drill's title, the
  // filters, the totals) wraps to a different height on each screen, so the
  // box is sized from where it actually starts, leaving room for what the page
  // still shows under it (the notes below the lines, the card's and the page's
  // bottom padding), so it ends inside the window with no second page
  // scrollbar; 300px at least. It re-measures when the window or the area
  // around it changes size (filters or totals above wrapping after a load).
  const fitBox = useFitHeight(wrap, { off: full, cssVar: '--acct-lines-h' });   // tableHooks, shared by every table since 10/24

  // The filter boxes. What is typed waits a moment before the ledger is asked.
  // An amount column's box is { op, a, b } (the Reports tables' operators);
  // its "=" goes to the server like any typed text, and the other operators
  // go as debit_op / credit_op so the ledger's totals and paging follow them
  // (10/07). A ledger that does not know them yet is caught below: the lines
  // it hands back are checked here instead.
  const [typed, setTyped] = useState({});
  const setFilter = (k, v) => setTyped((t) => ({ ...t, [k]: v }));
  const [cols, setCols] = useState('');
  const [opQs, setOpQs] = useState('');
  useEffect(() => {
    const kept = {};
    const ops = {};
    LINE_COLUMNS.forEach((c) => {
      const v = filterText(c, typed[c.key]).trim();
      if (c.filter && v) kept[c.key] = v;
      if (c.filter && c.num && opSet(typed[c.key])) Object.assign(ops, opQuery(c.key, typed[c.key]));
    });
    const next = Object.keys(kept).length ? JSON.stringify(kept) : '';
    const nextOps = Object.keys(ops).length ? JSON.stringify(ops) : '';
    const t = setTimeout(() => { setCols(next); setOpQs(nextOps); }, 350);
    return () => clearTimeout(t);
  }, [typed]);
  const filtering = columnFiltersActive(LINE_FILTERS, typed);
  const localOn = columnFiltersActive(LOCAL_FILTERS, typed);
  const localKey = JSON.stringify(LOCAL_FILTERS.map((c) => typed[c.key] || ''));
  const opFiltersAll = LINE_COLUMNS.filter((c) => c.num && opSet(typed[c.key]) && (typed[c.key].op || '=') !== '=').map((c) => ({ c, f: typed[c.key] }));

  // A new drill-down replaces whatever was picked before it.
  useEffect(() => {
    if (!drill) return;
    // A total drills with no account: every line of the period (Charmi, 10/02).
    setAccount(drill.account ? { code: drill.account, name: drill.accountName } : null);
    // A vendor, customer or employee column drills into that party; a
    // department column into that department (the Department filter box).
    setDropped([]);
    setParty(drill.party || applied.party); setJournal(''); setBook(drill.book && drill.book !== 'both' ? drill.book : 'accrual'); setScope('period');
    setTyped(drill.department ? { department: drill.department } : {});
  }, [drill]); // eslint-disable-line react-hooks/exhaustive-deps
  // A single vendor / customer / employee on the report follows into the search.
  useEffect(() => { setParty(drill?.party || applied.party); }, [applied.party?.kind, applied.party?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const usePeriod = scope === 'period' && drill;
  const params = useMemo(() => ({
    q: term || undefined,
    ...applied.place,
    from: usePeriod ? drill.from : undefined,
    to: usePeriod ? drill.to : undefined,
    party_kind: party?.kind,
    party: party?.code,
    account: account?.code,
    journal: journal || undefined,
    book: book === 'all' ? undefined : book,
    cols: cols || undefined,
    ...(opQs ? JSON.parse(opQs) : {}),
  }), [term, applied.place, usePeriod, drill, party, account, journal, book, cols, opQs]);

  const hasCriteria = (term || '').trim().length >= 2 || !!party || !!account || !!journal || !!usePeriod;

  useEffect(() => { setPage(0); }, [params]);
  const lastSync = useRef(syncTick);

  useEffect(() => {
    if (!hasCriteria) { setData(null); setError(''); setLoading(false); return; }
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    // 10/23 meeting, item 13: the toolbar's Sync (syncTick) reads these lines
    // again past the server's cache; the rows on screen stay until they land.
    const read = () => api.searchAccountingLedger({ ...params, offset: page * PAGE, limit: PAGE });
    const fresh = syncTick !== lastSync.current;
    lastSync.current = syncTick;
    (fresh ? withFreshReads(read) : read())
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) { setData(null); setError(e?.message || 'Could not search the ledger.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [params, page, hasCriteria, syncTick]); // eslint-disable-line react-hooks/exhaustive-deps
  // The toolbar's search box shows the spinner while this is working.
  useEffect(() => { onBusy?.(loading); return () => onBusy?.(false); }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // The ledger echoes every operator it applied (`cols.debit_cmp`); only the
  // rest are checked here, on the lines loaded.
  const opFilters = opFiltersAll.filter(({ c }) => !data?.cols?.[`${c.key}_cmp`]);
  const opKey = JSON.stringify(opFilters.map(({ c, f }) => [c.key, f]));
  const passesOps = (r) => opFilters.every(({ c, f }) => numberFilterHit(Number(r[c.key]) || 0, f));
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  // 10/23 meeting, item 01 (Viral, 06:05: "instead of that [Narrow by], can
  // we do filters here similar to Excel table?"): once a filter, a value
  // list or a sort of the standard view is in use, EVERY line of the search
  // is read (1,000 at a time, ALL_CAP at most), so the filters, the totals
  // and the pages cover all of them - not just the 100 on the page.
  const readKey = JSON.stringify([params, syncTick]);
  const [all, setAll] = useState(null);              // { key, rows, error } - every line, once read
  const [allDone, setAllDone] = useState(0);         // lines read so far
  // One of the view's panels was opened for this search (a new search starts without).
  const searchKey = JSON.stringify(params);
  const [wantKey, setWantKey] = useState('');
  const wantAll = wantKey === searchKey;
  const reading = useRef('');
  const allSync = useRef(syncTick);
  const allHere = !!all && all.key === readKey && !all.error;
  // The ledger narrows the lines by the report's filters (10/07); one that
  // does not yet hands back lines of other payees - those are left out here.
  // The balance runs over every line of the drill-down, so it waits for all
  // of them: one page that holds the whole result, or every page read.
  const linesAll = allHere || (!!data && (data.rows || []).length >= (Number(data.total) || 0));
  const loaded = useMemo(() => {
    const got = allHere ? all.rows : data?.rows || [];
    return balanceOn && linesAll ? withBalance(got) : got;
  }, [allHere, all, data, balanceOn, linesAll]);
  const dimsMissed = !!effectiveDims && loaded.some((l) => !lineMatchesDims(l, effectiveDims));
  const base = useMemo(() => loaded.filter((l) => (!dimsMissed || lineMatchesDims(l, effectiveDims)) && passesOps(l)), [loaded, dimsMissed, effectiveDims, opKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The boxes the ledger cannot apply (Memo, Project-Job, Item), checked here.
  const boxed = useMemo(() => filterRowsByColumns(base, typed, LOCAL_FILTERS), [base, typed]);
  const view = useTableView('ledger-lines', viewColumns, boxed, { onOpen: () => setWantKey(searchKey) });
  const viewOn = view.count > 0;
  const narrowed = viewOn || localOn;     // the lines on screen are fewer than the search's
  const engaged = narrowed || !!view.state.sort || wantAll || balanceOn;
  // Everything is on screen already: the search fits on its first page, or all of it was read.
  const complete = allHere || (!!data && (data.rows || []).length >= total);
  const capped = engaged && total > ALL_CAP;
  useEffect(() => {
    if (!engaged || complete || !data || !hasCriteria || reading.current === readKey) return undefined;
    const key = readKey;
    reading.current = key;
    let alive = true;
    // After the table's Sync these reads go past the server's cache too (item 13).
    const fresh = allSync.current !== syncTick;
    allSync.current = syncTick;
    setAllDone(0);
    (async () => {
      const got = [];
      for (let offset = 0; offset < Math.min(total, ALL_CAP); offset += 1000) {
        const read = () => api.searchAccountingLedger({ ...params, offset, limit: 1000 });
        const d = await (fresh ? withFreshReads(read) : read());
        if (!alive) return;
        const batch = d?.rows || [];
        got.push(...batch);
        setAllDone(got.length);
        if (batch.length < 1000) break;
      }
      if (alive) setAll({ key, rows: got });
    })()
      .catch((e) => { if (alive) setAll({ key, rows: [], error: e?.message || 'Could not read every line.' }); })
      .finally(() => { if (alive && reading.current === key) reading.current = ''; });
    return () => { alive = false; if (reading.current === key) reading.current = ''; };
  }, [engaged, complete, readKey, data, hasCriteria]); // eslint-disable-line react-hooks/exhaustive-deps
  const readingAll = engaged && !complete && !!data && !(all && all.key === readKey);

  // The lines on screen: the client pages them once everything is here, the
  // ledger does while it is not (paging on the server, as before).
  const paged = usePaged(complete ? view.rows : [], PAGE, [readKey, view.state]);
  const rows = complete ? paged.rows : view.rows;
  const sum = (key) => Math.round(view.rows.reduce((s, r) => s + (Number(r[key]) || 0), 0) * 100) / 100;
  // The figures over the lines: the view's own once it filters (Viral, 07:00:
  // "You can adjust the totals here"), else the ledger's for the whole search.
  const lineTotals = narrowed && complete ? { lines: view.rows.length, debit: sum('debit'), credit: sum('credit') } : { lines: total, debit: Number(data?.debit) || 0, credit: Number(data?.credit) || 0 };
  // The Balance column's total is where the balance ends: the lines' net.
  const shownTotals = { ...lineTotals, balance: balanceOn && linesAll ? Math.round((lineTotals.debit - lineTotals.credit) * 100) / 100 : null };
  const lastPage = complete ? paged.page >= paged.pages : page + 1 >= pages;

  const columns = view.columns;
  const manualWidth = (c) => !!(view.state.widths[c.key] || layout.widths?.[c.key]);
  const natural = columns.reduce((s, c) => s + c.width, 0);
  const fillers = columns.filter((c) => !c.num && !manualWidth(c) && !['date', 'entry', 'journal'].includes(c.key));
  const spare = fillers.length ? Math.max(0, room - natural - ASK_WIDTH - 2) : 0;
  const colWidth = (c) => c.width + (fillers.includes(c) ? Math.floor(spare / fillers.length) : 0);
  const tableWidth = natural + Math.floor(spare / Math.max(1, fillers.length)) * fillers.length + ASK_WIDTH;

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 10, boxShadow: 'var(--shadow-sm)' };
  const select = { height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.78rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)' };

  const heading = [term ? `"${term}"` : null, party ? partyText(party) : null, account ? `${account.code} ${account.name || ''}`.trim() : drill && !drill.account && drill.accountName ? `${drill.accountName} - Every Line` : null].filter(Boolean).join(' - ') || 'Ledger Lines';
  const periodText = usePeriod ? `${drill.from ? formatDate(drill.from) : 'Start'} - ${formatDate(drill.to)}` : 'All Dates';
  const labelAt = columns.findIndex((c) => !c.num);

  // Oct 2 (Charmi): one Export, the report's own at the top. The lines hand it
  // a builder for the WHOLE result (walked 1,000 at a time, up to EXPORT_CAP),
  // in the columns on screen and their order, amounts as numbers. 10/24 (item
  // 01): exactly what the view leaves - its filters, its sort, its columns.
  const exportKey = JSON.stringify([params, columns.map((c) => [c.key, c.width]), total, heading, periodText, entityName, book, opKey, localKey, view.state]);
  useEffect(() => {
    if (!onExport) return undefined;
    if (!total) { onExport(null); return undefined; }
    const state = view.state;
    const local = typed;
    const build = async () => {
      const got = [];
      for (let offset = 0; offset < Math.min(total, EXPORT_CAP); offset += 1000) {
        const d = await api.searchAccountingLedger({ ...params, offset, limit: 1000 });
        got.push(...(d?.rows || []).filter((l) => (!effectiveDims || lineMatchesDims(l, effectiveDims)) && passesOps(l)));
      }
      const kept = applyView(filterRowsByColumns(balanceOn ? withBalance(got) : got, local, LOCAL_FILTERS), viewColumns, state);
      const firstNum = columns.findIndex((c) => c.num);
      const labelAt = columns.findIndex((c) => !c.num);
      const net = (r) => (Number(r.debit) || 0) - (Number(r.credit) || 0);
      const sums = Object.fromEntries(columns.filter((c) => c.num).map((c) => [c.key, kept.reduce((n, r) => n + (c.key === 'balance' ? net(r) : Number(r[c.key]) || 0), 0)]));
      return {
        title: `Ledger Lines - ${heading}`,
        period: periodText.replace(/\//g, '-'),
        subtitle: [entityName, periodText, book === 'all' ? 'All Books' : bookTitle(book), `${kept.length.toLocaleString('en-US')} lines`].filter(Boolean).join(' · '),
        columns: columns.map((c) => ({ label: c.label, num: !!c.num, width: colWidth(c) })),
        rows: kept.map((r) => columns.map((c) => (c.num ? (Number(r[c.key]) || 0) : c.text(r)))),
        totals: firstNum >= 0 ? columns.map((c, i) => (c.num ? Math.round(sums[c.key] * 100) / 100 : i === labelAt ? `Totals - ${kept.length.toLocaleString('en-US')} lines` : '')) : null,
        capped: total > EXPORT_CAP,
      };
    };
    onExport({ build, lines: total, name: linesBaseName({ title: `Ledger Lines - ${heading}`, period: periodText.replace(/\//g, '-') }), title: `Ledger Lines - ${heading}` });
    return undefined;
  }, [exportKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onExport?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={card}>
      <style>{FILTER_CSS}</style>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        {/* A journal page (Records > Journals) is the lines themselves: no report to go back to. */}
        {onClose && (
          <button type="button" className="secondary-btn" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', padding: '4px 10px' }}>
            <ArrowLeft size={14} /> {backLabel || 'Back to Report'}
          </button>
        )}
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '0.98rem', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heading}</h3>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
            {entityName} · {periodText} · {book === 'all' ? 'All Books' : bookTitle(book)}{loading ? (data ? ' · updating' : ' · searching') : ''}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {drill && (
            <select value={scope} onChange={(e) => setScope(e.target.value)} style={select} aria-label="Dates">
              <option value="period">Report Period</option>
              <option value="all">All Dates</option>
            </select>
          )}
          <select value={book} onChange={(e) => setBook(e.target.value)} style={select} aria-label="Book">
            <option value="all">All Books</option>
            {/* Every single book a report reads (10/15), the drill's own book included. */}
            {[...bookOptions({ report: 'general-ledger' }), ...(book !== 'all' && !bookOptions({ report: 'general-ledger' }).some((b) => b.key === book) ? [{ key: book }] : [])]
              .map((b) => <option key={b.key} value={b.key}>{bookTitle(b.key)}</option>)}
          </select>
          {/* 10/23 meeting, item 01: the standard view - View, Filters, Columns. */}
          <TableViewBar view={view} columns={!isPhone} />
        </div>
      </div>

      {(party || account || journal || filtering || applied.picked.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Narrowed to</span>
          {applied.picked.map((d) => (
            <ActiveChip key={d.key} label={dimChipText(d, dimNames)} onClear={() => setDropped((x) => [...x, d.key])} />
          ))}
          {party && !(applied.party && party.kind === applied.party.kind && party.code === applied.party.code) && (
            <ActiveChip label={`${party.kind === 'vendor' ? 'Vendor' : party.kind === 'employee' ? 'Employee' : 'Customer'}: ${partyText(party)}`} onClear={() => setParty(null)} />
          )}
          {account && <ActiveChip label={`Account: ${account.code} ${account.name || ''}`.trim()} onClear={() => { setAccount(null); if (drill) onClearDrill(); }} />}
          {journal && <ActiveChip label={`Journal: ${journal}`} onClear={() => setJournal('')} />}
          {LINE_FILTERS.filter((c) => columnFiltersActive([c], typed)).map((c) => (
            <ActiveChip key={c.key} label={c.num ? opText(c.label, { op: '=', ...typed[c.key] }) : `${c.label} contains ${typed[c.key].trim()}`}
              onClear={() => setFilter(c.key, c.num ? undefined : '')} />
          ))}
          {filtering && <button type="button" onClick={() => setTyped({})} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline' }}>Clear Column Filters</button>}
        </div>
      )}

      {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '10px 12px', fontSize: '0.85rem', marginBottom: 10 }}>{error}</div>}
      {asked && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border-color)', borderRadius: 8, padding: '6px 10px', fontSize: '0.8rem', marginBottom: 8, color: 'var(--ok-fg, #15803d)' }}>
          <span style={{ flex: 1 }}>{asked.merged ? 'Added to the open question on this line' : 'Question sent'} to {asked.accountantName || asked.accountant}.</span>
          <button type="button" className="secondary-btn" style={{ fontSize: '0.74rem', padding: '2px 10px' }}
            onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'accounting', sub: 'ama' } }))}>Open AMA</button>
          <button type="button" onClick={() => setAsked(null)} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex' }}><X size={14} /></button>
        </div>
      )}

      {!hasCriteria ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '24px 0', textAlign: 'center', margin: 0 }}>
          Type at least two characters - a vendor or customer name, an invoice number, or an amount like 1,500.00.
        </p>
      ) : loading && !data ? (
        <div role="status" aria-live="polite">
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: 8 }}>Searching the ledger...</div>
          <SkeletonBlocks count={4} />
        </div>
      ) : data ? (
        <>
          {/* One line on a wide screen: the grid below is what the height is for.
              10/23 meeting, item 01: "Narrow by" is gone (Viral, 07:00: "So, this
              line will go") - the funnel on each heading and Filters do it, and
              the count and totals follow them. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 18px', fontSize: '0.8rem', marginBottom: 8, fontVariantNumeric: 'tabular-nums' }}>
            <span data-testid="ledger-lines-count">
              <strong>{shownTotals.lines.toLocaleString('en-US')}</strong>{narrowed && complete ? ` of ${base.length.toLocaleString('en-US')}` : ''} lines
            </span>
            <span>Debits <strong><Amount value={shownTotals.debit} /></strong></span>
            <span>Credits <strong><Amount value={shownTotals.credit} /></strong></span>
            <span>Net <strong style={{ color: shownTotals.debit - shownTotals.credit < 0 ? 'var(--bad-fg, #dc2626)' : undefined }}><Amount value={shownTotals.debit - shownTotals.credit} /></strong></span>
            {readingAll && (
              <span role="status" style={{ color: 'var(--text-secondary)' }}>
                Reading every line for the filters... {allDone.toLocaleString('en-US')} of {Math.min(total, ALL_CAP).toLocaleString('en-US')}
              </span>
            )}
            {complete && paged.pages > 1 && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                Lines {paged.from.toLocaleString('en-US')}-{paged.to.toLocaleString('en-US')}
                <button type="button" className="secondary-btn" disabled={paged.page <= 1} onClick={() => paged.setPage(paged.page - 1)} aria-label="Previous page" style={{ padding: '2px 6px' }}><ChevronLeft size={14} /></button>
                {paged.page} / {paged.pages}
                <button type="button" className="secondary-btn" disabled={paged.page >= paged.pages} onClick={() => paged.setPage(paged.page + 1)} aria-label="Next page" style={{ padding: '2px 6px' }}><ChevronRight size={14} /></button>
              </span>
            )}
            {!complete && total > PAGE && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                Lines {(page * PAGE + 1).toLocaleString('en-US')}-{Math.min(total, (page + 1) * PAGE).toLocaleString('en-US')}
                <button type="button" className="secondary-btn" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)} aria-label="Previous page" style={{ padding: '2px 6px' }}><ChevronLeft size={14} /></button>
                {page + 1} / {pages}
                <button type="button" className="secondary-btn" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)} aria-label="Next page" style={{ padding: '2px 6px' }}><ChevronRight size={14} /></button>
              </span>
            )}
          </div>

          {isPhone ? (
            <div className="acct-lines-wrap" style={{ maxHeight: 'none', opacity: loading ? 0.6 : 1 }}>
              {rows.map((r) => <LineCard key={r.line_id} r={r} onOpen={() => openLine(r)} />)}
              {rows.length === 0 && <div style={{ padding: 16, fontSize: '0.84rem', color: 'var(--text-secondary)', textAlign: 'center' }}>No lines on this page.</div>}
            </div>
          ) : (
          // Oct 23 (Viral, item 18): the lines scroll inside their own box, sized
          // to the window (a tall monitor still shows more), with the headings
          // pinned at its top - the page above them stays put.
          <div className={`acct-lines-wrap${full ? '' : ' acct-scroll-box'}`} ref={setWrap} data-testid="ledger-lines-box" style={{ opacity: loading ? 0.6 : 1, ...fitBox }}>
            <table className="acct-lines acct-sticky-head" style={{ width: tableWidth, '--acct-row-py': DENSITY_PY[prefs.density] || DENSITY_PY.compact }}>
              <colgroup>{columns.map((c) => <col key={c.key} style={{ width: colWidth(c) }} />)}<col style={{ width: ASK_WIDTH }} /></colgroup>
              <thead>
                <tr>
                  {columns.map((c) => <ViewHead key={c.key} view={view} col={c} className={c.num ? 'acct-num' : undefined} />)}
                  <th scope="col" aria-label="Ask My Accountant" />
                </tr>
                <ColumnFilterRow columns={[...columns, ASK_CELL]} filterColumns={LINE_FILTERS} typed={typed} onChange={setFilter} />
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line_id} className={r.entry_id ? `acct-line-opens${openEntry?.line === r.line_id ? ' is-open' : ''}` : undefined}
                    onClick={r.entry_id ? (e) => { if (!e.target.closest('button, a, input, select')) openLine(r); } : undefined}
                    title={r.entry_id ? 'Open the transaction behind this line' : undefined}>
                    {columns.map((c) => {
                      const text = c.text(r);
                      if (c.key === 'entry' && r.entry_id) {
                        return (
                          <td key={c.key} title={text}>
                            <button type="button" className="acct-drill" onClick={() => openLine(r)} title="Open this journal entry">{text || 'Open'}</button>
                          </td>
                        );
                      }
                      if (c.key === 'account') {
                        return <td key={c.key} title={text}><span className="acct-code">{r.gl_code}</span>{r.account_name}</td>;
                      }
                      if (c.key === 'balance') return <td key={c.key} className="acct-num">{r.balance == null ? '' : <Amount value={r.balance} />}</td>;
                      return <td key={c.key} className={c.num ? 'acct-num' : undefined} title={c.num ? undefined : text}>{c.num ? <Amount value={r[c.key]} zero="blank" /> : text}</td>;
                    })}
                    <td style={{ textAlign: 'center', padding: 0 }}><AskButton onClick={() => setAsking(lineFromSearch(r))} /></td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={columns.length + 1} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '22px 10px', whiteSpace: 'normal' }}>
                    {loaded.length ? 'None of the lines loaded here pass' : 'Nothing in the ledger matches'}{filtering || viewOn ? ' these filters' : ' all of that'}{entities.length ? ' for the entities picked' : ''}. {filtering || viewOn ? 'Clear a filter' : 'Remove a word or a filter'} to widen the search.
                  </td></tr>
                )}
                {rows.length > 0 && lastPage && (
                  <tr className="acct-grand">
                    {columns.map((c, i) => (c.num
                      ? <td key={c.key} className="acct-num">{shownTotals[c.key] == null ? '' : <Amount value={shownTotals[c.key]} />}</td>
                      : <td key={c.key} style={i === labelAt ? { overflow: 'visible' } : undefined}>{i === labelAt ? `Totals - ${shownTotals.lines.toLocaleString('en-US')} lines` : ''}</td>))}
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          )}
          {(opFilters.length > 0 || dimsMissed) && (
            <div role="note" style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {opFilters.length > 0 && `${opFilters.map(({ c, f }) => opText(c.label, f)).join(', ')} ${total > PAGE ? `is checked on the ${loaded.length.toLocaleString('en-US')} lines loaded on this page, not the whole search` : 'is checked on the lines loaded here'}: ${rows.length.toLocaleString('en-US')} of ${loaded.length.toLocaleString('en-US')} pass. `}
              {dimsMissed && 'The ledger did not narrow these lines by every report filter, so lines that do not match are left out here. '}
              The line count and totals above are for the whole search{opFilters.length > 0 ? '; the export applies the same filter to every line' : ''}.
            </div>
          )}
          {balanceOn && !linesAll && !readingAll && columns.some((c) => c.key === 'balance') && (
            <div role="note" style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              The Balance column fills in once every line of this drill-down is read.
            </div>
          )}
          {capped && (
            <div role="note" style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              The filters, sort and totals cover the first {ALL_CAP.toLocaleString('en-US')} of {total.toLocaleString('en-US')} lines. Narrow the search for the rest.
            </div>
          )}
          {all?.error && all.key === readKey && (
            <div role="alert" style={{ marginTop: 8, fontSize: '0.78rem', color: 'var(--bad-fg, #dc2626)' }}>{all.error} The filters cover the lines on this page only.</div>
          )}
          {total > EXPORT_CAP && (
            <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              The export holds the first {EXPORT_CAP.toLocaleString('en-US')} lines. Narrow the search for a complete file.
            </div>
          )}
        </>
      ) : null}
      {/* Keyed by entry: another line swaps the panel to its transaction. */}
      {openEntry && <EntryDetail key={openEntry.id} entryId={openEntry.id} entryNo={openEntry.no} onClose={closeEntry} panel />}
      {asking && <AskAccountantDialog line={asking} onClose={() => setAsking(null)} onAsked={(t) => { setAsking(null); setAsked(t); }} />}
    </div>
  );
}
