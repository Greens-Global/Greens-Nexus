// Documents > Forms (Neil, 11/02/2026): two segments. Templates - the forms
// (DocTemplate rows with docType 'form'): New Form, Build, Publish, Preview,
// Duplicate, Archive, each a row opening beside the list like Templates.
// Entries - what people filled (EntriesList), a row opening beside the list
// (EntryPanel). Nothing here decides anything by itself.
import { useEffect, useMemo, useState } from 'react';
import { ClipboardList, Plus, Search } from 'lucide-react';
import { api } from '../api';
import { formatDate } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { TEMPLATE_STATES, templateStatus } from '../lib/documentLibrary';
import { PanelShell, StatusWord } from '../components/DocumentSidePanel';
import { Spinner } from '../components/AsyncState';
import { ColumnResizer } from '../components/accounting/reportControls';
import { useColumnWidths } from '../components/accounting/tableHooks';
import HoldButton from '../ui/HoldButton';
import { Modal } from '../tasks/components';
import FormBuilder, { FormPreview } from './FormBuilder';
import EntriesList from './EntriesList';
import EntryPanel from './EntryPanel';
import { AUDIENCES, FORM_CATEGORIES, categoryLabel, isForm } from './formsModel';

const audienceWords = (t) => {
  if (t.audience === 'site') return t.workSiteName ? `Site - ${t.workSiteName}` : 'One Work Site';
  if (t.audience === 'department') return t.department ? `${t.department} Department` : 'One Department';
  return AUDIENCES[0][1];
};

function NewFormModal({ onClose, onCreated, toastErr }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('inspection');
  const [busy, setBusy] = useState(false);
  const create = () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    api.createDocTemplate({ name: name.trim(), category, docType: 'form', status: 'draft', department: '' })
      .then((t) => { onCreated(t); onClose(); })
      .catch((e) => toastErr?.(e?.message || 'Could not create the form'))
      .finally(() => setBusy(false));
  };
  return (
    <Modal title="New Form" onClose={onClose} footer={
      <>
        <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-btn" disabled={!name.trim() || busy} onClick={create}>{busy ? 'Creating...' : 'Create and Build'}</button>
      </>
    }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label htmlFor="new-form-name" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Name</label>
          <input id="new-form-name" className="form-input" style={{ width: '100%' }} autoFocus value={name} placeholder="e.g. Vehicle Check"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </div>
        <div>
          <label htmlFor="new-form-category" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Category</label>
          <select id="new-form-category" className="form-input" style={{ width: '100%' }} value={category} onChange={(e) => setCategory(e.target.value)}>
            {FORM_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <p className="nx-dl-muted" style={{ margin: 0 }}>It starts as a draft. Add the fields, pick who fills it, then Publish puts it in front of them on Workday, their shift card and the + menu.</p>
      </div>
    </Modal>
  );
}

function FormPanel({ template: t, onClose, onBuild, onChanged, toastOk, toastErr }) {
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(false);
  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); toastOk?.(ok); await onChanged(); } catch (e) { toastErr?.(e?.message || 'That did not work.'); }
    setBusy('');
  };
  const fields = t.fieldDefs || [];
  return (
    <PanelShell title={t.name} onClose={onClose} subtitle={<StatusWord status={templateStatus(t)} />}>
      <div className="nx-dl-actions">
        <button type="button" className="primary-btn" onClick={() => onBuild(t.id)}>Build</button>
        {t.state !== 'published' && t.state !== 'archived' && (
          <button type="button" className="secondary-btn" disabled={busy === 'publish'} onClick={() => run('publish', () => api.publishDocTemplate(t.id), 'Published')}>
            {busy === 'publish' ? 'Publishing...' : t.state === 'changes' ? 'Publish Changes' : 'Publish'}
          </button>
        )}
        <button type="button" className="secondary-btn" onClick={() => setPreview(true)}>Preview</button>
      </div>
      {t.state === 'draft' && <div className="nx-dl-muted">Nobody can fill a draft. Publishing it puts it in front of the people it is for.</div>}
      {t.state === 'changes' && <div className="nx-dl-muted">People fill version {t.publishedVersion} until the edits are published.</div>}
      <dl className="nx-dl-facts">
        <div><dt>Category</dt><dd>{categoryLabel(t.category)}</dd></div>
        <div><dt>Who Fills It</dt><dd>{audienceWords(t)}</dd></div>
        <div><dt>Shift Cards</dt><dd>{t.showOnShifts ? 'Shown' : 'Not Shown'}</dd></div>
        <div><dt>Fields</dt><dd>{fields.length ? `${fields.length} field${fields.length === 1 ? '' : 's'}` : 'None yet'}</dd></div>
        {t.publishedVersion > 0 && <div><dt>Published</dt><dd>Version {t.publishedVersion}{t.publishedAt ? ` - ${formatDate(t.publishedAt)}` : ''}</dd></div>}
        <div><dt>Updated</dt><dd>{formatDate(t.updatedAt)}</dd></div>
      </dl>
      <section className="nx-dl-section">
        <h4>More</h4>
        <div className="nx-dl-actions">
          <button type="button" className="secondary-btn" disabled={busy === 'dup'} onClick={() => run('dup', () => api.duplicateDocTemplate(t.id), 'Duplicated as a draft')}>Duplicate</button>
          {t.status === 'archived'
            ? <button type="button" className="secondary-btn" disabled={busy === 'arc'} onClick={() => run('arc', () => api.updateDocTemplate(t.id, { status: 'active' }), 'Restored')}>Restore</button>
            : <button type="button" className="secondary-btn" disabled={busy === 'arc'} onClick={() => run('arc', () => api.updateDocTemplate(t.id, { status: 'archived' }), 'Archived')}>Archive</button>}
          <HoldButton size="sm" label="Delete" doneLabel="Deleted" ariaLabel={`Delete form ${t.name}`}
            fallbackMessage={`Delete the form "${t.name}"? This can't be undone.`}
            onConfirm={async () => {
              try { await api.deleteDocTemplate(t.id); }
              catch (e) { throw new Error(e.status === 409 ? 'This form has entries - archive it instead.' : (e.message || 'Failed to delete'), { cause: e }); }
              toastOk?.('Deleted');
              onClose();
              await onChanged();
            }} />
        </div>
      </section>
      {preview && <FormPreview template={t} onClose={() => setPreview(false)} />}
    </PanelShell>
  );
}

