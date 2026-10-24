import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, List, Pencil, Search, X } from 'lucide-react';
import { api } from '../../api';
import AsyncSection, { SkeletonBlocks } from '../AsyncState';
import { ControlBar, CustomizeButton, ExportMenu, Pager, SyncButton, Toggle, control } from './reportControls';
import { downloadBlob, iso } from './reportModel';
import { parkDrillReturn, requestReportDrill, takeDrillReturn } from './drill';
import { formatDate, formatDateTime } from '../../lib/datetime';
import { dialog } from '../../ui/dialog';
import { useAccountingPrefs } from './prefs';
import { usePaged } from './tableHooks';
import { TableViewBar, ViewHead, useTableView, viewCells, viewTable } from './tableView';
import { cellStyle } from './columnStyles';
import { useTableSync } from './tableSync';
import { linesFile } from './linesExport';
import SidePanel, { PanelSection } from './SidePanel';
import Amount from './Amount';

// Accounting > Vendors & Customers (Charmi and Neil, 10/01: "edit a vendor,
// change all the details and get pushed to manager for approval"). The
// records are Intacct's, read through the accounting app (contract V1);
// Nexus keeps the change requests. Editing a record does not change it: it
// files a request with the fields that differ, a manager approves or
// declines it from the Requests section (the requester gets a bell), and an
// approved change shows on the record as its current values with an
// "Awaiting Intacct" badge until it is keyed into Intacct from the CSV.
// Intacct stays the source of truth, one way.
//
// Until the accounting app ships the partners route (404 -> 501 from the
// backend) the Records section says so; Requests still works.
//
// Oct 14 (Neil: "activate Vendor and Customer, not working at all"): that
// route never reached production, so the screen only ever said "not
// available yet". The backend now falls back to the ledger's own vendor and
// customer codes (`source: 'ledger'`): number, name and how many ledger
// lines each has, read-only (no contact details to edit until the full
// Intacct record is served). Every row opens its ledger lines in Reports.
// Charmi (10/14): the number is the first column, before the name.
//
// Oct 22 (Charmi, 10/16: "drill down into a vendor - still can't"; "a
// Customize option that hides inactive"): a row opens the record - its
// fields, entity and status, its change history and its ledger activity
// (routers/accounting_partners.partner_record). Customize > Show Inactive,
// off by default, saved with the person's accounting preferences.
//
// Accounting call 10/23:
//   item 03  the record opens in a panel on the right (SidePanel), the list
//            still on screen; Details / Ledger Lines / Change History tabs
//            (Viral: "divide it into different tabs"). The edit is the
//            Details tab itself, its Send for Approval pinned at the bottom -
//            the same change request and approval as before.
//   item 06  every record is reachable by paging (no 300-row cap), the table
//            scrolls inside its own box with the headings pinned, search is
//            an icon that opens on click or Ctrl+F, Export (Excel / CSV) of
//            the list as filtered, banded rows.
//   item 07  View All Ledger Lines parks how this screen looked; Back on the
//            lines returns here with the same record, search, page and
//            scroll (drill.js parkDrillReturn).
//   items 02 / 13 (fixes 10/24) the shared one-line ControlBar and the
//            list's own Sync: it reads the list again past the server's
//            2-minute cache (Requests: the requests again); the open record,
//            the search, the page and the scroll stay.

const KINDS = [{ key: 'vendor', label: 'Vendors' }, { key: 'customer', label: 'Customers' }];
const SECTIONS = [{ key: 'records', label: 'Records' }, { key: 'requests', label: 'Requests' }];
const FIELDS = [
  ['displayName', 'Display Name'], ['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'],
  ['address.line1', 'Address Line 1'], ['address.line2', 'Address Line 2'], ['address.city', 'City'], ['address.state', 'State'], ['address.zip', 'ZIP'], ['address.country', 'Country'],
  ['terms', 'Terms'], ['status', 'Status'], ['taxId', 'Tax ID (last 4)'],
];
const FIELD_LABEL = Object.fromEntries(FIELDS);
// The Details tab's groups (item 04's rule for long forms: titled sections).
const GROUPS = [
  { title: 'Basic Details', caption: 'The name on checks and statements, and the status.', fields: ['displayName', 'name', 'status'] },
  { title: 'Contact', caption: 'How to reach them.', fields: ['email', 'phone'] },
  { title: 'Address', caption: 'Where mail and checks go.', fields: ['address.line1', 'address.line2', 'address.city', 'address.state', 'address.zip', 'address.country'] },
  { title: 'Billing', caption: 'Payment terms and tax ID.', fields: ['terms', 'taxId'] },
];
const PANEL_TABS = [{ key: 'details', label: 'Details' }, { key: 'lines', label: 'Ledger Lines' }, { key: 'history', label: 'Change History' }];
const DEFAULT_PAGE_SIZE = 100;
const STATUS = {
  pending: { label: 'Pending Approval', fg: '#92400e', bg: 'rgba(180,83,9,0.13)' },
  approved: { label: 'Approved - Awaiting Intacct', fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' },
  declined: { label: 'Declined', fg: 'var(--bad-fg, #dc2626)', bg: 'rgba(220,38,38,0.10)' },
};
const card = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: 'var(--shadow-sm)' };
const th = { textAlign: 'left', padding: '6px 8px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-color)' };
const td = { padding: '5px 8px', borderBottom: '1px solid var(--border-color)', fontSize: '0.8rem', verticalAlign: 'top' };
const label = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' };
const chip = (s) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: s.fg, background: s.bg, whiteSpace: 'nowrap' });
/** Inactive in Intacct ("inactive", "Inactive - do not use"). */
export const isInactive = (r) => /^\s*inactive/i.test(String(r?.status || ''));
const getField = (rec, f) => (f.startsWith('address.') ? rec.address?.[f.slice(8)] || '' : rec[f] || '');
const setField = (rec, f, v) => (f.startsWith('address.') ? { ...rec, address: { ...(rec.address || {}), [f.slice(8)]: v } } : { ...rec, [f]: v });
const editable = (rec) => ({ ...rec, address: { ...(rec.address || {}) } });

