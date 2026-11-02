// Documents > Forms > Entries (Neil, 11/02/2026): every entry the viewer may
// see (the server's reach rule - your own, your reports', your teams' sites',
// HR++ their companies', administrators all), filtered by form, site, status,
// date and person, paged, with one CSV per form. Table key `form-entries`:
// every column takes a ColumnResizer and keeps each person's widths (house
// rule). A row opens beside the list (EntryPanel) through `onOpen`.
// GET /forms/entries answers {items, total, page, pageSize}; the CSV takes the
// same date / status / site filters.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ClipboardList } from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { StatusLabel } from '../components/StatusLabel';
import AsyncSection, { SkeletonBlocks } from '../components/AsyncState';
import { ColumnResizer } from '../components/accounting/reportControls';
import { useColumnWidths } from '../components/accounting/tableHooks';
import { saveBlob } from '../components/DocumentSidePanel';
import { DateField } from '../tasks/components';
import { ENTRY_STATES, entryState, isForm } from './formsModel';

const COLUMNS = [['form', 'Form'], ['person', 'Submitted By'], ['site', 'Site'], ['submitted', 'Submitted'], ['status', 'Status'], ['links', 'Linked To']];
const WIDTHS = { form: 220, person: 180, site: 140, submitted: 180, status: 150, links: 120 };
const EMPTY = { template: '', site: '', status: '', from: '', to: '', person: '' };

const linksOf = (e) => [e.linkedTicketId && 'Ticket', e.linkedTaskId && 'Task', e.linkedAssetId && 'Asset'].filter(Boolean).join(', ');

