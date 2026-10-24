import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../../api';
import { SkeletonBlocks } from '../AsyncState';
import { ColumnResizer, ControlBar, ExportMenu, Pager, SyncButton, control } from './reportControls';
import { useColumnWidths, useFitHeight, usePaged } from './tableHooks';
import { useTableSync } from './tableSync';
import { cellStyle, headStyle } from './columnStyles';
import { downloadBlob } from './reportModel';
import { linesFile } from './linesExport';
import { SECTION_LABEL } from './builderModel';
import { GL_ACCOUNTS_SHOW_INACTIVE } from './assumptions';

// Accounting -> Records -> General Ledger Accounts and Entities (Neil and
// Charmi, 10/22 call, CR-12: "Change Chart of Accounts to General Ledger
// Accounts"; "entities and locations"). Both read-only lists of what the
// ledger holds, with a search box, resizable columns, paging and Export.
// The chart comes from GET /accounting/accounts (the accounting app's chart,
// or - until it has one - every account posted to on the ledger, and the
// screen says so); the entities are the ones the Reports pickers list, so a
// person limited to certain entities sees theirs.

const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const PAGE = 100;

/** The rows whose text holds every word typed. */
function matchRows(rows, columns, q) {
  const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = columns.map((c) => c.text(r)).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// 10/23 meeting: each list has its own Sync (item 13) and scrolls inside its
// own box under the toolbar, headings pinned (item 05).
function RecordsTable({ tableKey, title, about, columns, rows, loading, error, note, extra = null, sync = null, syncing = false }) {
  const [box, setBox] = useState(null);
  const fit = useFitHeight(box);
  const [q, setQ] = useState('');
  const cw = useColumnWidths(tableKey, Object.fromEntries(columns.map((c) => [c.key, c.width])));
  const shown = useMemo(() => matchRows(rows || [], columns, q), [rows, columns, q]);
  const paged = usePaged(shown, PAGE, q);
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState('');
  const exportAs = async (format) => {
    setBusy(format);
    setFailed('');
    try {
      const table = { title, subtitle: `${shown.length.toLocaleString('en-US')} rows`, columns: columns.map((c) => ({ label: c.label, num: false, width: cw.width(c.key) || c.width })), rows: shown.map((r) => columns.map((c) => c.text(r))), totals: null };
      const file = await linesFile(table, format);
      downloadBlob(file.name, file);
    } catch (e) {
      setFailed(e?.message || 'Could not export the list.');
    } finally {
      setBusy('');
    }
  };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 420 }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--text-muted)' }} />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${title}`} placeholder={about}
            style={{ ...control, width: '100%', paddingLeft: 28 }} />
        </div>
        {extra}
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{rows ? `${shown.length.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')}` : ''}</span>
        <div className="acct-bar-end">
          {sync && <SyncButton onSync={sync.sync} busy={syncing} syncedAt={sync.syncedAt} />}
          <ExportMenu disabled={!shown.length} items={[
            { key: 'excel', label: 'Excel', hint: 'The rows on screen, as filtered', onPick: () => exportAs('excel'), busy: busy === 'excel' },
            { key: 'csv', label: 'CSV', hint: 'Plain values, one row per line', onPick: () => exportAs('csv'), busy: busy === 'csv' },
            { key: 'pdf', label: 'PDF', hint: 'Landscape, banded, page numbers', onPick: () => exportAs('pdf'), busy: busy === 'pdf' },
          ]} />
        </div>
      </ControlBar>
      {note && <div role="note" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', padding: '0 4px' }}>{note}</div>}
      {(error || failed) && <div role="alert" style={{ ...card, padding: 12, color: 'var(--bad-fg, #dc2626)', borderColor: 'var(--bad-fg, #dc2626)', fontSize: '0.84rem' }}>{error || failed}</div>}
      {loading && !rows && <div style={{ ...card, padding: 12 }}><SkeletonBlocks count={5} /></div>}
      {rows && (
        <div style={{ ...card, padding: 0, overflow: 'hidden', opacity: syncing ? 0.6 : 1 }}>
          <div className="req-table-wrapper acct-scroll-box" ref={setBox} data-testid="records-box" style={fit}>
            <table className="req-table">
              <thead>
                <tr>{columns.map((c) => <th key={c.key} aria-label={c.label} style={headStyle(cw.width(c.key))}>{c.label}<ColumnResizer {...cw.resizer(c.key, c.label)} /></th>)}</tr>
              </thead>
              <tbody>
                {!paged.rows.length && <tr><td colSpan={columns.length} style={{ padding: 16, color: 'var(--text-secondary)' }}>{q ? 'Nothing matches the search.' : 'Nothing to list.'}</td></tr>}
                {paged.rows.map((r) => (
                  <tr key={columns[0].text(r)} style={r.inactive ? { color: 'var(--text-muted)' } : undefined}>
                    {columns.map((c) => <td key={c.key} style={cellStyle(cw.width(c.key))} title={c.text(r)}>{c.text(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager {...paged} style={{ borderTop: '1px solid var(--border-color)' }} />
        </div>
      )}
    </div>
  );
}

const yes = (v) => (v === false || v === 'false' ? 'Inactive' : 'Active');
const ACCOUNT_COLUMNS = [
  { key: 'account', label: 'Account', width: 110, text: (r) => String(r.account_no || '') },
  { key: 'title', label: 'Title', width: 300, text: (r) => r.title || '' },
  { key: 'section', label: 'Section', width: 170, text: (r) => SECTION_LABEL[r.section] || r.section || '' },
  { key: 'type', label: 'Type', width: 150, text: (r) => r.account_type || '' },
  { key: 'normal', label: 'Normal Balance', width: 130, text: (r) => (r.normal_balance ? String(r.normal_balance).charAt(0).toUpperCase() + String(r.normal_balance).slice(1) : '') },
  { key: 'category', label: 'Category', width: 180, text: (r) => r.category || r.group || '' },
  { key: 'status', label: 'Status', width: 100, text: (r) => yes(r.active) },
];

export function GlAccountsTab() {
  const [res, setRes] = useState({ data: null, error: '', tick: -1 });
  const [inactive, setInactive] = useState(GL_ACCOUNTS_SHOW_INACTIVE);
  const ts = useTableSync();
  useEffect(() => {
    let alive = true;
    ts.read(() => api.getAccountingAccounts())
      .then((d) => { if (alive) setRes({ data: d, error: '', tick: ts.tick }); })
      .catch((e) => { if (alive) setRes((r) => ({ data: r.data || { accounts: [] }, error: e?.message || 'Could not read the chart of accounts.', tick: ts.tick })); });
    return () => { alive = false; };
  }, [ts.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (res.data ? (res.data.accounts || []).filter((a) => inactive || a.active !== false).map((a) => ({ ...a, inactive: a.active === false })) : null), [res.data, inactive]);
  return (
    <RecordsTable tableKey="records-gl-accounts" title="General Ledger Accounts" about="Search by number, title, section or category"
      columns={ACCOUNT_COLUMNS} rows={rows} loading={!res.data} error={res.error} sync={ts} syncing={!!res.data && res.tick !== ts.tick}
      note={res.data?.source === 'ledger' ? 'The accounting app does not list its chart yet: these are the accounts posted to on the ledger, up to today.' : ''}
      extra={(
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Show inactive
        </label>
      )} />
  );
}

export function EntitiesTab() {
  const [res, setRes] = useState({ data: null, error: '', tick: -1 });
  const ts = useTableSync();
  useEffect(() => {
    let alive = true;
    ts.read(() => api.getAccountingLocations())
      .then((d) => { if (alive) setRes({ data: d, error: '', tick: ts.tick }); })
      .catch((e) => { if (alive) setRes((r) => ({ data: r.data || { entities: [] }, error: e?.message || 'Could not read the entities.', tick: ts.tick })); });
    return () => { alive = false; };
  }, [ts.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const entities = res.data?.entities;
  const columns = useMemo(() => {
    const nameOf = Object.fromEntries((entities || []).map((e) => [e.code, e.name]));
    return [
      { key: 'code', label: 'Entity', width: 110, text: (r) => r.code || '' },
      { key: 'name', label: 'Name', width: 320, text: (r) => r.name || '' },
      { key: 'parent', label: 'Parent Entity', width: 320, text: (r) => (r.parent_code ? `${r.parent_code} ${r.parent_name || nameOf[r.parent_code] || ''}`.trim() : '') },
      { key: 'lines', label: 'Ledger Lines', width: 120, text: (r) => (r.lines == null ? '' : Number(r.lines).toLocaleString('en-US')) },
    ];
  }, [entities]);
  const rows = useMemo(() => (entities ? [...entities].sort((a, b) => String(a.code).localeCompare(String(b.code), 'en-US', { numeric: true })) : null), [entities]);
  return (
    <RecordsTable tableKey="records-entities" title="Entities" about="Search by entity number, name or parent" columns={columns} rows={rows} loading={!res.data} error={res.error} sync={ts} syncing={!!res.data && res.tick !== ts.tick}
      note={res.data?.limited ? 'Only the entities your accounting access includes.' : ''} />
  );
}
