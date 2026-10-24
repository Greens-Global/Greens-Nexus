import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Search } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { formatDate, formatDateTime } from '../../lib/datetime';
import Amount from './Amount';
import EntryDetail from './EntryDetail';
import { ColumnResizer, ControlBar, EntitiesPicker, ExportMenu, FiltersButton, PeriodStepper, SyncButton, control } from './reportControls';
import { DIM_KINDS, downloadBlob, resolveConfig } from './reportModel';
import { linesFile } from './linesExport';
import { useColumnWidths, useFitHeight } from './tableHooks';
import { useTableSync } from './tableSync';
import { cellStyle, headStyle } from './columnStyles';
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
const MJE_COLUMNS = [
  { key: 'date', label: 'Date', width: 96, text: (r) => formatDate(r.date) },
  { key: 'journal', label: 'Journal', width: 80, text: (r) => r.journal || '' },
  { key: 'entry', label: 'Entry No.', width: 90, text: (r) => String(r.batchNo || '') },
  { key: 'entity', label: 'Entity', width: 130, text: (r) => (r.locations || []).join(', ') },
  { key: 'description', label: 'Description', width: 280, text: (r) => r.title || '' },
  { key: 'amount', label: 'Amount', width: 110, num: true, text: (r) => Number(r.amount) || 0 },
  { key: 'createdBy', label: 'Created By', width: 130, text: (r) => r.createdBy || '' },
  { key: 'postedBy', label: 'Posted / Changed By', width: 150, text: (r) => r.modifiedBy || '' },
  { key: 'created', label: 'Created', width: 160, text: (r) => stamp(r.whenCreated) },
  { key: 'posted', label: 'Posted / Changed', width: 160, text: (r) => stamp(r.whenModified) },
  { key: 'state', label: 'State', width: 80, text: (r) => r.state || '' },
];

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
  const [sort, setSort] = useState({ key: 'date', dir: -1 });
  const [res, setRes] = useState({ key: '', data: null, error: '' });
  const [opening, setOpening] = useState('');
  const [entry, setEntry] = useState(null);
  const cw = useColumnWidths('manual-je', Object.fromEntries(MJE_COLUMNS.map((c) => [c.key, c.width])));

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

  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = (data?.entries || []).filter((r) => !words.length || words.every((w) => MJE_COLUMNS.map((c) => String(c.text(r))).join(' ').toLowerCase().includes(w)));
    const col = MJE_COLUMNS.find((c) => c.key === sort.key) || MJE_COLUMNS[0];
    const val = (r) => (sort.key === 'date' ? r.date || '' : col.text(r));
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en-US', { numeric: true })) * sort.dir;
    });
  }, [data, q, sort]);
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
      const table = {
        title: 'Manual Journal Entries', period: `${config.from}_${config.to}`,
        subtitle: [`${formatDate(config.from)} - ${formatDate(config.to)}`, config.entities.length ? config.entities.join(', ') : 'All entities', `${rows.length} entries`].join(' · '),
        columns: MJE_COLUMNS.map((c) => ({ label: c.label, num: !!c.num, width: cw.width(c.key) || c.width })),
        rows: rows.map((r) => MJE_COLUMNS.map((c) => c.text(r))),
        totals: MJE_COLUMNS.map((c, i) => (c.num ? total : i === 0 ? `Totals - ${rows.length} entries` : '')),
      };
      const file = await linesFile(table, format);
      downloadBlob(file.name, file);
    } finally {
      setBusy('');
    }
  };
  const head = (c) => (
    <th key={c.key} aria-label={c.label} aria-sort={sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}
      style={headStyle(cw.width(c.key), { cursor: 'pointer', ...(c.num ? { textAlign: 'right' } : null) })}
      onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }))} title="Click to sort">
      {c.label}{sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}<ColumnResizer {...cw.resizer(c.key, c.label)} />
    </th>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 10 }}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <PeriodStepper config={config} period="range" onChange={patch} />
        <EntitiesPicker entities={entities} value={config.entities} onChange={(codes) => patch({ entities: codes })} limited={limited} showHistorical={!!prefs.showHistoricalEntities} />
        <FiltersButton dims={config.dims} onChange={(d) => patch({ dims: d })} kinds={JOURNAL_KIND} />
        <select value={user} onChange={(e) => setUser(e.target.value)} aria-label="User" style={{ ...control, maxWidth: 200 }}>
          <option value="">All Users</option>
          {[...new Set([...(data?.users || []), ...(user ? [user] : [])])].map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={edited} onChange={(e) => setEdited(e.target.checked)} /> Include system entries a person changed
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by user
        </label>
        <div style={{ position: 'relative', flex: '1 1 180px', maxWidth: 280 }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the entries" placeholder="Search description, entry, user..." style={{ ...control, width: '100%', paddingLeft: 28 }} />
        </div>
        <div className="acct-bar-end">
          <SyncButton onSync={ts.sync} busy={loading && !!data} syncedAt={ts.syncedAt} />
          <ExportMenu disabled={!rows.length} items={[
            { key: 'excel', label: 'Excel', hint: 'The entries on screen, live totals', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per entry', onPick: () => exportAs('csv'), busy: busy === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
          ]} />
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
            <table className="req-table">
              <thead><tr>{MJE_COLUMNS.map(head)}<th aria-label="Open" style={{ width: 70 }} /></tr></thead>
              <tbody>
                {!rows.length && <tr><td colSpan={MJE_COLUMNS.length + 1} style={{ padding: 16, color: 'var(--text-secondary)' }}>No manual journal entries in this period.</td></tr>}
                {groups.map(([who, list]) => [
                  grouped ? (
                    <tr key={`g-${who}`} className="acct-section"><td colSpan={MJE_COLUMNS.length + 1} style={{ fontWeight: 700 }}>
                      {who} · {list.length} {list.length === 1 ? 'entry' : 'entries'} · <Amount value={Math.round(list.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100} />
                    </td></tr>
                  ) : null,
                  ...list.map((r) => (
                    <tr key={r.recordNo}>
                      {MJE_COLUMNS.map((c) => (
                        <td key={c.key} style={cellStyle(cw.width(c.key), c.num ? { textAlign: 'right' } : null)} title={String(c.text(r))}>
                          {c.num ? <Amount value={c.text(r)} /> : c.text(r)}
                          {c.key === 'postedBy' && r.kind === 'edited' && <span style={{ marginLeft: 6, fontSize: '0.68rem', padding: '1px 6px', borderRadius: 999, background: 'var(--wk-brand-tint, #e8ecfd)', color: 'var(--wk-brand, #2b45e1)' }}>Changed by a Person</span>}
                        </td>
                      ))}
                      <td>
                        <button type="button" className="secondary-btn" disabled={opening === r.recordNo} onClick={() => open(r)} aria-label={`Open entry ${r.batchNo}`}
                          style={{ fontSize: '0.72rem', padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>Open <ExternalLink size={11} /></button>
                      </td>
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