export default function EntriesList({ templates = [], onOpen, selectedId = '', initialTemplate = '', refreshKey = 0 }) {
  const isMobile = useIsMobile();
  const [filters, setFilters] = useState({ ...EMPTY, template: initialTemplate });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);         // { entries, total }
  const [error, setError] = useState('');
  const [sites, setSites] = useState(null);       // null = the person may not list sites
  const [people, setPeople] = useState([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [firstPageLen, setFirstPageLen] = useState(0);
  const cols = useColumnWidths('form-entries', WIDTHS);

  const forms = useMemo(() => templates.filter(isForm).sort((a, b) => String(a.name).localeCompare(String(b.name))), [templates]);

  useEffect(() => { api.getWorkSites().then((r) => setSites(Array.isArray(r) ? r : [])).catch(() => setSites(null)); }, []);
  useEffect(() => {
    api.getPeopleDirectory().then((rows) => setPeople((rows || []).map((u) => ({ email: (u.email || '').toLowerCase(), name: u.name || u.display_name || u.email })).filter((p) => p.email)))
      .catch(() => setPeople([]));
  }, []);

  useEffect(() => {
    let live = true;
    const params = { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), page };
    api.getFormEntries(params)
      .then((r) => {
        if (!live) return;
        const entries = Array.isArray(r?.items) ? r.items : Array.isArray(r?.entries) ? r.entries : [];
        setData({ entries, total: Number(r?.total) || entries.length, pageSize: Number(r?.pageSize) || 0 });
        if (page === 1) setFirstPageLen(entries.length);
        setError('');
      })
      .catch((e) => { if (live) { setError(e?.message || 'Could not load the entries.'); setData((d) => d || { entries: [], total: 0 }); } });
    return () => { live = false; };
  }, [filters, page, refreshKey]);

  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const filtered = Object.values(filters).some(Boolean);
  const entries = data?.entries || [];
  const total = data?.total || 0;
  const pageLen = data?.pageSize || firstPageLen || entries.length || 1;
  const from = total ? (page - 1) * pageLen + 1 : 0;
  const to = total ? (page - 1) * pageLen + entries.length : 0;
  const hasNext = to < total;

  const exportCsv = async () => {
    const tpl = forms.find((t) => t.id === filters.template);
    if (!tpl) return;
    setExporting(true); setExportError('');
    try {
      const { blob, filename } = await api.formTemplateCsv(tpl.id, { from: filters.from, to: filters.to, status: filters.status, site: filters.site });
      saveBlob({ blob, filename: filename || `${String(tpl.name).replace(/[^\w .-]/g, '')}.csv` }, tpl.name);
    } catch (e) { setExportError(e?.message || 'Could not export the entries.'); }
    setExporting(false);
  };

  const onRowKey = (e, row) => {
    if (e.key === 'Enter') { e.preventDefault(); onOpen(row); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
    if (next) { next.focus(); if (selectedId) onOpen(entries.find((x) => x.id === next.dataset.row) || row); }
  };

  const Status = ({ e }) => { const s = entryState(e.status); return <StatusLabel label={s.label} color={s.color} size="sm" />; };

  return (
    <div>
      <div className="nx-dl-tools">
        <select className="form-input" aria-label="Form" style={{ flex: '1 1 180px' }} value={filters.template} onChange={(e) => setFilter('template', e.target.value)}>
          <option value="">All Forms</option>
          {forms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {sites && sites.length > 0 && (
          <select className="form-input" aria-label="Site" style={{ flex: '0 1 160px' }} value={filters.site} onChange={(e) => setFilter('site', e.target.value)}>
            <option value="">All Sites</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <select className="form-input" aria-label="Status" style={{ flex: '0 1 160px' }} value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">Any Status</option>
          {Object.entries(ENTRY_STATES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <DateField value={filters.from} onChange={(v) => setFilter('from', v || '')} placeholder="From" title="From date" />
        <DateField value={filters.to} onChange={(v) => setFilter('to', v || '')} placeholder="To" title="To date" />
        {people.length > 0 && (
          <select className="form-input" aria-label="Person" style={{ flex: '0 1 180px' }} value={filters.person} onChange={(e) => setFilter('person', e.target.value)}>
            <option value="">Anyone</option>
            {people.map((p) => <option key={p.email} value={p.email}>{p.name}</option>)}
          </select>
        )}
        {filtered && <button type="button" className="secondary-btn" onClick={() => { setFilters(EMPTY); setPage(1); }}>Clear</button>}
        <button type="button" className="secondary-btn" disabled={!filters.template || exporting} onClick={exportCsv}
          aria-describedby={filters.template ? undefined : 'form-entries-export-why'}
          title={filters.template ? 'One row per entry, one column per field' : undefined}>
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
        {/* Why the button is off, said on the page - a tooltip never shows on a phone or a disabled button. */}
        {!filters.template && <span id="form-entries-export-why" className="nx-dl-muted" style={{ fontSize: 12, alignSelf: 'center' }}>Pick a form to export - the CSV is one form's entries.</span>}
      </div>
      {exportError && <div role="alert" className="nx-dl-muted" style={{ color: 'hsl(var(--color-red))', marginBottom: 8 }}>{exportError}</div>}

      <AsyncSection loading={!data} error={!!error && !entries.length} errorMessage={error} isEmpty={!!data && entries.length === 0}
        skeleton={<SkeletonBlocks count={6} height={44} />}
        emptyContent={
          <div className="nx-dl-empty">
            <ClipboardList size={32} aria-hidden="true" />
            <p>{filtered ? 'No entries match these filters.' : 'No entries yet. Entries appear here as people fill forms.'}</p>
          </div>
        }>
        {isMobile ? (
          <div className="nx-dl-cards">
            {entries.map((e) => (
              <button key={e.id} type="button" className="nx-dl-card" onClick={() => onOpen(e)} aria-current={selectedId === e.id ? 'true' : undefined}>
                <strong>{e.title}</strong>
                <span className="nx-dl-muted">{e.submittedByName || e.submittedBy}{e.workSiteName ? ` - ${e.workSiteName}` : ''}</span>
                <span className="nx-dl-card-foot"><Status e={e} /><span className="nx-dl-muted">{formatDateTime(e.submittedAt)}</span></span>
              </button>
            ))}
          </div>
        ) : (
          <div className="nx-dl-table">
            <table style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  {COLUMNS.map(([key, label]) => (
                    <th key={key} style={{ position: 'relative', width: cols.width(key) }}>
                      {label}<ColumnResizer {...cols.resizer(key, label)} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} data-row={e.id} tabIndex={0} className={selectedId === e.id ? 'sel' : ''} aria-selected={selectedId === e.id}
                    onClick={() => onOpen(e)} onKeyDown={(ev) => onRowKey(ev, e)}>
                    <td className="nx-dl-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</td>
                    <td className="nx-dl-for" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.submittedByName || e.submittedBy || '-'}</td>
                    <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.workSiteName || '-'}</td>
                    <td className="nx-dl-date">{formatDateTime(e.submittedAt)}</td>
                    <td><Status e={e} /></td>
                    <td className="nx-dl-muted">{linksOf(e) || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > 0 && (
          <nav aria-label="Pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '10px 0' }}>
            <span className="nx-dl-muted" role="status">{from}-{to} of {total}</span>
            <button type="button" className="secondary-btn" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ChevronLeft size={13} /> Previous</button>
            <button type="button" className="secondary-btn" disabled={!hasNext} onClick={() => setPage((p) => p + 1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Next <ChevronRight size={13} /></button>
          </nav>
        )}
      </AsyncSection>
    </div>
  );
}
