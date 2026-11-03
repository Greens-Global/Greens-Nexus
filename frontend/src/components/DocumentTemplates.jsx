import { useEffect, useMemo, useState } from 'react';
import { Search, Plus, FileText, Award, Star } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import DocumentBuilder from './DocumentBuilder';
import { setPendingOpen, takePendingOpen } from '../lib/pendingOpen';
import { formatDate } from '../lib/datetime';
import { useIsMobile } from '../lib/useIsMobile';
import { TEMPLATE_STATES, templateStatus, templateUsable } from '../lib/documentLibrary';
import { PanelShell, PdfPreview, StatusWord } from './DocumentSidePanel';
import { CreateDocModal } from './DocumentsBrowser';
import { uploadToSupabase, imageFromPaste } from '../lib/docBuilderUpload';
import { Spinner, ErrorBanner } from './AsyncState';
import SaveRow from './SaveRow';
import { useDraft } from '../lib/useDraft';
import { useGroupDirty } from '../lib/groupDirty';
import WordTemplateWizard from './WordTemplateWizard';
import HoldButton from '../ui/HoldButton';

// ── Document Templates & Letterheads (Phase 3) ───────────────────────────────
// A list over doc_templates with one status per row and a named Use Template
// (Neil, 10/31/2026: Active and Published are one Publish step); a row opens
// beside the list with its page and every action by name. DocumentBuilder (kind=
// "template") edits - same in-tab-replace convention as the library / E-Sign
// (a plain early return, not a portal).
const CATEGORIES = [
  ['letterhead', 'Letterhead'], ['hr', 'HR'], ['legal', 'Legal'], ['finance', 'Finance'],
  ['operations', 'Operations'], ['sales', 'Sales'], ['engineering', 'Engineering'], ['general', 'General'],
  // One per role - the Job Description a hiring packet picks per hire (Oct 14).
  ['job_description', 'Job Description'],
  // The single document an offer is - one per kind of hire (Neil, Oct 14).
  ['offer_letter', 'Offer Letter'],
];

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = { background: 'var(--card)', borderRadius: 16, boxShadow: 'var(--shadow-lg)' };

