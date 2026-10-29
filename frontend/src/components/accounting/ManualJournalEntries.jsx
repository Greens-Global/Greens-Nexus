import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate, formatDateTime } from '../../lib/datetime';
import Amount, { formatAmount } from './Amount';
import EntryDetail from './EntryDetail';
import { BarMore, BarSearch, ControlBar, EntitiesPicker, ExportMenu, FiltersButton, PeriodStepper, SyncButton, control, fitSelect } from './reportControls';
import { DIM_KINDS, countDims, downloadBlob, resolveConfig } from './reportModel';
import { linesFile } from './linesExport';
import { useFitHeight } from './tableHooks';
import { TableViewBar, ViewHead, useTableView, viewTable } from './tableView';
import { useTableSync } from './tableSync';
import { cellStyle, headStyle } from './columnStyles';
import { ColumnFilterRow, ColumnFiltersEmpty, useColumnFilters } from './columnFilters';
import { filterColumnsOf } from './viewFilterColumns';
import { useAccountingPrefs } from './prefs';
import { MANUAL_JE_DEFAULT_PRESET, MANUAL_JE_GROUP_BY_USER } from './assumptions';

// Accounting -> Reports -> Audit & Insights -> Manual Journal Entries (Neil
// and Charmi, 10/22 call, CR-10: "I want Charmi to be able to audit anything
// that was done manual"). Only the journal entries a person keyed in Intacct
// - not the bank-feed and rule entries the system creates - with who created
// and last changed each one, read from Intacct's entry header by the server
// (routers/accounting_manual_je.py). A system entry a person later changed
// counts too, marked Changed by a Person (team answer, 23 Oct). Filters:
// period, entities, journals and user; group by user or sort any column.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const JOURNAL_KIND = DIM_KINDS.filter((k) => k.key === 'journals');
const stamp = (v) => {
  // Intacct answers MM/DD/YYYY HH:MM:SS; shown in the house format.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v || ''));
  if (!m) return String(v || '');
  return formatDateTime(new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)));
};
// Intacct's stamp in an order that sorts (YYYY-MM-DD HH:MM:SS).
const stampKey = (v) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v || ''));
  return m ? `${m[3]}-${m[1]}-${m[2]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}` : '';
};
// 10/23 meeting, item 01: the standard table view's columns - the date and
// the amount typed for the rules, the stamps sorting in time order, the
// newest entries first (as the header sort always started).
const MJE_COLUMNS = [
  { key: 'date', label: 'Date', width: 96, type: 'date', value: (r) => r.date || '', text: (r) => formatDate(r.date) },
  { key: 'journal', label: 'Journal', width: 80, text: (r) => r.journal || '' },
  { key: 'entry', label: 'Entry No.', width: 90, text: (r) => String(r.batchNo || '') },
  { key: 'entity', label: 'Entity', width: 130, text: (r) => (r.locations || []).join(', ') },
  { key: 'description', label: 'Description', width: 280, text: (r) => r.title || '' },
  { key: 'amount', label: 'Amount', width: 110, num: true, type: 'amount', total: true, value: (r) => Number(r.amount) || 0, text: (r) => formatAmount(r.amount) },
  { key: 'createdBy', label: 'Created By', width: 130, text: (r) => r.createdBy || '' },
  { key: 'postedBy', label: 'Posted / Changed By', width: 150, text: (r) => r.modifiedBy || '' },
  { key: 'created', label: 'Created', width: 160, text: (r) => stamp(r.whenCreated), sortBy: (r) => stampKey(r.whenCreated) },
  { key: 'posted', label: 'Posted / Changed', width: 160, text: (r) => stamp(r.whenModified), sortBy: (r) => stampKey(r.whenModified) },
  { key: 'state', label: 'State', width: 80, text: (r) => r.state || '' },
  { key: 'open', label: 'Open', width: 70, fixed: true, noFilter: true, noSort: true, exportAs: [], text: () => '' },
];
const MJE_SORT = { col: 'date', dir: 'desc' };
// Item 14 (Charmi, 10/26: "There should be search option for all"): the box
// under every heading - Amount compares (=, >, <, Between), the rest contain.
const MJE_FILTERS = filterColumnsOf(MJE_COLUMNS);