/** The fields whose value differs, as the request carries them. */
export function diffPartner(before, after) {
  const out = {};
  FIELDS.forEach(([f]) => {
    const a = String(getField(before, f) ?? '').trim();
    const b = String(getField(after, f) ?? '').trim();
    if (a !== b) out[f] = { from: a, to: b };
  });
  return out;
}

/** The list as shown (filters applied, every page), for Export. */
export function partnersTable(rows, { kind, fromLedger, note = '' }) {
  const noun = kind === 'vendor' ? 'Vendor' : 'Customer';
  const columns = fromLedger
    ? [{ label: `${noun} Number`, width: 110 }, { label: 'Name', width: 260 }, { label: 'Status', width: 90 }, { label: 'Ledger Lines', width: 90 }]
    : [{ label: `${noun} Number`, width: 110 }, { label: 'Name', width: 240 }, { label: 'Email', width: 200 }, { label: 'Phone', width: 120 }, { label: 'City', width: 120 }, { label: 'Terms', width: 90 }, { label: 'Status', width: 80 }, { label: 'Entity', width: 80 }];
  const body = rows.map((r) => (fromLedger
    ? [r.id, r.displayName || r.name || '', r.status || '', Number.isFinite(r.lines) ? r.lines.toLocaleString('en-US') : '']
    : [r.id, r.displayName || r.name || '', r.email || '', r.phone || '', r.address?.city || '', r.terms || '', r.status || '', r.entity || '']));
  const title = `${noun}s`;
  return { title, subtitle: [`${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? noun.toLowerCase() : `${noun.toLowerCase()}s`}`, note, `As of ${formatDate(iso(new Date()))}`].filter(Boolean).join(' · '), columns, rows: body, totals: null };
}

// The list's columns for the standard table view (10/23 meeting, item 01):
// filters, value lists and the menu on each heading, saved views. The last
// column holds the row's buttons and always stays where it is.
const OPEN_COLUMN = { key: 'open', label: 'Open', fixed: true, noFilter: true, noSort: true, exportAs: [], text: () => '' };
function partnerColumns(kind, fromLedger) {
  const noun = kind === 'vendor' ? 'Vendor' : 'Customer';
  const id = { key: 'id', label: `${noun} Number`, width: 110, text: (r) => r.id || '' };
  const name = { key: 'name', label: 'Name', width: fromLedger ? 260 : 240, text: (r) => r.displayName || r.name || '' };
  const status = { key: 'status', label: 'Status', width: fromLedger ? 90 : 80, text: (r) => r.status || '' };
  if (fromLedger) {
    return [id, name, status, {
      key: 'lines', label: 'Ledger Lines', width: 90, type: 'number',
      value: (r) => (Number.isFinite(r.lines) ? r.lines : null), text: (r) => (Number.isFinite(r.lines) ? r.lines.toLocaleString('en-US') : ''),
    }, OPEN_COLUMN];
  }
  return [id, name,
    { key: 'email', label: 'Email', width: 200, text: (r) => r.email || '' },
    { key: 'phone', label: 'Phone', width: 120, text: (r) => r.phone || '' },
    { key: 'city', label: 'City', width: 120, text: (r) => r.address?.city || '' },
    { key: 'terms', label: 'Terms', width: 90, text: (r) => r.terms || '' },
    status,
    { key: 'entity', label: 'Entity', width: 80, text: (r) => r.entity || '' },
    OPEN_COLUMN];
}