function CreateTemplateModal({ letterheads, onClose, onCreated, toastErr }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('general');
  const [department, setDepartment] = useState('');
  const [requiresLetterhead, setRequiresLetterhead] = useState(false);
  const [letterheadId, setLetterheadId] = useState('');
  const [busy, setBusy] = useState(false);

  const create = () => {
    if (!name.trim()) return;
    setBusy(true);
    api.createDocTemplate({ name: name.trim(), category, department: department.trim(), status: 'draft', requiresLetterhead, letterheadId: requiresLetterhead ? letterheadId : '' })
      .then(t => { onCreated(t); onClose(); })
      .catch(e => toastErr?.(e.message || 'Failed to create template'))
      .finally(() => setBusy(false));
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div className="nx-popup" style={cardStyle} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700 }}>New Template</div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Name</label>
            <input className="form-input" style={{ width: '100%' }} autoFocus value={name}
              onChange={e => setName(e.target.value)} placeholder="e.g. Vendor Contract"
              onKeyDown={e => e.key === 'Enter' && create()} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Category</label>
            <select className="form-input" style={{ width: '100%' }} value={category} onChange={e => setCategory(e.target.value)}>
              {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Owning department</label>
            <input className="form-input" style={{ width: '100%' }} value={department}
              onChange={e => setDepartment(e.target.value)} placeholder="e.g. Legal"
              onKeyDown={e => e.key === 'Enter' && create()} />
            {/* Requirement 12: department heads maintain their own department's
                approved language. Blank makes it company-wide, which only an
                administrator can create or edit. */}
            <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>
              Department heads maintain their own department's templates. Leave blank for a
              company-wide template (administrators only).
            </p>
          </div>
          {/* Requirement 3: only a published template can be generated from, so
              a draft is the safe place to build one up before anyone uses it. */}
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>
            It starts as a Draft. Once you publish it, people can make documents from it and HR packets can pick it.
          </p>
          <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
            <input type="checkbox" checked={requiresLetterhead} onChange={e => setRequiresLetterhead(e.target.checked)} />
            Requires a letterhead
          </label>
          {requiresLetterhead && (
            <select className="form-input" style={{ width: '100%' }} value={letterheadId} onChange={e => setLetterheadId(e.target.value)}>
              <option value="">Use org default</option>
              {letterheads.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button className="primary-btn" disabled={!name.trim() || busy} onClick={create} style={{ opacity: (!name.trim() || busy) ? 0.6 : 1 }}>
            {busy ? 'Creating…' : 'Create & Edit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// A new letterhead is a draft (the Settings save pattern, Oct 23 2026):
// it says so to the group (lib/groupDirty.js) and has the one Save row at its
// foot - Add Letterhead disabled until it has a name, Discard Changes beside it.
const BLANK_LETTERHEAD = { name: '', address: '', logoPath: '', headerText: '', footerText: '' };
function LetterheadForm({ onSaved, onCancel, toastErr }) {
  const { draft, patch, dirty, reset } = useDraft(BLANK_LETTERHEAD);
  const [busy, setBusy] = useState(false);

  const doUpload = async (file) => {
    const path = `letterheads/${Date.now()}-${(file.name || 'logo').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    if (error) { toastErr?.(error); return; }
    patch({ logoPath: url });
  };

  // True once the letterhead is saved.
  const save = async () => {
    if (!draft.name.trim() || busy) return false;
    setBusy(true);
    const data = {
      name: draft.name.trim(), address: draft.address, logoPath: draft.logoPath,
      headerJson: draft.headerText.trim() ? { text: draft.headerText.trim() } : {},
      footerJson: draft.footerText.trim() ? { text: draft.footerText.trim() } : {},
    };
    try {
      await api.createDocLetterhead(data);
      setBusy(false);
      onSaved();
      return true;
    } catch (e) {
      toastErr?.(e.message || 'Failed to save letterhead');
      setBusy(false);
      return false;
    }
  };
  useGroupDirty(dirty, save);

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--card)' }}
      onPaste={e => { const f = imageFromPaste(e); if (f) { e.preventDefault(); doUpload(f); } }} tabIndex={0}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {draft.logoPath ? <img src={draft.logoPath} alt="" style={{ height: 44, maxWidth: 120, objectFit: 'contain' }} /> : (
          <div style={{ width: 60, height: 44, borderRadius: 6, background: 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}><Award size={18} /></div>
        )}
        <label style={{ fontSize: 11.5, color: 'var(--muted)', cursor: 'pointer' }}>
          Upload logo (or press Ctrl+V to paste)
          <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = ''; }} />
        </label>
      </div>
      <input className="form-input" aria-label="Letterhead name" placeholder="Letterhead name" value={draft.name} onChange={e => patch({ name: e.target.value })} />
      <textarea className="form-input" aria-label="Address" placeholder="Address" rows={2} value={draft.address} onChange={e => patch({ address: e.target.value })} />
      <input className="form-input" aria-label="Header text" placeholder="Header text (e.g. a tagline - optional)" value={draft.headerText} onChange={e => patch({ headerText: e.target.value })} />
      <input className="form-input" aria-label="Footer text" placeholder="Footer text (e.g. registration/disclaimer - optional)" value={draft.footerText} onChange={e => patch({ footerText: e.target.value })} />
      <SaveRow dirty={dirty} busy={busy} onSave={save} onDiscard={reset} label="Add Letterhead" saveDisabled={!draft.name.trim()}
        note="A letterhead needs a name.">
        {!dirty && <button type="button" className="secondary-btn" onClick={onCancel} style={{ fontSize: 12.5 }}>Cancel</button>}
      </SaveRow>
    </div>
  );
}

// Settings > Branding & Email > Letterheads (Oct 23) - the Templates screen's
// Letterheads tab points there. Make Default saves on click; Delete is held
// on its card (Hold to confirm, Oct 30 2026); a failed load says so with Retry.
export function LetterheadsPanel({ toastOk, toastErr }) {
  const { can } = useRole();
  const isAdmin = can('administrator');
  const [letterheads, setLetterheads] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [adding, setAdding] = useState(false);

  const load = () => api.getDocLetterheads()
    .then(rows => { setLoadErr(''); setLetterheads(rows || []); })
    .catch(() => setLoadErr('The letterheads could not be loaded right now.'));
  useEffect(() => { load(); }, []);

  const setDefault = (id) => api.updateDocLetterhead(id, { isDefault: true }).then(() => { toastOk?.('Default letterhead updated'); load(); }).catch(e => toastErr?.(e.message));

  if (loadErr && !letterheads) return <ErrorBanner message={loadErr} onRetry={() => { setLoadErr(''); load(); }} />;
  if (!letterheads) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>;

  return (
    <div>
      {!isAdmin && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>Only administrators can add or edit letterheads.</div>
      )}
      {letterheads.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: isAdmin ? 14 : 0 }}>No letterheads yet.</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: isAdmin && letterheads.length ? 20 : 0 }}>
        {letterheads.map(l => (
          <div key={l.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--card)' }}>
            {l.logoPath ? <img src={l.logoPath} alt="" style={{ height: 36, maxWidth: '100%', objectFit: 'contain', marginBottom: 8 }} /> : null}
            <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              {l.name}
              {l.isDefault && <span style={{ padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 800, color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.12)' }}>Default</span>}
            </div>
            {l.address && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{l.address}</div>}
            {isAdmin && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
                {!l.isDefault && (
                  <button type="button" onClick={() => setDefault(l.id)} title="Make Default" aria-label={`Make ${l.name} the default`}
                    style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: 6, cursor: 'pointer', display: 'flex' }}><Star size={13} /></button>
                )}
                <HoldButton size="sm" label="Delete" doneLabel="Deleted" ariaLabel={`Delete letterhead ${l.name}`}
                  fallbackMessage={`Delete letterhead "${l.name}"?`}
                  onConfirm={async () => {
                    try { await api.deleteDocLetterhead(l.id); }
                    catch (e) { throw new Error(e?.message || 'Could not delete the letterhead.', { cause: e }); }
                    toastOk?.('Deleted');
                    await load();
                  }} />
              </div>
            )}
          </div>
        ))}
      </div>
      {isAdmin && (adding ? (
        <LetterheadForm toastErr={toastErr} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); toastOk?.('Letterhead saved'); load(); }} />
      ) : (
        <button type="button" className="primary-btn" onClick={() => setAdding(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <Plus size={13} /> Add Letterhead
        </button>
      ))}
    </div>
  );
}

// Which department keeps a template's wording. Was a browser prompt.
function DepartmentModal({ template, onClose, onSaved, toastErr }) {
  const [department, setDepartment] = useState(template.department || '');
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    api.updateDocTemplate(template.id, { department: department.trim() })
      .then(() => { onSaved(department.trim()); onClose(); })
      .catch(e => toastErr?.(e.message || 'Could not change the owning department'))
      .finally(() => setBusy(false));
  };
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div className="nx-popup" style={cardStyle} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700 }}>Change Department</div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label htmlFor="template-department" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Which department maintains "{template.name}"?</label>
          <input id="template-department" className="form-input" autoFocus value={department} onChange={e => setDepartment(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); }} placeholder="e.g. Legal" />
          <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>Leave blank for a company-wide template, which only an administrator can edit.</p>
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 'auto' }}>
          <button onClick={onClose} className="secondary-btn">Cancel</button>
          <button className="primary-btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

const categoryLabel = (key) => CATEGORIES.find(([v]) => v === key)?.[1] || key;

// The row a template opens beside the list: its page, one status and every action by name.
function TemplatePanel({ template: t, onClose, onEdit, onUse, onDepartment, onChanged, toastOk, toastErr }) {
  const [busy, setBusy] = useState('');
  const [versions, setVersions] = useState([]);
  useEffect(() => {
    let live = true;
    api.getDocTemplateVersions(t.id).then(r => { if (live) setVersions(r || []); }).catch(() => {});
    return () => { live = false; };
  }, [t.id, t.version]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); toastOk?.(ok); await onChanged(); }
    catch (e) { toastErr?.(e?.message || 'That did not work.'); }
    setBusy('');
  };
  const publish = () => run('publish', () => api.publishDocTemplate(t.id), 'Published');
  const usable = templateUsable(t);
  return (
    <PanelShell title={t.name} onClose={onClose} subtitle={<StatusWord status={templateStatus(t)} />}>
      <PdfPreview key={`${t.id}:${t.publishedVersion}:${t.state === 'draft' ? t.version : ''}`} label={`Preview of ${t.name}`}
        load={() => api.docTemplatePreviewPdf(t.id)} />
      <div className="nx-dl-actions">
        {usable && <button type="button" className="primary-btn" onClick={() => onUse(t)}>Use Template</button>}
        {t.state !== 'published' && t.state !== 'archived' && (
          <button type="button" className={usable ? 'secondary-btn' : 'primary-btn'} disabled={busy === 'publish'} onClick={publish}>
            {busy === 'publish' ? 'Publishing…' : t.state === 'changes' ? 'Publish Changes' : 'Publish'}
          </button>
        )}
        <button type="button" className="secondary-btn" onClick={() => onEdit(t.id)}>Edit</button>
      </div>
      {t.state === 'changes' && <div className="nx-dl-muted">New documents and HR packets use version {t.publishedVersion} until these edits are published.</div>}
      {t.state === 'draft' && <div className="nx-dl-muted">Nobody can make documents from a draft. Publishing it makes it usable, and HR packets can pick it.</div>}
      <dl className="nx-dl-facts">
        <div><dt>Category</dt><dd>{categoryLabel(t.category)}</dd></div>
        <div><dt>Maintained By</dt><dd>{t.department || 'Company-Wide'}</dd></div>
        {t.requiresLetterhead && <div><dt>Letterhead</dt><dd>Required</dd></div>}
        {t.publishedVersion > 0 && <div><dt>Published</dt><dd>Version {t.publishedVersion}{t.publishedAt ? ` - ${formatDate(t.publishedAt)}` : ''}</dd></div>}
        <div><dt>Updated</dt><dd>{formatDate(t.updatedAt)}</dd></div>
      </dl>
      {versions.length > 1 && (
        <section className="nx-dl-section">
          <h4>Version History</h4>
          {versions.slice(0, 5).map(v => (
            <div key={v.id} className="nx-dl-version">
              <span>Version {v.versionNo}</span>
              <span className="nx-dl-muted">{formatDate(v.editedAt)}{v.note ? ` - ${v.note}` : ''}</span>
            </div>
          ))}
        </section>
      )}
      <section className="nx-dl-section">
        <h4>More</h4>
        <div className="nx-dl-actions">
          <button type="button" className="secondary-btn" onClick={() => onDepartment(t)}>Change Department</button>
          <button type="button" className="secondary-btn" disabled={busy === 'dup'} onClick={() => run('dup', () => api.duplicateDocTemplate(t.id), 'Duplicated as a draft')}>Duplicate</button>
          {t.status === 'archived'
            ? <button type="button" className="secondary-btn" disabled={busy === 'arc'} onClick={() => run('arc', () => api.updateDocTemplate(t.id, { status: 'active' }), 'Restored')}>Restore</button>
            : <button type="button" className="secondary-btn" disabled={busy === 'arc'} onClick={() => run('arc', () => api.updateDocTemplate(t.id, { status: 'archived' }), 'Archived')}>Archive</button>}
          {/* Held (Neil, Oct 30 2026); a refusal rewinds the button with the reason. */}
          <HoldButton size="sm" label="Delete" doneLabel="Deleted" ariaLabel={`Delete template ${t.name}`}
            fallbackMessage={`Delete template "${t.name}"? This can't be undone.`}
            onConfirm={async () => {
              try { await api.deleteDocTemplate(t.id); }
              catch (e) { throw new Error(e.status === 409 ? 'This template has generated documents - archive it instead.' : (e.message || 'Failed to delete'), { cause: e }); }
              toastOk?.('Deleted');
              onClose();
              await onChanged();
            }} />
        </div>
      </section>
    </PanelShell>
  );
}

export default function DocumentTemplates({ employees = [], entities = [], toastOk, toastErr }) {
  const isMobile = useIsMobile();
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('current');   // current|published|changes|draft|archived
  const [templates, setTemplates] = useState(null);
  const [letterheads, setLetterheads] = useState([]);
  const [folders, setFolders] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [wordOpen, setWordOpen] = useState(false);       // New template from a Word file (Oct 14)
  // Open In Documents from an HR packet (Oct 14) lands straight in the editor.
  const [editingId, setEditingId] = useState(() => takePendingOpen('doc-template'));
  const [selectedId, setSelectedId] = useState('');
  const [useId, setUseId] = useState('');
  const [departmentOf, setDepartmentOf] = useState(null);
  const [seeding, setSeeding] = useState(false);
  // Starters are add-if-missing on the server, so an administrator can pull a
  // newly shipped starter (the Unsecured Promissory Note, Sep 29) into a
  // library that already has templates - the empty-state button alone only
  // ever reached a brand-new library.
  const { can } = useRole();
  const isAdmin = can('administrator');

  const load = () => api.getDocTemplates({}).then(setTemplates).catch(() => setTemplates([]));

  useEffect(() => { load(); }, []);
  useEffect(() => { api.getDocLetterheads().then(setLetterheads).catch(() => setLetterheads([])); }, []);
  useEffect(() => { api.getDocFolders().then(setFolders).catch(() => setFolders([])); }, []);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (templates || []).filter(t => {
      if (t.docType === 'form') return false;   // Documents > Forms (Neil, 11/02/2026)
      if (statusFilter === 'current' ? t.state === 'archived' : t.state !== statusFilter) return false;
      if (category && t.category !== category) return false;
      return !needle || [t.name, categoryLabel(t.category), t.department, ...(t.tags || [])]
        .some(x => String(x || '').toLowerCase().includes(needle));
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [templates, search, statusFilter, category]);
  const selected = selectedId ? (templates || []).find(t => t.id === selectedId) : null;

  const seedStarters = () => {
    setSeeding(true);
    api.seedDocTemplateStarters().then(r => { toastOk?.(`Added ${r.added} starter template${r.added === 1 ? '' : 's'}`); load(); })
      .catch(e => toastErr?.(e.message || 'Failed to seed starters')).finally(() => setSeeding(false));
  };

  const onRowKey = (e, t) => {
    if (e.key === 'Enter') { e.preventDefault(); setSelectedId(t.id); return; }
    if (e.key === 'Escape') { setSelectedId(''); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
    if (next) { next.focus(); if (selectedId) setSelectedId(next.dataset.row); }
  };

  if (editingId) return (
    <DocumentBuilder docId={editingId} kind="template" toastOk={toastOk} toastErr={toastErr}
      onClose={() => { setEditingId(null); load(); }} />
  );

  const rowAction = (t) => (templateUsable(t)
    ? <button type="button" className="secondary-btn" onClick={(e) => { e.stopPropagation(); setUseId(t.id); }}>Use Template</button>
    : t.state === 'draft'
      ? <button type="button" className="secondary-btn" onClick={(e) => { e.stopPropagation(); setEditingId(t.id); }}>Edit</button>
      : null);

  return (
    <div className={`nx-dl nx-dl-norail${selected ? ' nx-dl-open' : ''}`}>
      <div className="nx-dl-main">
        <div className="nx-dl-tools">
          <div className="nx-dl-search">
            <Search size={14} aria-hidden="true" />
            <input className="form-input" placeholder="Search templates" aria-label="Search templates" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="form-input" aria-label="Category" style={{ flex: '0 1 170px' }} value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">All Categories</option>
            {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="form-input" aria-label="Template status" style={{ flex: '0 1 190px' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="current">Current Templates</option>
            <option value="published">{TEMPLATE_STATES.published.label}</option>
            <option value="changes">{TEMPLATE_STATES.changes.label}</option>
            <option value="draft">{TEMPLATE_STATES.draft.label}</option>
            <option value="archived">{TEMPLATE_STATES.archived.label}</option>
          </select>
          {isAdmin && templates?.length > 0 && (
            <button className="secondary-btn" disabled={seeding} onClick={seedStarters} title="Add any starter template the library does not have yet">
              {seeding ? 'Adding…' : 'Add Starter Templates'}
            </button>
          )}
          <button className="secondary-btn" title="Letterheads are under Settings > Branding & Email"
            onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'admin-console', sub: 'branding:letterheads' } }))}>
            Letterheads
          </button>
          <button className="secondary-btn" onClick={() => setWordOpen(true)} title="Nexus reads the Word file and finds every blank and signature line">From Word File</button>
          <button className="primary-btn" data-tour="documents-new-template" onClick={() => setCreateOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> New Template
          </button>
        </div>

        {!templates ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Spinner size="section" /></div>
        ) : visible.length === 0 ? (
          <div className="nx-dl-empty">
            <FileText size={32} aria-hidden="true" />
            <p>{search.trim() ? 'No template matches that search.'
              : statusFilter === 'archived' ? 'No archived templates.'
              : statusFilter === 'draft' ? 'No drafts. Templates you are still writing appear here.'
              : 'No templates here yet.'}</p>
            {!templates.length && (
              <button className="primary-btn" disabled={seeding} onClick={seedStarters}>{seeding ? 'Adding…' : 'Add Starter Templates'}</button>
            )}
          </div>
        ) : isMobile ? (
          <div className="nx-dl-cards">
            {visible.map(t => (
              <button key={t.id} type="button" className="nx-dl-card" onClick={() => setSelectedId(t.id)}>
                <strong>{t.name}</strong>
                <span className="nx-dl-muted">{categoryLabel(t.category)} - {t.department || 'Company-Wide'}</span>
                <span className="nx-dl-card-foot"><StatusWord status={templateStatus(t)} /><span className="nx-dl-muted">{formatDate(t.updatedAt)}</span></span>
              </button>
            ))}
          </div>
        ) : (
          <div className="nx-dl-table">
            <table>
              <thead><tr><th>Template</th><th>Category</th><th>Status</th><th>Maintained By</th><th>Updated</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {visible.map(t => (
                  <tr key={t.id} data-row={t.id} tabIndex={0} className={selectedId === t.id ? 'sel' : ''} aria-selected={selectedId === t.id}
                    onClick={() => setSelectedId(t.id)} onKeyDown={e => onRowKey(e, t)}>
                    <td className="nx-dl-name">{t.name}</td>
                    <td>{categoryLabel(t.category)}</td>
                    <td><StatusWord status={templateStatus(t)} /></td>
                    <td>{t.department || 'Company-Wide'}</td>
                    <td className="nx-dl-date">{formatDate(t.updatedAt)}</td>
                    <td className="nx-dl-rowact">{rowAction(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <TemplatePanel key={selected.id} template={selected} toastOk={toastOk} toastErr={toastErr} onChanged={load}
          onClose={() => setSelectedId('')} onEdit={setEditingId} onUse={(t) => setUseId(t.id)} onDepartment={setDepartmentOf} />
      )}

      {createOpen && (
        <CreateTemplateModal letterheads={letterheads} toastErr={toastErr}
          onClose={() => setCreateOpen(false)}
          onCreated={(t) => { toastOk?.('Template created'); setEditingId(t.id); }} />
      )}
      {wordOpen && (
        <WordTemplateWizard categories={CATEGORIES.filter(([v]) => v !== 'letterhead')} toastErr={toastErr}
          onClose={() => { setWordOpen(false); load(); }}
          onOpen={(id) => { setWordOpen(false); load(); setEditingId(id); }} />
      )}
      {departmentOf && (
        <DepartmentModal template={departmentOf} toastErr={toastErr} onClose={() => setDepartmentOf(null)}
          onSaved={(d) => { toastOk?.(d ? `Now maintained by ${d}` : 'Now company-wide'); load(); }} />
      )}
      {useId && (
        <CreateDocModal folders={folders} employees={employees} entities={entities} initialTemplateId={useId} toastErr={toastErr}
          onClose={() => setUseId('')}
          onCreated={(doc) => {
            toastOk?.('Document made');
            // It lands in the library, open beside the list.
            setPendingOpen('document', doc.id);
            window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-browse' } }));
          }} />
      )}
    </div>
  );
}