export default function ManualJournalEntries() {
  const [prefs] = useAccountingPrefs();
  const [config, setConfig] = useState(() => resolveConfig({ report: 'general-ledger', preset: MANUAL_JE_DEFAULT_PRESET }));
  const patch = (p) => setConfig((c) => resolveConfig({ ...c, ...p }));
  const [entities, setEntities] = useState([]);
  const [limited, setLimited] = useState(false);
  const [user, setUser] = useState('');
  const [edited, setEdited] = useState(true);
  const [grouped, setGrouped] = useState(MANUAL_JE_GROUP_BY_USER);
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ key: '', data: null, error: '' });
  const [opening, setOpening] = useState('');
  const [entry, setEntry] = useState(null);

  useEffect(() => {
    let alive = true;
    api.getAccountingLocations().then((d) => { if (alive) { setEntities(d?.entities || []); setLimited(!!d?.limited); } }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const journals = config.dims.journals || [];
  // 10/23 meeting, item 13: Sync reads the entries from Intacct again (ts.tick), nothing else.
  const ts = useTableSync();
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);   // item 05: the entries scroll inside their own box
  const key = JSON.stringify([config.from, config.to, config.entities, journals, user, edited, ts.tick]);
  useEffect(() => {
    let alive = true;
    ts.read(() => api.getManualJournalEntries({ from: config.from, to: config.to, locations: config.entities, journals, user, edited }))
      .then((d) => { if (alive) setRes({ key, data: d, error: '' }); })
      .catch((e) => { if (alive) setRes({ key, data: null, error: e?.message || 'Could not read the manual entries.' }); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const loading = res.key !== key;
  const data = res.data;

  const searched = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.entries || []).filter((r) => !words.length || words.every((w) => MJE_COLUMNS.map((c) => String(c.text(r))).join(' ').toLowerCase().includes(w)));
  }, [data, q]);
  // The standard view (item 01): its filters and sort; the groups and their
  // subtotals, the count, the total and the export follow it.
  const filters = useColumnFilters(searched, MJE_FILTERS);
  const view = useTableView('manual-je', MJE_COLUMNS, filters.rows, { sort: MJE_SORT });
  const rows = view.rows;
  const groups = useMemo(() => {
    if (!grouped) return [['', rows]];
    const m = new Map();
    rows.forEach((r) => { const who = r.kind === 'edited' ? r.modifiedBy : r.createdBy; if (!m.has(who)) m.set(who, []); m.get(who).push(r); });
    return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }, [rows, grouped]);
  const total = Math.round(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100;

  // The entry on the Nexus ledger copy: found by its journal, date and number.
  const open = async (r) => {
    setOpening(r.recordNo);
    try {
      const d = await api.searchAccountingLedger({ q: String(r.batchNo), journal: r.journal, from: r.date, to: r.date, limit: 50, offset: 0 });
      const hit = (d?.rows || []).find((l) => String(l.batch_no || l.entry_no) === String(r.batchNo)) || (d?.rows || [])[0];
      if (hit?.entry_id) setEntry({ id: hit.entry_id, no: hit.entry_no });
      else setRes((x) => ({ ...x, error: `Entry ${r.batchNo} is not on the Nexus ledger copy yet - it syncs from Intacct.` }));
    } catch (e) {
      setRes((x) => ({ ...x, error: e?.message || 'Could not open the entry.' }));
    } finally {
      setOpening('');
    }
  };

  const [busy, setBusy] = useState('');
  const exportAs = async (format) => {
    setBusy(format);
    try {
      const table = viewTable(rows, view.columns, {
        title: 'Manual Journal Entries', period: `${formatDate(config.from)} - ${formatDate(config.to)}`.replace(/\//g, '-'),
        subtitle: [`${formatDate(config.from)} - ${formatDate(config.to)}`, config.entities.length ? config.entities.join(', ') : 'All Entities', `${rows.length} entries`].join(' · '),
        totalLabel: 'Totals',
      });
      const file = await linesFile(table, format);
      downloadBlob(file.name, file);
    } finally {
      setBusy('');
    }
  };
  // A heading: the standard menu (sort, filter, width, move, hide) - item 01.
  const head = (c) => (c.key === 'open'
    ? <th key={c.key} aria-label="Open" style={{ width: 70 }} />
    : <ViewHead key={c.key} view={view} col={c} aria-label={c.label} style={headStyle(c.width, c.num ? { textAlign: 'right' } : null)} />);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10 }}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <PeriodStepper config={config} period="range" onChange={patch} />
        {/* Round 3 (UI test 10/24: two lines at 1100): Entities and the journal filter are the third to move into More, Sync the fourth, Export the fifth. */}
        <BarMore level={3} active={(config.entities.length ? 1 : 0) + (countDims(config.dims) ? 1 : 0)}>
        <EntitiesPicker entities={entities} value={config.entities} onChange={(codes) => patch({ entities: codes })} limited={limited} showHistorical={!!prefs.showHistoricalEntities} />
        <FiltersButton dims={config.dims} onChange={(d) => patch({ dims: d })} kinds={JOURNAL_KIND} label="Journals" />
        </BarMore>
        <BarMore level={2} active={user ? 1 : 0}>
        <select value={user} onChange={(e) => setUser(e.target.value)} aria-label="User" title={user || 'All Users'} style={{ ...control, ...fitSelect(user || 'All Users', { max: 200, base: 'All Users' }) }}>
          <option value="">All Users</option>
          {[...new Set([...(data?.users || []), ...(user ? [user] : [])])].map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        </BarMore>
        {/* 10/23 meeting, item 02 (fix 10/24): the two switches move into More on a narrow row; the search is an icon until used. */}
        <BarMore level={1} active={(edited ? 0 : 1) + (grouped === MANUAL_JE_GROUP_BY_USER ? 0 : 1)}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={edited} onChange={(e) => setEdited(e.target.checked)} /> Include system entries a person changed
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by user
        </label>
        </BarMore>
        <BarSearch value={q} onChange={setQ} label="Search the entries" placeholder="Search description, entry, user..." width={260} />
        <TableViewBar view={view} />
        <div className="acct-bar-end">
          <BarMore level={4}>
          <SyncButton onSync={ts.sync} busy={loading && !!data} syncedAt={ts.syncedAt} />
          </BarMore>
          <BarMore level={5}>
          <ExportMenu disabled={!rows.length} items={[
            { key: 'excel', label: 'Excel', hint: 'The entries on screen, live totals', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per entry', onPick: () => exportAs('csv'), busy: busy === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
          ]} />
          </BarMore>
        </div>
      </ControlBar>

      {data && data.available === false && (
        <div role="note" style={{ ...card, padding: 16, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Manual Journal Entries are not available here.</strong> {data.reason}
        </div>
      )}
      {data?.note && <div role="note" style={{ ...card, padding: 12, fontSize: '0.82rem', color: 'var(--warn-fg, #b45309)' }}>{data.note}</div>}
      {res.error && <div role="alert" style={{ ...card, padding: 12, color: 'var(--bad-fg, #dc2626)', fontSize: '0.84rem' }}>{res.error}</div>}
      {loading && !data && <div role="status" aria-label="Reading Intacct" style={{ ...card, padding: 12 }}><SkeletonBlocks count={5} /></div>}

      {data?.available && (
        <div style={{ ...card, padding: 0, overflow: 'hidden', opacity: loading ? 0.6 : 1 }}>
          <div style={{ padding: '8px 10px', fontSize: '0.78rem', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)' }}>
            <strong>{rows.length}</strong> manual {rows.length === 1 ? 'entry' : 'entries'} of {data.scanned} in {formatDate(data.from)} - {formatDate(data.to)} · Amount <strong><Amount value={total} /></strong>
            {' · '}Not manual: entries created by {(data.excludedUsers || []).join(', ') || 'system'} or by a bank-feed or other rule. Posted / Changed By is the last person to change or post the entry (Intacct&apos;s MODIFIEDBY); a rule&apos;s draft that a person only posted shows here as changed by that person.
          </div>
          <div className="req-table-wrapper acct-scroll-box" ref={setBox} data-testid="manual-je-box" style={fit}>
            <table className="req-table acct-sticky-head">
              <thead>
                <tr>{view.columns.map(head)}</tr>
                <ColumnFilterRow columns={view.columns} filterColumns={MJE_FILTERS} typed={filters.typed} onChange={filters.setFilter} />
              </thead>
              <tbody>
                {!rows.length && (filters.filtering
                  ? <ColumnFiltersEmpty colSpan={view.columns.length} onClear={filters.clear} style={{ padding: 16 }} />
                  : <tr><td colSpan={view.columns.length} style={{ padding: 16, color: 'var(--text-secondary)' }}>{view.count ? 'No entry passes the filters.' : 'No manual journal entries in this period.'}</td></tr>)}
                {groups.map(([who, list]) => [
                  grouped ? (
                    <tr key={`g-${who}`} className="acct-section"><td colSpan={view.columns.length} style={{ fontWeight: 700 }}>
                      {who} · {list.length} {list.length === 1 ? 'entry' : 'entries'} · <Amount value={Math.round(list.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100} />
                    </td></tr>
                  ) : null,
                  ...list.map((r) => (
                    <tr key={r.recordNo}>
                      {view.columns.map((c) => (c.key === 'open' ? (
                        <td key={c.key}>
                          <button type="button" className="secondary-btn" disabled={opening === r.recordNo} onClick={() => open(r)} aria-label={`Open entry ${r.batchNo}`}
                            style={{ fontSize: '0.72rem', padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>Open <ExternalLink size={11} /></button>
                        </td>
                      ) : (
                        <td key={c.key} style={cellStyle(c.width, c.num ? { textAlign: 'right' } : null)} title={c.text(r)}>
                          {/* Call of 10/27 with Charmi, item 17: the amount opens the entry behind it, as Open does. */}
                          {c.num ? <button type="button" className="acct-drill" disabled={opening === r.recordNo} onClick={() => open(r)} title="Open the entry behind this amount"><Amount value={c.value(r)} /></button> : c.text(r)}
                          {c.key === 'postedBy' && r.kind === 'edited' && <span style={{ marginLeft: 6, fontSize: '0.68rem', padding: '1px 6px', borderRadius: 999, background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)' }}>Changed by a Person</span>}
                        </td>
                      )))}
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {entry && <EntryDetail entryId={entry.id} entryNo={entry.no} onClose={() => setEntry(null)} />}
    </div>
  );
}