// Oct 22 (Neil): Records > Vendors / Customers open this screen on that list (`initialKind`).
export default function PartnersTab({ canApprove = false, initialKind = 'vendor' }) {
  const startKind = KINDS.some((k) => k.key === initialKind) ? initialKind : 'vendor';
  // Back from the ledger lines (item 07): how the screen looked, taken once.
  const [restore] = useState(() => {
    const r = takeDrillReturn('partners');
    return r && r.kind === startKind ? r : null;
  });
  const [kind, setKind] = useState(startKind);
  const [section, setSection] = useState('records');
  const [q, setQ] = useState(() => restore?.q || '');
  const [searchOpen, setSearchOpen] = useState(() => !!restore?.q);
  const [records, setRecords] = useState(null);
  const [source, setSource] = useState('intacct');   // 'ledger': codes and names only, read-only
  const [recState, setRecState] = useState({ loading: false, error: '', notReady: false });
  const [requests, setRequests] = useState(null);
  const [reqStatus, setReqStatus] = useState('pending');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [opened, setOpenedNow] = useState(null);    // the record open on the right
  const [panelTab, setPanelTab] = useState(() => restore?.panelTab || 'details');
  const panelDirty = useRef(false);
  const [prefs, setPrefs] = useAccountingPrefs();
  const showInactive = !!prefs.showInactivePartners;
  const pageSize = prefs.partnersPageSize === undefined ? DEFAULT_PAGE_SIZE : Math.max(0, Math.floor(Number(prefs.partnersPageSize) || 0));
  const seq = useRef(0);
  const loadedText = useRef('');                   // the server search the list was read with
  const boxRef = useRef(null);
  const searchRef = useRef(null);

  // Another record (a row click, Edit) replaces the open one; unsaved edits
  // are asked about first, never dropped quietly.
  const setOpened = useCallback(async (next, tab = 'details') => {
    if (panelDirty.current) {
      const ok = await dialog.confirm('The record open on the right has unsaved changes. Discard them?', { title: 'Unsaved Changes', confirmText: 'Discard Edits', cancelText: 'Keep Editing', danger: true });
      if (!ok) return;
    }
    panelDirty.current = false;
    setOpenedNow(next);
    if (next) setPanelTab(tab);
  }, []);

  // Picked again from the Records menu while open: that list.
  const shownKind = useRef(startKind);
  useEffect(() => {
    if (shownKind.current === startKind) return;
    shownKind.current = startKind;
    setKind(startKind);
    setOpenedNow(null);
  }, [startKind]);

  const loadRecords = useCallback((k, text) => {
    const mine = ++seq.current;
    loadedText.current = text;
    setRecState({ loading: true, error: '', notReady: false });
    return api.getAccountingPartners(k, text).then((d) => {
      if (mine !== seq.current) return;
      setRecords(d?.partners || []);
      setSource(d?.source === 'ledger' ? 'ledger' : 'intacct');
      setRecState({ loading: false, error: '', notReady: false });
    }).catch((e) => {
      if (mine !== seq.current) return;
      setRecords([]);
      setRecState({ loading: false, error: e?.status === 501 ? '' : (e?.message || 'Could not load the records.'), notReady: e?.status === 501 });
    });
  }, []);
  const loadRequests = useCallback((status, k) => (
    api.getAccountingPartnerChanges(status, k).then((d) => setRequests(d?.changes || [])).catch(() => setRequests([]))
  ), []);
  useEffect(() => { loadRecords(kind, ''); }, [kind, loadRecords]);
  useEffect(() => { loadRequests(reqStatus, kind); }, [reqStatus, kind, loadRequests]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (records || []).filter((r) => (showInactive || !isInactive(r))
      && (!s || [r.displayName, r.name, r.id, r.email, r.phone, r.entity].some((v) => String(v || '').toLowerCase().includes(s))));
  }, [records, q, showInactive]);
  const hiddenInactive = showInactive ? 0 : (records || []).filter(isInactive).length;

  // The list's own Sync (item 13): the rows stay on screen and are swapped in place.
  const syncLoad = useCallback(() => (section === 'requests' ? loadRequests(reqStatus, kind) : loadRecords(kind, loadedText.current)), [section, reqStatus, kind, loadRequests, loadRecords]);
  const ts = useTableSync(syncLoad);
  const [syncing, setSyncing] = useState(false);
  const onSync = () => { setSyncing(true); Promise.resolve(ts.sync()).finally(() => setSyncing(false)); };
  const syncButton = <SyncButton onSync={onSync} busy={syncing} syncedAt={ts.syncedAt} what={section === 'requests' ? 'Requests' : ''} />;
  // Item 01: the standard view over the list the search and Customize leave.
  const fromLedger = source === 'ledger';
  const columns = useMemo(() => partnerColumns(kind, fromLedger), [kind, fromLedger]);
  const view = useTableView(`partners-${kind}`, columns, shown);
  const listed = view.rows;
  const paged = usePaged(listed, pageSize, `${kind}|${q.trim().toLowerCase()}|${showInactive}|${JSON.stringify(view.state)}`);
  const { setPage } = paged;

  // Item 07: once the list is back, the parked page, record and scroll.
  const restoring = useRef(restore);
  useLayoutEffect(() => {
    const r = restoring.current;
    if (!r || records === null) return;
    restoring.current = null;
    if (r.page > 1) setPage(r.page);
    const row = r.openedId ? records.find((x) => x.id === r.openedId) : null;
    if (row) setOpenedNow(row);
    requestAnimationFrame(() => {
      if (boxRef.current && r.scrollTop) boxRef.current.scrollTop = r.scrollTop;
      if (r.windowY) window.scrollTo(0, r.windowY);
    });
  }, [records, setPage]);

  // Item 06 (Viral, 10/23: "if we write control F, it will open. Otherwise,
  // there is only one icon"): Ctrl+F opens the search on this list.
  useEffect(() => {
    if (section !== 'records') return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [section]);

  async function decide(r, decision) {
    const note = await dialog.prompt(decision === 'approve' ? 'Approve this change? A note is optional.' : 'Decline this change? Tell the requester why.', { title: decision === 'approve' ? 'Approve Change' : 'Decline Change', confirmText: decision === 'approve' ? 'Approve' : 'Decline' });
    if (note === null) return;
    setBusy(r.id);
    try { await api.decideAccountingPartnerChange(r.id, decision, note || ''); loadRequests(reqStatus, kind); loadRecords(kind, ''); }
    catch (err) { await dialog.alert(err?.message || 'Could not record the decision.', { title: 'Change Request' }); }
    setBusy('');
  }

  async function exportApproved() {
    setBusy('export');
    try { const { blob, filename } = await api.exportAccountingPartnerChanges('approved', kind); downloadBlob(filename, blob); }
    catch (err) { await dialog.alert(err?.message || 'Could not export.', { title: 'Export' }); }
    setBusy('');
  }

  const kindLabel = kind === 'vendor' ? 'vendor' : 'customer';

  async function exportList(format) {
    setBusy(`export-${format}`);
    try {
      // Exactly what the view leaves: its rows, order and columns (item 01).
      const about = partnersTable(listed, { kind, fromLedger, note: [q.trim() ? `matching "${q.trim()}"` : '', view.count ? 'filtered' : '', showInactive ? 'inactive included' : 'active only'].filter(Boolean).join(', ') });
      const table = viewTable(listed, view.columns, { title: about.title, subtitle: about.subtitle, totals: false });
      const file = await linesFile(table, format, `${table.title} - ${formatDate(iso(new Date())).replace(/\//g, '-')}.${format === 'excel' ? 'xlsx' : 'csv'}`);
      downloadBlob(file.name, file);
    } catch (err) { await dialog.alert(err?.message || 'Could not export.', { title: 'Export' }); }
    setBusy('');
  }

  // The ledger lines of one vendor or customer, every date, in Reports - and
  // Back there returns here as it is now (item 07).
  const openLines = (r) => {
    parkDrillReturn('partners', { kind, q, page: paged.page, openedId: opened?.id || '', panelTab, scrollTop: boxRef.current?.scrollTop || 0, windowY: window.scrollY || 0 });
    requestReportDrill({ party: { kind, code: r.id, name: r.displayName || r.name || r.id }, from: '', to: iso(new Date()),
      back: { label: `Back to ${kind === 'vendor' ? 'Vendors' : 'Customers'}`, sub: kind === 'vendor' ? 'partners' : 'customers' } });
  };
  // A row opens the record on the right (Charmi, 10/16; item 03); its buttons keep their own jobs.
  const rowOpen = (r) => ({
    onClick: () => setOpened(r), tabIndex: 0, style: { cursor: 'pointer' }, title: 'Open the record', className: opened?.id === r.id ? 'is-open' : undefined,
    onKeyDown: (e) => { if (e.key === 'Enter') setOpened(r); },
  });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <ControlBar style={{ ...card, padding: '8px 10px' }}>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
          {KINDS.map((k) => (
            <button key={k.key} type="button" onClick={() => { setKind(k.key); setOpened(null); }} aria-pressed={kind === k.key}
              style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: kind === k.key ? 700 : 500, border: `1px solid ${kind === k.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: kind === k.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: kind === k.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
          {SECTIONS.map((s) => (
            <button key={s.key} type="button" onClick={() => setSection(s.key)} aria-pressed={section === s.key}
              style={{ ...control, cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: section === s.key ? 700 : 500, border: `1px solid ${section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--border-color)'}`, color: section === s.key ? 'var(--wk-brand, #2b45e1)' : 'var(--text-secondary)', background: section === s.key ? 'var(--wk-brand-tint, #e8ecfd)' : 'var(--bg-card)' }}>
              {s.label}{s.key === 'requests' && reqStatus === 'pending' && requests?.length ? ` (${requests.length})` : ''}
            </button>
          ))}
        </div>
        {section === 'records' ? (
          <>
            {searchOpen || q ? (
              <form onSubmit={(e) => { e.preventDefault(); loadRecords(kind, q.trim()); }} style={{ position: 'relative', flex: '1 1 220px', maxWidth: 380 }}>
                <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)' }} />
                <input ref={searchRef} type="text" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={!restore}
                  onBlur={() => { if (!q.trim()) setSearchOpen(false); }} onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); setSearchOpen(false); } }}
                  placeholder={`Search ${kindLabel}s by number, name, email`} aria-label={`Search ${kindLabel}s`} style={{ ...control, width: '100%', paddingLeft: 28 }} />
              </form>
            ) : (
              <button type="button" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }} aria-label="Open Search" title="Search (Ctrl+F)"
                style={{ ...control, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, padding: 0, color: 'var(--text-secondary)' }}><Search size={14} /></button>
            )}
            <TableViewBar view={view} />
            <div className="acct-bar-end">
              {syncButton}
              <CustomizeButton active={showInactive} pageSize={pageSize} onPageSize={(n) => setPrefs({ partnersPageSize: Math.max(0, Math.floor(Number(n) || 0)) })}>
                <Toggle checked={showInactive} onChange={(v) => setPrefs({ showInactivePartners: !!v })} label="Show Inactive"
                  hint={`Vendors and customers marked inactive in Intacct are hidden until this is on.`} />
              </CustomizeButton>
              <ExportMenu disabled={!listed.length} items={[
                { key: 'excel', label: 'Excel', hint: `The ${kindLabel}s listed, every page`, busy: busy === 'export-excel', onPick: () => exportList('excel') },
                { key: 'csv', label: 'CSV', hint: 'The same list as plain text', busy: busy === 'export-csv', onPick: () => exportList('csv') },
              ]} />
            </div>
          </>
        ) : (
          <>
            <select value={reqStatus} onChange={(e) => setReqStatus(e.target.value)} aria-label="Request status" style={control}>
              <option value="pending">Pending Approval</option>
              <option value="approved">Approved - Awaiting Intacct</option>
              <option value="declined">Declined</option>
              <option value="">All</option>
            </select>
            <div className="acct-bar-end">
              {syncButton}
              <button type="button" className="secondary-btn" disabled={busy === 'export'} onClick={exportApproved} aria-label="Export Approved CSV" title="Export Approved CSV" style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> <span className="acct-bar-label">Export Approved CSV</span></button>
            </div>
          </>
        )}
      </ControlBar>

      {notice && (
        <div role="status" style={{ ...card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.82rem', color: 'var(--ok-fg, #15803d)' }}>
          <span style={{ flex: 1 }}>{notice}</span>
          <button type="button" onClick={() => setNotice('')} aria-label="Dismiss" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'inline-flex', padding: 2 }}><X size={14} /></button>
        </div>
      )}

      {section === 'records' && (recState.notReady ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' }}>
          <h3 style={{ margin: '0 0 6px', fontSize: '1rem' }}>Vendors & Customers</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.86rem' }}>Not available yet - the accounting app needs its update. Once it serves the vendor and customer master, the records list here and edits go to a manager for approval.</p>
        </div>
      ) : (
        <AsyncSection loading={records === null} error={!!recState.error} errorMessage={recState.error} onRetry={() => loadRecords(kind, q.trim())} skeleton={<SkeletonBlocks count={2} />}>
          {fromLedger && (
            <p role="note" style={{ margin: '0 0 8px', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              The {kindLabel} numbers and names on the ledger. Contact details and edits open once the accounting app serves the full Intacct record.
            </p>
          )}
          {hiddenInactive > 0 && (
            <p style={{ margin: '0 0 8px', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              {hiddenInactive.toLocaleString('en-US')} inactive {hiddenInactive === 1 ? kindLabel : `${kindLabel}s`} hidden - Customize &gt; Show Inactive lists them.
            </p>
          )}
          <div style={card}>
            <div ref={boxRef} className="acct-partners-box" data-testid="partners-box">
              {!listed.length ? (
                <p style={{ margin: 0, padding: 24, color: 'var(--text-secondary)', fontSize: '0.86rem', textAlign: 'center' }}>
                  {shown.length ? `No ${kindLabel}s pass the filters. Clear a filter to see more.` : `No ${hiddenInactive && !q ? `active ${kindLabel}s` : `${kindLabel}s`}${q ? ' match' : ' came back from the ledger'}.`}
                </p>
              ) : (
                <table className="acct-partners">
                  <thead>
                    <tr>
                      {view.columns.map((c) => (c.key === 'open' ? <th key={c.key} style={th} aria-label="Actions" /> : (
                        <ViewHead key={c.key} view={view} col={c} aria-label={c.label} style={{ ...th, position: 'sticky', ...(c.type === 'number' ? { textAlign: 'right' } : null), ...cellStyle(view.manualWidth(c.key), { overflow: 'visible' }) }} />
                      )))}
                    </tr>
                  </thead>
                  <tbody>
                    {paged.rows.map((r) => {
                      const cell = (k, extra = null) => ({ ...td, ...(extra || {}), ...cellStyle(view.manualWidth(k)) });
                      return (
                        <tr key={r.id} {...rowOpen(r)}>
                          {viewCells(view, fromLedger ? {
                            id: <td style={cell('id', { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' })}>{r.id}</td>,
                            name: <td style={cell('name')}><strong>{r.displayName || r.name}</strong></td>,
                            status: <td style={cell('status')}>{r.status || <span style={{ color: 'var(--text-muted)' }} title="The status is on the Intacct record">-</span>}</td>,
                            lines: <td style={cell('lines', { textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{Number.isFinite(r.lines) ? r.lines.toLocaleString('en-US') : ''}</td>,
                            open: (
                              <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <button type="button" className="secondary-btn" onClick={(e) => { e.stopPropagation(); openLines(r); }} aria-label={`Ledger lines of ${r.displayName || r.name || r.id}`}
                                  style={{ fontSize: '0.72rem', padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}><List size={12} /> View Lines</button>
                              </td>
                            ),
                          } : {
                            id: <td style={cell('id', { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' })}>{r.id}</td>,
                            name: (
                              <td style={cell('name')}>
                                <strong>{r.displayName || r.name}</strong>
                                {r.awaitingIntacct && <span style={{ ...chip(STATUS.approved), marginLeft: 6 }} title={`Approved changes not yet keyed into Intacct: ${Object.keys(r.intacctValues || {}).map((f) => FIELD_LABEL[f] || f).join(', ')}`}>Awaiting Intacct</span>}
                                {r.pendingChange && <span style={{ ...chip(STATUS.pending), marginLeft: 6 }}>Pending Approval</span>}
                              </td>
                            ),
                            email: <td style={cell('email')}>{r.email}</td>,
                            phone: <td style={cell('phone')}>{r.phone}</td>,
                            city: <td style={cell('city')}>{r.address?.city}</td>,
                            terms: <td style={cell('terms')}>{r.terms}</td>,
                            status: <td style={cell('status')}>{r.status}</td>,
                            entity: <td style={cell('entity')}>{r.entity}</td>,
                            open: (
                              <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <button type="button" aria-label={`Ledger lines of ${r.displayName || r.name || r.id}`} title="Ledger lines" onClick={(e) => { e.stopPropagation(); openLines(r); }}
                                  style={{ border: 'none', background: 'none', padding: 4, cursor: 'pointer', display: 'inline-flex', color: 'var(--text-muted)' }}><List size={14} /></button>
                                <button type="button" aria-label={`Edit ${r.displayName || r.name}`} disabled={r.pendingChange} title={r.pendingChange ? 'A change is already waiting for approval' : 'Edit - the change goes to a manager for approval'}
                                  onClick={(e) => { e.stopPropagation(); setOpened(r, 'details'); }}
                                  style={{ border: 'none', background: 'none', padding: 4, cursor: r.pendingChange ? 'default' : 'pointer', display: 'inline-flex', color: 'var(--text-muted)' }}><Pencil size={14} /></button>
                              </td>
                            ),
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <Pager {...paged} style={{ borderTop: '1px solid var(--border-color)', padding: '8px 0' }} />
          </div>
        </AsyncSection>
      ))}

      {section === 'requests' && (
        <AsyncSection loading={requests === null} skeleton={<SkeletonBlocks count={2} />}>
          <div style={{ ...card, overflow: 'auto' }}>
            {!requests?.length ? (
              <p style={{ margin: 0, padding: 24, color: 'var(--text-secondary)', fontSize: '0.86rem', textAlign: 'center' }}>No {reqStatus ? STATUS[reqStatus]?.label.toLowerCase() : ''} requests for {kindLabel}s.</p>
            ) : (
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead><tr><th style={th}>Record</th><th style={th}>Changes</th><th style={th}>Requested</th><th style={th}>Status</th><th style={th}>Note</th>{canApprove && <th style={th}></th>}</tr></thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} className={canApprove && r.status === 'pending' ? 'nx-needs-you--row' : undefined}>
                      <td style={td}><strong>{r.partnerName || r.partnerId}</strong><div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{r.partnerId}</div></td>
                      <td style={td}>
                        {Object.entries(r.changes || {}).map(([f, v]) => (
                          <div key={f}><span style={{ color: 'var(--text-secondary)' }}>{FIELD_LABEL[f] || f}:</span> <s style={{ color: 'var(--text-muted)' }}>{v.from || '(blank)'}</s> {'->'} <strong>{v.to || '(blank)'}</strong></div>
                        ))}
                      </td>
                      <td style={td}>{r.requestedByName}<div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{formatDateTime(r.requestedAt)}</div></td>
                      <td style={td}><span style={chip(STATUS[r.status] || STATUS.pending)}>{STATUS[r.status]?.label || r.status}</span>{r.decidedByName && <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{r.decidedByName} · {formatDateTime(r.decidedAt)}</div>}</td>
                      <td style={{ ...td, whiteSpace: 'pre-wrap', maxWidth: 260 }}>{r.note}</td>
                      {canApprove && (
                        <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                          {r.status === 'pending' && (
                            <>
                              <button type="button" className="primary-btn" disabled={busy === r.id} onClick={() => decide(r, 'approve')} style={{ fontSize: '0.74rem', display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 6 }}><Check size={12} /> Approve</button>
                              <button type="button" className="secondary-btn" disabled={busy === r.id} onClick={() => decide(r, 'decline')} style={{ fontSize: '0.74rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}><X size={12} /> Decline</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </AsyncSection>
      )}

      {opened && (
        <PartnerPanel key={`${kind}|${opened.id}`} kind={kind} row={opened} tab={panelTab} onTab={setPanelTab} canEdit={!fromLedger}
          onDirty={(d) => { panelDirty.current = d; }} onClose={() => { panelDirty.current = false; setOpenedNow(null); }} onLines={() => openLines(opened)}
          onSent={(name) => { panelDirty.current = false; setOpenedNow(null); loadRecords(kind, ''); loadRequests(reqStatus, kind); setNotice(`Sent for approval: ${name}. It shows under Requests until a manager decides.`); }} />
      )}
    </div>
  );
}

// ── One record, on the right (Charmi, 10/16; Accounting call 10/23) ─────────
const factLabel = { color: 'var(--text-muted)', fontSize: '0.74rem' };
const addressText = (a = {}) => [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.zip, a.country].filter(Boolean).join(' · ');
const Facts = ({ items }) => (
  <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px 16px' }}>
    {items.map(([k, v]) => (
      <div key={k}><dt style={factLabel}>{k}</dt><dd style={{ margin: 0, fontSize: '0.84rem', overflowWrap: 'anywhere' }}>{v || <span style={{ color: 'var(--text-muted)' }}>-</span>}</dd></div>
    ))}
  </dl>
);

export function PartnerPanel({ kind, row, tab, onTab, canEdit, onDirty, onClose, onLines, onSent }) {
  const [state, setState] = useState({ data: null, error: '' });
  const [draft, setDraft] = useState(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getAccountingPartnerRecord(kind, row.id)
      .then((d) => { if (alive) setState({ data: d, error: '' }); })
      .catch((e) => { if (alive) setState({ data: null, error: e?.message || 'Could not open the record.' }); });
    return () => { alive = false; };
  }, [kind, row.id]);
  const d = state.data;
  const rec = d?.record || row;
  const noun = kind === 'vendor' ? 'Vendor' : 'Customer';
  const fromLedger = (d?.source || '') === 'ledger';
  // The Details tab is the edit (item 03): open once the record is read, not
  // for ledger-only records or one with a change already waiting.
  const canChange = canEdit && !!d && !fromLedger && !rec.pendingChange;
  const form = draft || editable(rec);
  const changes = canChange ? diffPartner(rec, form) : {};
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => { onDirty?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useRef(false);
  useEffect(() => { live.current = dirty; }, [dirty]);
  const tryClose = useCallback(async () => {
    if (live.current) {
      const ok = await dialog.confirm('Discard the changes you made to this record?', { title: 'Unsaved Changes', confirmText: 'Discard Edits', cancelText: 'Keep Editing', danger: true });
      if (!ok) return;
    }
    onClose();
  }, [onClose]);
  useEffect(() => {
    // A popup open over the panel takes its own Escape.
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) tryClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tryClose]);

  async function send() {
    if (!dirty || sending) return;
    const note = await dialog.prompt('A note for the approver (optional):', { title: 'Send for Approval', confirmText: 'Send' });
    if (note === null) return;
    setSending(true);
    try {
      await api.createAccountingPartnerChange({ kind, partnerId: rec.id, partnerName: rec.displayName || rec.name, changes, note: note || '' });
      onSent(rec.displayName || rec.name || rec.id);
    } catch (err) {
      await dialog.alert(err?.message || 'Could not send the request.', { title: 'Change Request' });
      setSending(false);
    }
  }

  const a = d?.activity;
  const readOnlyFacts = [['Entity', rec.entity], ['Updated In Intacct', rec.updatedAt ? formatDate(rec.updatedAt) : ''], ['Ledger Lines', Number.isFinite(rec.lines) ? rec.lines.toLocaleString('en-US') : a ? a.total.toLocaleString('en-US') : '']];
  const badges = (
    <>
      {rec.status && <span style={chip(isInactive(rec) ? STATUS.declined : { fg: 'var(--ok-fg, #15803d)', bg: 'rgba(21,128,61,0.10)' })}>{isInactive(rec) ? 'Inactive' : rec.status[0].toUpperCase() + rec.status.slice(1)}</span>}
      {rec.awaitingIntacct && <span style={chip(STATUS.approved)}>Awaiting Intacct</span>}
      {rec.pendingChange && <span style={chip(STATUS.pending)}>Pending Approval</span>}
    </>
  );
  return (
    <SidePanel label={`${noun} ${rec.id}`} title={`${noun} ${rec.id} - ${rec.displayName || rec.name || rec.id}`} badges={badges}
      caption={canChange ? 'Changes go to a manager for approval - nothing changes in Intacct from here.' : ''}
      tabs={PANEL_TABS} tab={tab} onTab={onTab} onClose={tryClose}
      footer={(
        <div className="modal-footer" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="secondary-btn" onClick={onLines} style={{ fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}><List size={13} /> View All Ledger Lines</button>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            {!canChange && d && (
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                {rec.pendingChange ? 'A change is already waiting for approval.' : fromLedger || !canEdit ? 'Edits open once the full Intacct record is served.' : ''}
              </span>
            )}
            {canChange && dirty && <button type="button" className="secondary-btn" onClick={() => setDraft(null)}>Undo Changes</button>}
            {canChange && <button type="button" className="primary-btn" onClick={send} disabled={!dirty || sending}>{sending ? 'Sending...' : 'Send for Approval'}</button>}
          </span>
        </div>
      )}>
      {state.error && <div role="alert" style={{ border: '1px solid var(--bad-fg, #dc2626)', color: 'var(--bad-fg, #dc2626)', borderRadius: 8, padding: '8px 12px', fontSize: '0.84rem' }}>{state.error}</div>}

      {tab === 'details' && (
        <>
          {GROUPS.map((g) => (
            <PanelSection key={g.title} title={g.title} caption={g.caption}>
              {canChange ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
                  {g.fields.map((f) => (
                    <div key={f}>
                      <label htmlFor={`pf-${f}`} style={label}>{FIELD_LABEL[f]}</label>
                      <input id={`pf-${f}`} type="text" value={getField(form, f)} onChange={(e) => setDraft(setField(form, f, e.target.value))}
                        style={{ ...control, width: '100%', ...(changes[f] ? { borderColor: 'var(--wk-brand, #2b45e1)', background: 'var(--wk-brand-tint, #e8ecfd)' } : {}) }} />
                    </div>
                  ))}
                </div>
              ) : (
                <Facts items={g.title === 'Address' ? [['Address', addressText(rec.address)]] : g.fields.map((f) => [f === 'taxId' ? 'Tax ID (Last 4)' : FIELD_LABEL[f], getField(rec, f)])} />
              )}
              {g.title === 'Basic Details' && (
                <div style={{ marginTop: 12 }}><Facts items={[[`${noun} Number`, rec.id], ...readOnlyFacts]} /></div>
              )}
            </PanelSection>
          ))}
          {rec.awaitingIntacct && (
            <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
              Approved changes not yet keyed into Intacct: {Object.entries(rec.intacctValues || {}).map(([f, v]) => `${FIELD_LABEL[f] || f} (Intacct has ${v || 'blank'})`).join(', ')}.
            </p>
          )}
          {fromLedger && <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--text-muted)' }}>Contact details show once the accounting app serves the full Intacct record.</p>}
        </>
      )}

      {tab === 'lines' && (
        <PanelSection title="Ledger Activity" caption="The latest lines on the ledger; View All Ledger Lines opens every one.">
          {!d && !state.error ? <SkeletonBlocks count={2} /> : d?.activityError ? (
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--bad-fg, #dc2626)' }}>The ledger could not be read: {d.activityError}</p>
          ) : a && (
            <>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: '0.82rem', marginBottom: 8 }}>
                <span><span style={factLabel}>Lines </span><strong>{a.total.toLocaleString('en-US')}</strong></span>
                <span><span style={factLabel}>Debits </span><strong><Amount value={a.debit} /></strong></span>
                <span><span style={factLabel}>Credits </span><strong><Amount value={a.credit} /></strong></span>
                {a.entities?.length > 0 && <span><span style={factLabel}>Entities </span>{a.entities.map((e) => e.name ? `${e.code} ${e.name}` : e.code).join(', ')}</span>}
              </div>
              {a.lines?.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table className="acct-partners">
                    <thead><tr><th style={th}>Date</th><th style={th}>Entry</th><th style={th}>Entity</th><th style={th}>Account</th><th style={th}>Memo</th><th style={{ ...th, textAlign: 'right' }}>Debit</th><th style={{ ...th, textAlign: 'right' }}>Credit</th></tr></thead>
                    <tbody>
                      {a.lines.map((l) => (
                        <tr key={l.lineId || `${l.entryNo}-${l.date}-${l.debit}-${l.credit}`}>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatDate(l.date)}</td>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.entryNo}</td>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.entity}</td>
                          <td style={td}>{l.account} {l.accountName}</td>
                          <td style={{ ...td, maxWidth: 280 }}>{l.memo}</td>
                          <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}><Amount value={l.debit} zero="blank" /></td>
                          <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}><Amount value={l.credit} zero="blank" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {a.total > a.lines.length && <p style={{ margin: '6px 0 0', fontSize: '0.74rem', color: 'var(--text-muted)' }}>The latest {a.lines.length} of {a.total.toLocaleString('en-US')} lines - View All Ledger Lines opens every one in Reports.</p>}
                </div>
              ) : <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No lines on the ledger you can read.</p>}
            </>
          )}
        </PanelSection>
      )}

      {tab === 'history' && (
        <PanelSection title="Change History" caption="Every change requested in Nexus, and what was decided.">
          {!d && !state.error ? <SkeletonBlocks count={1} /> : !d?.history?.length ? (
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No change has been requested for this {noun.toLowerCase()} in Nexus.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="acct-partners">
                <thead><tr><th style={th}>Requested</th><th style={th}>Changes</th><th style={th}>Status</th><th style={th}>Note</th></tr></thead>
                <tbody>
                  {d.history.map((h) => (
                    <tr key={h.id}>
                      <td style={td}>{h.requestedByName}<div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{formatDateTime(h.requestedAt)}</div></td>
                      <td style={td}>
                        {Object.entries(h.changes || {}).map(([f, v]) => (
                          <div key={f}><span style={{ color: 'var(--text-secondary)' }}>{FIELD_LABEL[f] || f}:</span> <s style={{ color: 'var(--text-muted)' }}>{v.from || '(blank)'}</s> {'->'} <strong>{v.to || '(blank)'}</strong></div>
                        ))}
                      </td>
                      <td style={td}><span style={chip(STATUS[h.status] || STATUS.pending)}>{STATUS[h.status]?.label || h.status}</span>{h.decidedByName && <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{h.decidedByName} · {formatDateTime(h.decidedAt)}</div>}</td>
                      <td style={{ ...td, whiteSpace: 'pre-wrap', maxWidth: 240 }}>{h.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PanelSection>
      )}
    </SidePanel>
  );
}
