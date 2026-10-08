import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Columns3, X } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate } from '../../lib/datetime';
import { useIsMobile } from '../../lib/useIsMobile';
import EntryDetail from './EntryDetail';
import Amount from './Amount';
import { useAccountingPrefs } from './prefs';
import { PopoverPanel, usePopover } from './reportControls';
import { linesBaseName } from './linesExport';
import { DIM_KINDS, NUM_OPS, glLineParams, lineMatchesDims, numberFilterHit, parseFigure } from './reportModel';

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

const PAGE = 100;
const EXPORT_CAP = 10000;

const money = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.005) return '';
  return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const signed = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${s})` : s;
};
const named = (name, id) => name || id || '';

// Every column the grid can show. `filter`: the server can narrow by it.
// `off`: hidden until the person turns it on.
export const LINE_COLUMNS = [
  { key: 'date', label: 'Date', width: 96, filter: true, text: (r) => formatDate(r.entry_date) },
  { key: 'entry', label: 'Entry', width: 108, filter: true, text: (r) => r.entry_no || '' },
  { key: 'doc', label: 'Doc No', width: 120, filter: true, off: true, text: (r) => r.doc || '' },
  { key: 'account', label: 'Account', width: 250, filter: true, text: (r) => `${r.gl_code} ${r.account_name}`.trim() },
  { key: 'description', label: 'Description', width: 300, filter: true, text: (r) => r.description || '' },
  { key: 'memo', label: 'Memo', width: 240, off: true, text: (r) => r.memo || '' },
  { key: 'entity', label: 'Entity', width: 190, filter: true, text: (r) => r.location_name || r.location || '' },
  { key: 'department', label: 'Department', width: 170, filter: true, off: true, text: (r) => named(r.department_name, r.department) },
  { key: 'vendor', label: 'Vendor', width: 180, filter: true, text: (r) => named(r.vendor_name, r.vendor_id) },
  { key: 'customer', label: 'Customer', width: 180, filter: true, text: (r) => named(r.customer_name, r.customer_id) },
  { key: 'employee', label: 'Employee', width: 170, filter: true, off: true, text: (r) => named(r.employee_name, r.employee_id) },
  { key: 'project', label: 'Project-Job', width: 180, off: true, text: (r) => named(r.project_name, r.project_id) },
  { key: 'item', label: 'Item', width: 160, off: true, text: (r) => named(r.item_name, r.item_id) },
  { key: 'journal', label: 'Journal', width: 88, filter: true, text: (r) => r.journal || '' },
  { key: 'debit', label: 'Debit', width: 118, num: true, filter: true, text: (r) => money(r.debit) },
  { key: 'credit', label: 'Credit', width: 118, num: true, filter: true, text: (r) => money(r.credit) },
];
const MIN_WIDTH = 60;
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
  const party = named(r.vendor_name, r.vendor_id) || named(r.customer_name, r.customer_id) || named(r.employee_name, r.employee_id);
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

// A dropdown only earns its place when picking from it narrows the result:
// one vendor behind EVERY matching line is not a choice, one vendor behind
// some of them is (Neil: "as a vendor, not as an employee"). Dropdowns, not
// chips (Charmi, 09/29 call: the rows of chips read as clutter).
function FacetSelect({ label, items, total, onPick, text }) {
  if (!items?.length || (items.length === 1 && items[0].lines >= total)) return null;
  return (
    <select value="" aria-label={label} onChange={(e) => { const f = items.find((x) => x.code === e.target.value); if (f) onPick(f); }}
      style={{ ...facetSelect }}>
      <option value="">{label} ({items.length})</option>
      {items.map((f) => {
        const name = text ? text(f) : (f.name || f.code);
        return <option key={f.code} value={f.code}>{name} - {f.lines.toLocaleString('en-US')} lines, net {signed(f.net)}</option>;
      })}
    </select>
  );
}
const facetSelect = { height: 28, padding: '0 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.76rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)', maxWidth: 260 };

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

export default function LedgerSearch({ term, entities = [], entityName, drill, onClearDrill, onClose, onBusy, onExport, dims = null, dimNames = null, full = false }) {
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
  const seq = useRef(0);

  // The person's own layout: which columns show and how wide.
  const [prefs, setPrefs] = useAccountingPrefs();
  const layout = prefs.lines || {};
  const visible = (c) => layout.visible?.[c.key] ?? !c.off;
  const widthOf = (c) => Math.max(MIN_WIDTH, Number(layout.widths?.[c.key]) || c.width);
  const shownColumns = LINE_COLUMNS.filter(visible);
  const setLayout = (p) => setPrefs({ lines: { ...layout, ...p } });
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
  const natural = shownColumns.reduce((s, c) => s + widthOf(c), 0);
  const fillers = shownColumns.filter((c) => !c.num && !layout.widths?.[c.key] && !['date', 'entry', 'journal'].includes(c.key));
  const spare = fillers.length ? Math.max(0, room - natural - 2) : 0;
  const columns = shownColumns;
  const colWidth = (c) => widthOf(c) + (fillers.includes(c) ? Math.floor(spare / fillers.length) : 0);
  const tableWidth = natural + Math.floor(spare / Math.max(1, fillers.length)) * fillers.length;

  // The filter boxes. What is typed waits a moment before the ledger is asked.
  // An amount column's box is { op, a, b } (the Reports tables' operators);
  // its "=" goes to the server like any typed text, and the other operators
  // go as debit_op / credit_op so the ledger's totals and paging follow them
  // (10/07). A ledger that does not know them yet is caught below: the lines
  // it hands back are checked here instead.
  const [typed, setTyped] = useState({});
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
  const filtering = LINE_COLUMNS.some((c) => (c.num ? opSet(typed[c.key]) : String(typed[c.key] || '').trim()));
  const opFiltersAll = LINE_COLUMNS.filter((c) => c.num && opSet(typed[c.key]) && (typed[c.key].op || '=') !== '=').map((c) => ({ c, f: typed[c.key] }));

  // A new drill-down replaces whatever was picked before it.
  useEffect(() => {
    if (!drill) return;
    // A total drills with no account: every line of the period (Charmi, 10/02).
    setAccount(drill.account ? { code: drill.account, name: drill.accountName } : null);
    // A vendor, customer or employee column drills into that party; a
    // department column into that department (the Department filter box).
    setDropped([]);
    setParty(drill.party || applied.party); setJournal(''); setBook(drill.book === 'cash' ? 'cash' : 'accrual'); setScope('period');
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

  useEffect(() => {
    if (!hasCriteria) { setData(null); setError(''); setLoading(false); return; }
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    api.searchAccountingLedger({ ...params, offset: page * PAGE, limit: PAGE })
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) { setData(null); setError(e?.message || 'Could not search the ledger.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [params, page, hasCriteria]);
  // The toolbar's search box shows the spinner while this is working.
  useEffect(() => { onBusy?.(loading); return () => onBusy?.(false); }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // The ledger echoes every operator it applied (`cols.debit_cmp`); only the
  // rest are checked here, on the lines loaded.
  const opFilters = opFiltersAll.filter(({ c }) => !data?.cols?.[`${c.key}_cmp`]);
  const passesOps = (r) => opFilters.every(({ c, f }) => numberFilterHit(Number(r[c.key]) || 0, f));
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  // The ledger narrows the lines by the report's filters (10/07); one that
  // does not yet hands back lines of other payees - those are left out here.
  const loaded = data?.rows || [];
  const dimsMissed = !!effectiveDims && loaded.some((l) => !lineMatchesDims(l, effectiveDims));
  const rows = loaded.filter((l) => (!dimsMissed || lineMatchesDims(l, effectiveDims)) && passesOps(l));
  const facets = data?.facets || {};

  // Drag a column's right edge to resize it; double-click puts it back.
  const startResize = (c, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidth(c);
    const move = (ev) => setLayout({ widths: { ...(layout.widths || {}), [c.key]: Math.max(MIN_WIDTH, Math.round(startW + ev.clientX - startX)) } });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const resetWidth = (c) => { const w = { ...(layout.widths || {}) }; delete w[c.key]; setLayout({ widths: w }); };

  const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 10, boxShadow: 'var(--shadow-sm)' };
  const select = { height: 30, padding: '0 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: '0.78rem', fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-primary)' };

  const heading = [term ? `"${term}"` : null, party?.name, account ? `${account.code} ${account.name || ''}`.trim() : drill && !drill.account && drill.accountName ? `${drill.accountName} - every line` : null].filter(Boolean).join(' - ') || 'Ledger lines';
  const periodText = usePeriod ? `${drill.from ? formatDate(drill.from) : 'Start'} - ${formatDate(drill.to)}` : 'All dates';
  const labelSpan = columns.filter((c) => !c.num).length;

  // Oct 2 (Charmi): one Export, the report's own at the top. The lines hand it
  // a builder for the WHOLE result (walked 1,000 at a time, up to EXPORT_CAP),
  // in the columns on screen and their order, amounts as numbers.
  const exportKey = JSON.stringify([params, columns.map((c) => c.key), total, heading, periodText, entityName, book, opFilters.map(({ c, f }) => [c.key, f])]);
  useEffect(() => {
    if (!onExport) return undefined;
    if (!total) { onExport(null); return undefined; }
    const build = async () => {
      const all = [];
      for (let offset = 0; offset < Math.min(total, EXPORT_CAP); offset += 1000) {
        const d = await api.searchAccountingLedger({ ...params, offset, limit: 1000 });
        all.push(...(d?.rows || []).filter((l) => (!effectiveDims || lineMatchesDims(l, effectiveDims)) && passesOps(l)));
      }
      const firstNum = columns.findIndex((c) => c.num);
      const sums = Object.fromEntries(columns.filter((c) => c.num).map((c) => [c.key, all.reduce((n, r) => n + (Number(r[c.key]) || 0), 0)]));
      return {
        title: `Ledger Lines - ${heading}`,
        period: periodText.replace(/\//g, '-'),
        subtitle: [entityName, periodText, book === 'all' ? 'all books' : `${book} book`, `${all.length.toLocaleString('en-US')} lines`].filter(Boolean).join(' · '),
        columns: columns.map((c) => ({ label: c.label, num: !!c.num, width: colWidth(c) })),
        rows: all.map((r) => columns.map((c) => (c.num ? (Number(r[c.key]) || 0) : c.text(r)))),
        totals: firstNum > 0 ? columns.map((c, i) => (c.num ? Math.round(sums[c.key] * 100) / 100 : i === 0 ? `Totals - ${all.length.toLocaleString('en-US')} lines` : '')) : null,
        capped: total > EXPORT_CAP,
      };
    };
    onExport({ build, lines: total, name: linesBaseName({ title: `Ledger Lines - ${heading}`, period: periodText.replace(/\//g, '-') }), title: `Ledger Lines - ${heading}` });
    return undefined;
  }, [exportKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onExport?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button type="button" className="secondary-btn" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', padding: '4px 10px' }}>
          <ArrowLeft size={14} /> Back to Report
        </button>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '0.98rem', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{heading}</h3>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
            {entityName} · {periodText} · {book === 'all' ? 'all books' : `${book} book`}{loading ? (data ? ' · updating' : ' · searching') : ''}
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
            <option value="accrual">Accrual Book</option>
            <option value="cash">Cash Book</option>
          </select>
          {!isPhone && <ColumnChooser layout={layout} visible={visible} onChange={setLayout} />}
        </div>
      </div>

      {(party || account || journal || filtering || applied.picked.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Narrowed to</span>
          {applied.picked.map((d) => (
            <ActiveChip key={d.key} label={dimChipText(d, dimNames)} onClear={() => setDropped((x) => [...x, d.key])} />
          ))}
          {party && !(applied.party && party.kind === applied.party.kind && party.code === applied.party.code) && (
            <ActiveChip label={`${party.kind === 'vendor' ? 'Vendor' : party.kind === 'employee' ? 'Employee' : 'Customer'}: ${party.name}`} onClear={() => setParty(null)} />
          )}
          {account && <ActiveChip label={`Account: ${account.code} ${account.name || ''}`.trim()} onClear={() => { setAccount(null); if (drill) onClearDrill(); }} />}
          {journal && <ActiveChip label={`Journal: ${journal}`} onClear={() => setJournal('')} />}
          {LINE_COLUMNS.filter((c) => (c.num ? opSet(typed[c.key]) : String(typed[c.key] || '').trim())).map((c) => (
            <ActiveChip key={c.key} label={c.num ? opText(c.label, { op: '=', ...typed[c.key] }) : `${c.label} contains ${typed[c.key].trim()}`}
              onClear={() => setTyped((t) => ({ ...t, [c.key]: c.num ? undefined : '' }))} />
          ))}
          {filtering && <button type="button" onClick={() => setTyped({})} style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline' }}>Clear column filters</button>}
        </div>
      )}

      {error && <div style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '10px 12px', fontSize: '0.85rem', marginBottom: 10 }}>{error}</div>}

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
          {/* One line on a wide screen: the grid below is what the height is for. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 18px', fontSize: '0.8rem', marginBottom: 8, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Narrow by</span>
              {!party && <FacetSelect label="Vendors" total={total} items={facets.vendors} onPick={(f) => setParty({ kind: 'vendor', code: f.code, name: f.name || f.code })} />}
              {!party && <FacetSelect label="Customers" total={total} items={facets.customers} onPick={(f) => setParty({ kind: 'customer', code: f.code, name: f.name || f.code })} />}
              {!account && <FacetSelect label="Accounts" total={total} items={facets.accounts} text={(f) => `${f.code} ${f.name || ''}`} onPick={(f) => setAccount({ code: f.code, name: f.name })} />}
              {!journal && <FacetSelect label="Journals" total={total} items={facets.journals} onPick={(f) => setJournal(f.code)} />}
            </span>
            <span><strong>{total.toLocaleString('en-US')}</strong> lines</span>
            <span>Debits <strong><Amount value={data.debit} /></strong></span>
            <span>Credits <strong><Amount value={data.credit} /></strong></span>
            <span>Net <strong style={{ color: data.debit - data.credit < 0 ? 'var(--bad-fg, #dc2626)' : undefined }}><Amount value={data.debit - data.credit} /></strong></span>
            {total > PAGE && (
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
              {rows.map((r) => <LineCard key={r.line_id} r={r} onOpen={() => setOpenEntry({ id: r.entry_id, no: r.entry_no })} />)}
              {rows.length === 0 && <div style={{ padding: 16, fontSize: '0.84rem', color: 'var(--text-secondary)', textAlign: 'center' }}>No lines on this page.</div>}
            </div>
          ) : (
          // No box of its own in a window: the page scrolls, and a tall monitor shows that many more lines (Charmi, 10/02).
          <div className="acct-lines-wrap" ref={setWrap} style={{ opacity: loading ? 0.6 : 1, ...(full ? {} : { maxHeight: 'none' }) }}>
            <table className="acct-lines" style={{ width: tableWidth, '--acct-row-py': DENSITY_PY[prefs.density] || DENSITY_PY.compact }}>
              <colgroup>{columns.map((c) => <col key={c.key} style={{ width: colWidth(c) }} />)}</colgroup>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={c.num ? 'acct-num' : undefined} scope="col">
                      {c.label}
                      <span role="separator" aria-orientation="vertical" aria-label={`Resize the ${c.label} column`} title="Drag to resize · double-click to reset"
                        className="acct-resize" onPointerDown={(e) => startResize(c, e)} onDoubleClick={() => resetWidth(c)} />
                    </th>
                  ))}
                </tr>
                <tr className="acct-filter-row">
                  {columns.map((c) => (
                    <th key={c.key}>
                      {c.filter && c.num ? (
                        <OpFilter label={c.label} value={typed[c.key]} onChange={(v) => setTyped((t) => ({ ...t, [c.key]: v }))} />
                      ) : c.filter ? (
                        <input type="text" value={typed[c.key] || ''} onChange={(e) => setTyped((t) => ({ ...t, [c.key]: e.target.value }))}
                          aria-label={`Filter ${c.label}`} placeholder={c.key === 'date' ? 'MM/DD/YYYY' : 'contains'} />
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line_id}>
                    {columns.map((c) => {
                      const text = c.text(r);
                      if (c.key === 'entry' && r.entry_id) {
                        return (
                          <td key={c.key} title={text}>
                            <button type="button" className="acct-drill" onClick={() => setOpenEntry({ id: r.entry_id, no: r.entry_no })} title="Open this journal entry">{text || 'Open'}</button>
                          </td>
                        );
                      }
                      if (c.key === 'account') {
                        return <td key={c.key} title={text}><span className="acct-code">{r.gl_code}</span>{r.account_name}</td>;
                      }
                      return <td key={c.key} className={c.num ? 'acct-num' : undefined} title={c.num ? undefined : text}>{c.num ? <Amount value={r[c.key]} zero="blank" /> : text}</td>;
                    })}
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={columns.length} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '22px 10px', whiteSpace: 'normal' }}>
                    {loaded.length ? 'None of the lines loaded here pass' : 'Nothing in the ledger matches'}{filtering ? ' these filters' : ' all of that'}{entities.length ? ' for the entities picked' : ''}. {filtering ? 'Clear a column filter' : 'Remove a word or a filter'} to widen the search.
                  </td></tr>
                )}
                {rows.length > 0 && page + 1 >= pages && (
                  <tr className="acct-grand">
                    {labelSpan > 0 && <td colSpan={labelSpan}>Totals - {total.toLocaleString('en-US')} lines</td>}
                    {columns.filter((c) => c.num).map((c) => <td key={c.key} className="acct-num"><Amount value={data[c.key]} /></td>)}
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
          {total > EXPORT_CAP && (
            <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              The export holds the first {EXPORT_CAP.toLocaleString('en-US')} lines. Narrow the search for a complete file.
            </div>
          )}
        </>
      ) : null}
      {openEntry && <EntryDetail entryId={openEntry.id} entryNo={openEntry.no} onClose={() => setOpenEntry(null)} />}
    </div>
  );
}

// The operator box under an amount column - the same control as the Reports
// tables' (ReportsTab, item 26d): =, >, <, >=, <=, Between and a value.
function OpFilter({ label, value, onChange }) {
  const v = value && typeof value === 'object' ? value : { op: '=', a: '', b: '' };
  return (
    <span className="acct-op-filter">
      <select value={v.op || '='} onChange={(e) => onChange({ ...v, op: e.target.value })} aria-label={`Operator for ${label}`} title="Compare with">
        {NUM_OPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      <input type="text" inputMode="decimal" value={v.a || ''} onChange={(e) => onChange({ ...v, a: e.target.value })} aria-label={`Filter ${label}`} placeholder="0.00" className="acct-num" />
      {v.op === 'between' && (
        <input type="text" inputMode="decimal" value={v.b || ''} onChange={(e) => onChange({ ...v, b: e.target.value })} aria-label={`Filter ${label} up to`} placeholder="and" className="acct-num" />
      )}
    </span>
  );
}

// Which columns show. The choice is the person's own and follows them.
function ColumnChooser({ layout, visible, onChange }) {
  const [open, setOpen, ref] = usePopover();
  const customized = Object.keys(layout.visible || {}).length > 0 || Object.keys(layout.widths || {}).length > 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="secondary-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', height: 30, padding: '0 10px' }}>
        <Columns3 size={14} /> Columns
      </button>
      <PopoverPanel anchor={ref} open={open} setOpen={setOpen} align="right" role="dialog" aria-label="Columns"
        style={{ width: 240, background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.12))', padding: 10 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Show these columns</div>
        <div style={{ display: 'grid', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
          {LINE_COLUMNS.map((c) => (
            <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', padding: '3px 4px', cursor: 'pointer' }}>
              <input type="checkbox" checked={visible(c)} onChange={(e) => onChange({ visible: { ...(layout.visible || {}), [c.key]: e.target.checked } })} />
              {c.label}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <button type="button" disabled={!customized} onClick={() => onChange({ visible: {}, widths: {} })}
            style={{ border: 'none', background: 'none', font: 'inherit', fontSize: '0.75rem', color: 'var(--text-muted)', cursor: customized ? 'pointer' : 'default', textDecoration: 'underline', opacity: customized ? 1 : 0.5, padding: 0 }}>
            Reset to default
          </button>
          <button type="button" className="primary-btn" style={{ fontSize: '0.75rem', padding: '3px 12px' }} onClick={() => setOpen(false)}>Done</button>
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>Your layout is saved for you on every computer.</div>
      </PopoverPanel>
    </div>
  );
}