const SEGMENTS = [['templates', 'Templates'], ['entries', 'Entries']];
// The templates table (house rule): every column resizes, each person's widths kept.
const TEMPLATE_COLUMNS = [['form', 'Form'], ['category', 'Category'], ['status', 'Status'], ['audience', 'Who Fills It'], ['updated', 'Updated']];
const TEMPLATE_WIDTHS = { form: 240, category: 150, status: 140, audience: 190, updated: 120 };
/** The entry id a 'documents-forms:entry:<id>' sub names, else ''. */
const subEntry = (sub) => /^documents-forms:entry:(.+)$/.exec(String(sub || ''))?.[1] || '';

export default function FormsTab({ toastOk, toastErr, activeSub = '' }) {
  const isMobile = useIsMobile();
  const [segment, setSegment] = useState(() => (subEntry(activeSub) ? 'entries' : 'templates'));
  const [templates, setTemplates] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [statusFilter, setStatusFilter] = useState('current');
  const [selectedId, setSelectedId] = useState('');
  const [building, setBuilding] = useState('');
  const [creating, setCreating] = useState(false);
  const [entry, setEntry] = useState(() => { const id = subEntry(activeSub); return id ? { id } : null; });
  // A bell, a workflow link or "Open the Entry" lands on
  // documents-forms:entry:<id> (views/Documents.jsx) - the one way in.
  useEffect(() => {
    const id = subEntry(activeSub);
    if (id) { setSegment('entries'); setEntry((e) => (e?.id === id ? e : { id })); }
  }, [activeSub]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [entriesKey, setEntriesKey] = useState(0);
  const cols = useColumnWidths('form-templates', TEMPLATE_WIDTHS);

  const load = () => api.getDocTemplates({}).then((rows) => setTemplates((rows || []).filter(isForm))).catch(() => setTemplates([]));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (entry && segment !== 'entries') setSegment('entries'); }, [entry]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (templates || []).filter((t) => {
      if (statusFilter === 'current' ? t.state === 'archived' : t.state !== statusFilter) return false;
      if (category && t.category !== category) return false;
      return !needle || [t.name, categoryLabel(t.category), t.department].some((x) => String(x || '').toLowerCase().includes(needle));
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [templates, search, category, statusFilter]);
  const selected = selectedId ? (templates || []).find((t) => t.id === selectedId) : null;

  if (building) return <FormBuilder templateId={building} toastOk={toastOk} toastErr={toastErr} onClose={() => { setBuilding(''); load(); }} />;

  const onRowKey = (e, t) => {
    if (e.key === 'Enter') { e.preventDefault(); setSelectedId(t.id); return; }
    if (e.key === 'Escape') { setSelectedId(''); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
    if (next) { next.focus(); if (selectedId) setSelectedId(next.dataset.row); }
  };

  const segments = (
    <div role="tablist" aria-label="Forms" className="scroll-tabs" style={{ display: 'inline-flex', gap: 2, padding: 3, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--mist)', marginBottom: 14 }}>
      {SEGMENTS.map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={segment === k} onClick={() => { setSegment(k); setSelectedId(''); }}
          style={{ border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 650, cursor: 'pointer', fontFamily: 'inherit',
            background: segment === k ? 'var(--card)' : 'transparent', color: segment === k ? 'var(--ink)' : 'var(--muted)', boxShadow: segment === k ? 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.08))' : 'none' }}>
          {l}
        </button>
      ))}
    </div>
  );

  if (segment === 'entries') {
    return (
      <div>
        {segments}
        <div className={`nx-dl nx-dl-norail${entry ? ' nx-dl-open' : ''}`}>
          <div className="nx-dl-main">
            <EntriesList templates={templates || []} onOpen={setEntry} selectedId={entry?.id || ''} refreshKey={entriesKey} />
          </div>
          {entry && (
            <EntryPanel key={entry.id} entry={entry} toastOk={toastOk} toastErr={toastErr}
              onClose={() => setEntry(null)} onChanged={() => setEntriesKey((n) => n + 1)} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {segments}
      <div className={`nx-dl nx-dl-norail${selected ? ' nx-dl-open' : ''}`}>
        <div className="nx-dl-main">
          <div className="nx-dl-tools">
            <div className="nx-dl-search">
              <Search size={14} aria-hidden="true" />
              <input className="form-input" placeholder="Search forms" aria-label="Search forms" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select className="form-input" aria-label="Category" style={{ flex: '0 1 170px' }} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All Categories</option>
              {FORM_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select className="form-input" aria-label="Form status" style={{ flex: '0 1 190px' }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="current">Current Forms</option>
              <option value="published">{TEMPLATE_STATES.published.label}</option>
              <option value="changes">{TEMPLATE_STATES.changes.label}</option>
              <option value="draft">{TEMPLATE_STATES.draft.label}</option>
              <option value="archived">{TEMPLATE_STATES.archived.label}</option>
            </select>
            <button type="button" className="primary-btn" onClick={() => setCreating(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Plus size={14} /> New Form
            </button>
          </div>

          {!templates ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>
          ) : visible.length === 0 ? (
            <div className="nx-dl-empty">
              <ClipboardList size={32} aria-hidden="true" />
              <p>{search.trim() ? 'No form matches that search.'
                : statusFilter === 'archived' ? 'No archived forms.'
                : statusFilter === 'draft' ? 'No drafts. Forms you are still building appear here.'
                : 'No forms yet. Build the first one - an inspection, an incident report, a vehicle check, an opening checklist.'}</p>
              {!templates.length && <button type="button" className="primary-btn" onClick={() => setCreating(true)}>New Form</button>}
            </div>
          ) : isMobile ? (
            <div className="nx-dl-cards">
              {visible.map((t) => (
                <button key={t.id} type="button" className="nx-dl-card" onClick={() => setSelectedId(t.id)}>
                  <strong>{t.name}</strong>
                  <span className="nx-dl-muted">{categoryLabel(t.category)} - {audienceWords(t)}</span>
                  <span className="nx-dl-card-foot"><StatusWord status={templateStatus(t)} /><span className="nx-dl-muted">{formatDate(t.updatedAt)}</span></span>
                </button>
              ))}
            </div>
          ) : (
            <div className="nx-dl-table">
              <table style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    {TEMPLATE_COLUMNS.map(([key, label]) => (
                      <th key={key} style={{ position: 'relative', width: cols.width(key) }}>
                        {label}<ColumnResizer {...cols.resizer(key, label)} />
                      </th>
                    ))}
                    <th aria-label="Actions" style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t) => (
                    <tr key={t.id} data-row={t.id} tabIndex={0} className={selectedId === t.id ? 'sel' : ''} aria-selected={selectedId === t.id}
                      onClick={() => setSelectedId(t.id)} onKeyDown={(e) => onRowKey(e, t)}>
                      <td className="nx-dl-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{categoryLabel(t.category)}</td>
                      <td><StatusWord status={templateStatus(t)} /></td>
                      <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{audienceWords(t)}</td>
                      <td className="nx-dl-date">{formatDate(t.updatedAt)}</td>
                      <td className="nx-dl-rowact"><button type="button" className="secondary-btn" onClick={(e) => { e.stopPropagation(); setBuilding(t.id); }}>Build</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selected && (
          <FormPanel key={selected.id} template={selected} toastOk={toastOk} toastErr={toastErr} onChanged={load}
            onClose={() => setSelectedId('')} onBuild={setBuilding} />
        )}
      </div>

      {creating && (
        <NewFormModal toastErr={toastErr} onClose={() => setCreating(false)}
          onCreated={(t) => { toastOk?.('Form created'); setBuilding(t.id); }} />
      )}
    </div>
  );
}
