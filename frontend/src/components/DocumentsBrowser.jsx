import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import AnchoredMenu from './AnchoredMenu';
import { UNTITLED_DOCUMENT, UNTITLED_SHEET } from '../lib/untitled';
import { generateJSON } from '@tiptap/core';
import { Search, FilePlus2, FileText, FolderPlus, X, Upload, Cloud, ChevronUp, ChevronDown, Sheet as SheetIcon, LayoutTemplate } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import { formatDate } from '../lib/datetime';
import DocumentBuilder from './DocumentBuilder';
import EgnyteBrowser from './EgnyteBrowser';
import { BODY_EXTENSIONS } from '../lib/docBuilderSchema';
import { uploadToSupabase } from '../lib/docBuilderUpload';
import AsyncSection, { SkeletonBlocks } from './AsyncState';
import { importDocumentFile } from '../lib/docBuilderImport';
import TypedFieldInput from './TypedFieldInput';
import DocumentSidePanel, { StatusWord } from './DocumentSidePanel';
import { PersonSelect } from '../tasks/components';
import { takePendingOpen } from '../lib/pendingOpen';
import { useIsMobile } from '../lib/useIsMobile';
import { VIEWS, folderKey, mergeRows, rowFor, rowStatus, rowsInView, searchRows, sortRows, startView } from '../lib/documentLibrary';
import { validateFieldValue, formatFieldValue, RESERVED_TYPES, isAutoToken } from '../lib/mergeFieldTypes';

// Sheets (Neil, 11/05/2026): the workbook page and its engine load when a sheet is opened or made.
const SheetWorkspace = lazy(() => import('../docLive/SheetWorkspace'));
const SHEET_FILE = /\.(xlsx|xls|csv)$/i;

// ── The library (Neil, 10/31/2026) ───────────────────────────────────────────
// One list of every document and envelope the caller may see, with who it is
// for and where it stands (lib/documentLibrary.js); a row opens beside the list
// (DocumentSidePanel.jsx). Editing opens DocumentBuilder in place - same "replace
// the tab content" convention ESign.jsx uses (a plain early return, not a portal).
// Nexus Sign stays its own tab, as Neil decided; this list reads its status.

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = { background: 'var(--card)', borderRadius: 16, boxShadow: 'var(--shadow-lg)' };

// Use Template on the Templates tab opens this too, with the template picked.
// Import on the list opens this with the file already picked (Pranshu, 11/05/2026).
export function CreateDocModal({ folders = [], employees = [], entities = [], initialTemplateId = '', initialFile = null, onClose, onCreated, toastErr }) {
  const [title, setTitle] = useState(initialFile ? initialFile.name.replace(/\.[^.]+$/, '') : '');
  const [titleTyped, setTitleTyped] = useState(!!initialFile);
  const [folderId, setFolderId] = useState('');
  const [templateId, setTemplateId] = useState(initialTemplateId);
  // Who the document is about and for which company: what tells two letters with
  // the same title apart, and what its merge fields fill in from.
  const [personEmail, setPersonEmail] = useState(null);
  const [entityId, setEntityId] = useState('');
  const [templates, setTemplates] = useState([]);
  const [importFile, setImportFile] = useState(initialFile);
  const [busy, setBusy] = useState(false);
  const [egnyteOpen, setEgnyteOpen] = useState(false);
  const importInputRef = useRef(null);
  // Template Builder (Phase 13) - "Select Template -> Fill Dynamic Fields ->
  // Generate": once a template with field_defs is picked, fetch its fields
  // and render one typed control each, right in this same modal rather than
  // a separate "Generate Document" screen - one flow, no duplicated
  // template-picker UI.
  const [fieldDefs, setFieldDefs] = useState([]);
  const [fillValues, setFillValues] = useState({});
  const [fillErrors, setFillErrors] = useState({});

  useEffect(() => { api.getDocTemplates({ status: 'active' }).then(setTemplates).catch(() => setTemplates([])); }, []);

  const people = useMemo(() => {
    const seen = new Set();
    return employees.map(e => {
      let email = (e.workEmail || '').toLowerCase();
      if (!email || seen.has(email)) email = `id:${e.id}`.toLowerCase();
      seen.add(email);
      return { id: e.id, email, company: e.company || '', name: `${e.firstName || ''} ${e.lastName || ''}`.trim() || e.workEmail || e.id };
    });
  }, [employees]);
  const person = people.find(p => p.email === personEmail) || null;
  const template = templates.find(t => t.id === templateId) || null;
  const suggestedTitle = template ? (person ? `${template.name} - ${person.name}` : template.name) : '';
  const shownTitle = titleTyped ? title : (suggestedTitle || title);
  const pickPerson = (email) => {
    setPersonEmail(email);
    const company = people.find(p => p.email === email)?.company;
    if (company && entities.some(x => x.id === company)) setEntityId(company);
  };

  useEffect(() => {
    setFillValues({}); setFillErrors({});
    if (!templateId) { setFieldDefs([]); return; }
    // A `template.*` variable is filled by the system from the template row
    // (its name, version, last-updated date, owning department), so the wizard
    // must not ask a person for it - typing your own template's version number
    // is exactly the manual work this module exists to remove, and a
    // hand-typed one can be wrong.
    api.getDocTemplate(templateId)
      .then(t => setFieldDefs((t.releasedFieldDefs || t.fieldDefs || []).filter(fd => !isAutoToken(fd.token))))
      .catch(() => setFieldDefs([]));
  }, [templateId]);

  const setFillValue = (token, v) => setFillValues(prev => ({ ...prev, [token]: v }));

  const uploadImportedImage = async (docId, bytes, mime, n) => {
    const extGuess = (mime || '').split('/')[1]?.split('+')[0] || 'png';
    const path = `${docId}/imported-${Date.now()}-${n}.${extGuess}`;
    const file = new File([bytes], `imported-${n}.${extGuess}`, { type: mime || 'image/png' });
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    return error ? '' : url;
  };

  const pickImportFile = (file) => {
    setImportFile(file);
    setTemplateId('');
    setFieldDefs([]); setFillValues({}); setFillErrors({});
    if (!shownTitle.trim()) { setTitle(file.name.replace(/\.[^.]+$/, '')); setTitleTyped(true); }
  };

  const onPickImportFile = (e) => {
    const file = e.target.files?.[0];
    if (file) pickImportFile(file);
    e.target.value = '';
  };

  const onPickEgnyteFile = (file) => {
    pickImportFile(file);
    setEgnyteOpen(false);
  };

  // The name is optional (Neil, 11/10/2026): blank is "Untitled Document" and
  // the editor asks for a real one on Close (lib/untitled.js).
  const create = async () => {
    // Required-field guard mirrors the server's own check (documents.py
    // create_document) - client-side so the user sees it inline instead of
    // a rejected request, not a substitute for it.
    if (!importFile && fieldDefs.length) {
      const errs = {};
      for (const fd of fieldDefs) {
        const err = validateFieldValue(fd, fillValues[fd.token]);
        if (err) errs[fd.token] = err;
      }
      setFillErrors(errs);
      if (Object.keys(errs).length) return;
    }
    setBusy(true);
    let created = null;
    try {
      const fillPayload = Object.fromEntries(
        fieldDefs.filter(fd => !RESERVED_TYPES.includes(fd.type) && !validateFieldValue(fd, fillValues[fd.token]) && fillValues[fd.token] !== undefined && fillValues[fd.token] !== '')
          .map(fd => [fd.token, formatFieldValue(fd, fillValues[fd.token])])
      );
      created = await api.createDocument({
        title: shownTitle.trim() || UNTITLED_DOCUMENT, folderId, templateId: importFile ? '' : templateId,
        ...(person ? { employeeId: person.id } : {}),
        ...(entityId ? { entityId } : {}),
        ...(Object.keys(fillPayload).length ? { fillValues: fillPayload } : {}),
      });
      if (importFile) {
        const { html, json: directJson, pageSetup: importedPageSetup, warnings } = await importDocumentFile(importFile, {
          uploadImage: (bytes, mime, n) => uploadImportedImage(created.id, bytes, mime, n),
        });
        const json = directJson || generateJSON(html || '<p></p>', BODY_EXTENSIONS);
        // .docx imports carry the source file's own page size/orientation/
        // margins (docxToTiptap.js) - applied to the new document instead of
        // leaving it on the default Letter/Portrait/Normal.
        await api.updateDocument(created.id, { content: { body: json, header: null, footer: null, ...(importedPageSetup ? { pageSetup: importedPageSetup } : {}) } });
        if (warnings?.length) toastErr?.(`Imported with notes: ${warnings.slice(0, 2).join(' ')}`);
      }
      onCreated(created);
      onClose();
    } catch (e) {
      // If the draft row was already created but the import itself failed,
      // don't leave an empty orphaned draft behind - clean it up so a failed
      // import doesn't clutter the document list.
      if (created && importFile) api.deleteDocument(created.id).catch(() => {});
      toastErr?.(e.message || 'Failed to create document');
    } finally {
      setBusy(false);
    }
  };

  // A form, so a sheet from the right (CLAUDE.md popups): the Sheets CSS
  // block keys on .modal-overlay > .modal-content.nx-popup.
  return (
    <div className="modal-overlay" style={{ ...overlayStyle, alignItems: undefined, justifyContent: undefined, padding: undefined }} onClick={onClose}>
      <div className="modal-content nx-popup" style={{ ...cardStyle, display: 'flex', flexDirection: 'column', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700 }}>New Document</div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Name (optional)</label>
            <input className="form-input" style={{ width: '100%' }} autoFocus value={shownTitle} aria-label="Name"
              onChange={e => { setTitle(e.target.value); setTitleTyped(true); }} placeholder="Untitled Document - you can name it later"
              onKeyDown={e => e.key === 'Enter' && create()} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Folder</label>
            <select className="form-input" style={{ width: '100%' }} value={folderId} onChange={e => setFolderId(e.target.value)}>
              <option value="">No folder</option>
              {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Start from template (optional)</label>
            <select className="form-input" style={{ width: '100%', opacity: importFile ? 0.5 : 1 }} value={templateId} disabled={!!importFile}
              onChange={e => setTemplateId(e.target.value)}>
              <option value="">Blank document</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          {(people.length > 0 || entities.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
              {people.length > 0 && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>For (optional)</label>
                  <PersonSelect value={personEmail} onChange={pickPerson} people={people} placeholder="Nobody in particular" noneLabel="Nobody in particular" ariaLabel="Who this document is for"
                    style={{ height: 36, padding: '0 13px', borderRadius: 10, fontSize: 12.5, fontWeight: 400 }} />
                </div>
              )}
              {entities.length > 0 && (
                <div>
                  <label htmlFor="new-doc-company" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Company (optional)</label>
                  <select id="new-doc-company" className="form-input" style={{ width: '100%' }} value={entityId} onChange={e => setEntityId(e.target.value)}>
                    <option value="">None</option>
                    {entities.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}

          {fieldDefs.length > 0 && !importFile && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>Fill in the details</div>
              {fieldDefs.map(fd => (
                <div key={fd.token}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>
                    {fd.label}{fd.required && !RESERVED_TYPES.includes(fd.type) && <span style={{ color: 'hsl(var(--color-red))' }}> *</span>}
                  </label>
                  <TypedFieldInput def={fd} value={fillValues[fd.token]} error={fillErrors[fd.token]}
                    onChange={(v) => setFillValue(fd.token, v)} />
                  {fillErrors[fd.token] && <p style={{ fontSize: 11, color: 'hsl(var(--color-red))', margin: '4px 0 0' }}>{fillErrors[fd.token]}</p>}
                </div>
              ))}
            </div>
          )}

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Import from file (optional)</label>
            {importFile ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <FileText size={14} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{importFile.name}</span>
                <button onClick={() => setImportFile(null)}
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer' }}>Remove</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => importInputRef.current?.click()} disabled={!!templateId}
                  style={{ background: 'none', border: '1px dashed var(--line)', borderRadius: 8, padding: '9px 12px', flex: 1, cursor: templateId ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ink)', opacity: templateId ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                  <Upload size={14} /> Choose file…
                </button>
                <button onClick={() => setEgnyteOpen(true)} disabled={!!templateId}
                  style={{ background: 'none', border: '1px dashed var(--line)', borderRadius: 8, padding: '9px 12px', flex: 1, cursor: templateId ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--ink)', opacity: templateId ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
                  <Cloud size={14} /> Browse Egnyte…
                </button>
              </div>
            )}
            {egnyteOpen && <EgnyteBrowser onPick={onPickEgnyteFile} onClose={() => setEgnyteOpen(false)} />}
            <input ref={importInputRef} type="file" accept=".docx,.doc,.pdf,.txt" onChange={onPickImportFile} style={{ display: 'none' }} />
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {templateId && !importFile ? 'Made from the published wording. It opens beside the list, ready to send.' : 'Opens straight into the editor once created.'}
          </div>
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button className="primary-btn" disabled={busy} onClick={create} style={{ opacity: busy ? 0.6 : 1 }}>
            {busy ? (importFile ? 'Importing…' : 'Creating…') : (templateId && !importFile ? 'Make Document' : 'Create Draft')}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewFolderModal({ onClose, onCreated, toastErr }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = () => {
    if (!name.trim()) return;
    setBusy(true);
    api.createDocFolder({ name: name.trim() })
      .then(f => { onCreated(f); onClose(); })
      .catch(e => toastErr?.(e.message || 'Failed to create folder'))
      .finally(() => setBusy(false));
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div className="nx-popup" style={cardStyle} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700 }}>New Folder</div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Folder name</label>
          <input className="form-input" autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') create(); }} placeholder="e.g. Board Minutes" />
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            Shared with everyone who can see Documents. Your own drafts can stay in Personal.
          </div>
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button className="primary-btn" disabled={!name.trim() || busy} onClick={create} style={{ opacity: (!name.trim() || busy) ? 0.6 : 1 }}>
            {busy ? 'Creating…' : 'Create Folder'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Folder + tags on one document. Both are plain PATCH fields the API has
// always accepted - and no version row is written unless `content` changes, so
// re-filing or re-tagging never pollutes the document's history.
function OrganizeModal({ doc, folders, onClose, onSaved, toastErr }) {
  const [folderId, setFolderId] = useState(doc.folderId || '');
  const [tags, setTags] = useState(doc.tags || []);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const addTag = (raw) => {
    const t = String(raw || '').trim().toLowerCase();
    setDraft('');
    if (!t || tags.includes(t) || tags.length >= 20) return;
    setTags([...tags, t]);
  };
  const onTagKey = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(draft); }
    // Backspace on an empty box pulls the last chip back off.
    else if (e.key === 'Backspace' && !draft && tags.length) setTags(tags.slice(0, -1));
  };

  const save = () => {
    setBusy(true);
    // Whatever is still sitting in the box counts as typed - saving without
    // pressing Enter first should not silently drop it.
    const typed = draft.trim().toLowerCase();
    const finalTags = typed && !tags.includes(typed) ? [...tags, typed] : tags;
    api.updateDocument(doc.id, { folderId, tags: finalTags })
      .then(d => { onSaved(d); onClose(); })
      .catch(e => toastErr?.(e.message || 'Failed to save'))
      .finally(() => setBusy(false));
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div className="nx-popup" style={cardStyle} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Folder and Tags
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Folder</label>
            <select className="form-input" style={{ width: '100%' }} value={folderId} onChange={e => setFolderId(e.target.value)}>
              <option value="">No folder</option>
              {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Tags</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', minHeight: 38 }}>
              {tags.map(t => (
                <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: 'var(--mist)', color: 'var(--ink)' }}>
                  {t}
                  <button type="button" aria-label={'Remove ' + t} onClick={() => setTags(tags.filter(x => x !== t))}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', color: 'var(--muted)' }}><X size={11} /></button>
                </span>
              ))}
              <input className="nx-inline-edit" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onTagKey} onBlur={() => addTag(draft)}
                aria-label="Add a tag" placeholder={tags.length ? '' : 'Add a tag and press Enter'}
                style={{ border: 'none', fontSize: 12.5, fontFamily: 'Inter,sans-serif', color: 'var(--ink)', flex: '1 1 90px', minWidth: 90 }} />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Tags are searchable from the Documents search bar. Up to 20 per document.
            </div>
          </div>
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button className="primary-btn" disabled={busy} onClick={save} style={{ opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

export default function DocumentsBrowser({ openCreateSignal, initialView = '', employees = [], entities = [], toastOk, toastErr }) {
  const isMobile = useIsMobile();
  const [folders, setFolders] = useState([]);
  const [rows, setRows] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [hrAccess, setHrAccess] = useState(false);
  const [view, setView] = useState(initialView);
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'updatedAt', dir: 'desc' });
  const [createOpen, setCreateOpen] = useState(false);   // true, or { file } from the Import button
  const importRef = useRef(null);
  const [editingDoc, setEditingDoc] = useState(null);
  const [editingSheet, setEditingSheet] = useState(null);
  const [makingSheet, setMakingSheet] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [organizeDoc, setOrganizeDoc] = useState(null);
  // Adding a shared folder is an admin action server-side (POST
  // /documents/folders is level >= administrator), so don't offer the button
  // to anyone who would only get a 403 out of it.
  const { can } = useRole();
  const canAddFolder = can('administrator');

  const load = async () => {
    // HR Records answers only for whoever may read People; the server is the gate.
    // Form entries (Neil, 11/02/2026): the viewer's reach, first page - the
    // whole list with its filters is Documents > Forms > Entries.
    const [library, hr, forms] = await Promise.all([
      api.getDocumentLibrary().then((r) => { setLoadError(''); return r; })
        .catch((e) => { setLoadError(e?.message || 'Could not load documents.'); return []; }),
      api.listPacketDocuments({}).then((r) => { setHrAccess(true); return r; })
        .catch(() => { setHrAccess(false); return []; }),
      Promise.resolve().then(() => api.getFormEntries({ page: 1 })).then((r) => (Array.isArray(r?.items) ? r.items : [])).catch(() => []),
    ]);
    const merged = mergeRows(library, hr, forms);
    setRows(merged);
    setView((v) => v || startView(merged));
    // A document just made from a template lands here, open beside the list.
    const opened = takePendingOpen('document');
    if (opened) { setView('all'); setSelectedId(opened); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { api.getDocFolders().then(setFolders).catch(() => setFolders([])); }, []);

  const all = useMemo(() => rows || [], [rows]);
  const visible = useMemo(() => sortRows(searchRows(rowsInView(all, view), search, folders), sort.key, sort.dir),
    [all, view, search, folders, sort]);
  const selected = selectedId ? all.find((r) => r.id === selectedId) : null;
  const views = VIEWS.filter((v) => (!v.hrOnly || hrAccess) && (!v.formsOnly || all.some((r) => r.kind === 'form_entry')));
  const countOf = (key) => rowsInView(all, key).length;
  const viewEmpty = VIEWS.find((v) => v.key === view)?.empty || 'This folder is empty.';

  const pickView = (key) => { setView(key); setSelectedId(''); };
  const sortBy = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'updatedAt' ? 'desc' : 'asc' }));

  // Arrow keys step the list, Enter opens, Escape closes - the Tickets desk's habit.
  const onRowKey = (e, row) => {
    if (e.key === 'Enter') { e.preventDefault(); setSelectedId(row.id); return; }
    if (e.key === 'Escape') { setSelectedId(''); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
    if (next) { next.focus(); if (selectedId) setSelectedId(next.dataset.row); }
  };

  // A row opens in its own editor: a sheet in the workbook, anything else in the Document Builder.
  const openRow = (id) => {
    if (all.find((r) => r.id === id)?.docKind === 'sheet') setEditingSheet(id);
    else setEditingDoc(id);
  };
  // A new file lands in the folder that is open, like a file made in an Explorer folder.
  const openFolderId = String(view || '').startsWith('folder:') ? view.slice(7) : '';
  // New Document (Neil, 11/10/2026): no name, no popup - a blank draft opens
  // in the editor at once; the editor asks for a name on Close. A template, a
  // person or a file go through New Document's arrow (CreateDocModal).
  const [makingDoc, setMakingDoc] = useState(false);
  const newDocument = async () => {
    if (makingDoc) return;
    setMakingDoc(true);
    try {
      const made = await api.createDocument({ title: UNTITLED_DOCUMENT, ...(openFolderId ? { folderId: openFolderId } : {}) });
      setEditingDoc(made.id);
    } catch (e) {
      toastErr?.(e?.message || 'Could not make the document.');
    } finally {
      setMakingDoc(false);
    }
  };
  // The header's + > New Document lands here: the same blank draft, at once.
  useEffect(() => { if (openCreateSignal) newDocument(); }, [openCreateSignal]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const newMenuRef = useRef(null);
  // New Sheet, or a spreadsheet file picked in Import: a sheet row, then open it.
  const newSheet = async (file = null) => {
    setMakingSheet(true);
    try {
      const engine = await import('../sheets');
      const content = file ? await engine.importSheetFile(file) : engine.newSheetContent();
      const title = file ? file.name.replace(/\.[^.]+$/, '') : UNTITLED_SHEET;
      const made = await api.createDocument({ title, kind: 'sheet', content, ...(openFolderId ? { folderId: openFolderId } : {}) });
      toastOk?.(file ? 'Sheet imported' : 'Sheet created');
      setEditingSheet(made.id);
    } catch (e) {
      toastErr?.(e?.message || 'Could not make the sheet.');
    } finally {
      setMakingSheet(false);
    }
  };

  if (editingSheet) return (
    <Suspense fallback={<SkeletonBlocks count={8} height={36} />}>
      <SheetWorkspace docId={editingSheet} employees={employees} entities={entities} toastOk={toastOk} toastErr={toastErr} onClose={() => { setEditingSheet(null); load(); }} />
    </Suspense>
  );

  if (editingDoc) return (
    <DocumentBuilder docId={editingDoc} employees={employees} entities={entities} toastOk={toastOk} toastErr={toastErr}
      onClose={() => { setEditingDoc(null); load(); }} />
  );

  const columns = [['title', 'Name'], ['for', 'For'], ['status', 'Status'], ['company', 'Company'], ['updatedAt', 'Updated']];

  return (
    <div className={`nx-dl${selected ? ' nx-dl-open' : ''}`}>
      <nav className="nx-dl-rail" aria-label="Document views">
        {views.map((v) => (
          <button key={v.key} type="button" className={view === v.key ? 'on' : ''} aria-current={view === v.key ? 'true' : undefined} onClick={() => pickView(v.key)}>
            <span>{v.label}</span><span className="nx-dl-count">{countOf(v.key)}</span>
          </button>
        ))}
        {(folders.length > 0 || canAddFolder) && <div className="nx-dl-rail-head">Folders</div>}
        {folders.filter((f) => f.name !== 'Archived' || countOf(folderKey(f.id)) > 0).map((f) => (
          <button key={f.id} type="button" className={view === folderKey(f.id) ? 'on' : ''} aria-current={view === folderKey(f.id) ? 'true' : undefined} onClick={() => pickView(folderKey(f.id))}>
            <span>{f.name}</span><span className="nx-dl-count">{countOf(folderKey(f.id))}</span>
          </button>
        ))}
        {canAddFolder && (
          <button type="button" className="nx-dl-rail-add" title="New Folder" onClick={() => setNewFolderOpen(true)}>
            <FolderPlus size={14} /> <span>New Folder</span>
          </button>
        )}
      </nav>

      <div className="nx-dl-main">
        <div className="nx-dl-tools">
          <div className="nx-dl-search">
            <Search size={14} aria-hidden="true" />
            <input className="form-input" placeholder="Search by title, person, signer or tag" aria-label="Search documents"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <input ref={importRef} type="file" accept=".docx,.doc,.pdf,.txt,.xlsx,.xls,.csv" style={{ display: 'none' }} aria-label="Import a file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { if (SHEET_FILE.test(f.name)) newSheet(f); else setCreateOpen({ file: f }); } e.target.value = ''; }} />
          <button type="button" className="secondary-btn" title="Open a Word, PDF, text, Excel or CSV file as a new document or sheet" onClick={() => importRef.current?.click()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Upload size={14} /> Import
          </button>
          <button type="button" className="secondary-btn" onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign-send' } }))}>
            Send For Signature
          </button>
          {/* New Document opens a blank draft at once; its arrow offers a template or a file. */}
          <span className="nx-dl-split" role="group" aria-label="New Document">
            <button type="button" className="primary-btn" data-tour="documents-new-document" disabled={makingDoc} onClick={newDocument}>
              <FilePlus2 size={14} /> {makingDoc ? 'Opening...' : 'New Document'}
            </button>
            <button ref={newMenuRef} type="button" className="primary-btn nx-dl-split-arrow" aria-label="More ways to start a document" title="More ways to start a document"
              aria-haspopup="menu" aria-expanded={newMenuOpen} onClick={() => setNewMenuOpen((o) => !o)}>
              <ChevronDown size={14} />
            </button>
          </span>
          <AnchoredMenu anchorRef={newMenuRef} open={newMenuOpen} onClose={() => setNewMenuOpen(false)} align="end"
            className="doc-toolbar doc-ribbon doc-ribbon-panel" style={{ width: 230 }}>
            <button type="button" role="menuitem" className="doc-ribbon-item" onClick={() => { setNewMenuOpen(false); newDocument(); }}>
              <FilePlus2 size={14} /><span>Blank Document</span>
            </button>
            <button type="button" role="menuitem" className="doc-ribbon-item" onClick={() => { setNewMenuOpen(false); newSheet(); }}>
              <SheetIcon size={14} /><span>Blank Sheet</span>
            </button>
            <div className="doc-ribbon-sep" role="separator" />
            <button type="button" role="menuitem" className="doc-ribbon-item" onClick={() => { setNewMenuOpen(false); setCreateOpen(true); }}>
              <LayoutTemplate size={14} /><span>From a Template...</span>
            </button>
            <button type="button" role="menuitem" className="doc-ribbon-item" onClick={() => { setNewMenuOpen(false); importRef.current?.click(); }}>
              <Upload size={14} /><span>Import a File...</span>
            </button>
          </AnchoredMenu>
          <button type="button" className="secondary-btn" disabled={makingSheet} onClick={() => newSheet()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <SheetIcon size={14} /> {makingSheet ? 'Making...' : 'New Sheet'}
          </button>
        </div>

        <AsyncSection
          loading={!rows}
          error={!!loadError && !all.length}
          errorMessage={loadError}
          isEmpty={!!rows && visible.length === 0}
          skeleton={<SkeletonBlocks count={6} height={44} />}
          emptyContent={
            <div className="nx-dl-empty">
              <FileText size={32} aria-hidden="true" />
              <p>{search.trim() ? 'Nothing matches that search.' : viewEmpty}</p>
              {!search.trim() && view !== 'needs' && view !== 'hr' && (
                <button type="button" className="primary-btn" disabled={makingDoc} onClick={newDocument}>New Document</button>
              )}
            </div>
          }
        >
          {isMobile ? (
            <div className="nx-dl-cards">
              {visible.slice(0, 500).map((r) => (
                <button key={r.id} type="button" className="nx-dl-card" onClick={() => setSelectedId(r.id)}>
                  <strong>{r.docKind === 'sheet' && <SheetIcon size={13} aria-label="Sheet" style={{ marginRight: 5, verticalAlign: -2 }} />}{r.title}</strong>
                  {rowFor(r) && <span className="nx-dl-muted">{rowFor(r)}</span>}
                  <span className="nx-dl-card-foot"><StatusWord status={rowStatus(r)} /><span className="nx-dl-muted">{formatDate(r.updatedAt)}</span></span>
                </button>
              ))}
            </div>
          ) : (
            <div className="nx-dl-table">
              <table>
                <thead>
                  <tr>
                    {columns.map(([key, label]) => (
                      <th key={key} className={key === 'company' ? 'nx-dl-co' : undefined} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                        <button type="button" onClick={() => sortBy(key)}>
                          {label}{sort.key === key && (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, 500).map((r) => (
                    <tr key={r.id} data-row={r.id} tabIndex={0} className={selectedId === r.id ? 'sel' : ''} aria-selected={selectedId === r.id}
                      onClick={() => setSelectedId(r.id)} onKeyDown={(e) => onRowKey(e, r)}>
                      <td className="nx-dl-name">{r.docKind === 'sheet' && <SheetIcon size={13} aria-label="Sheet" style={{ marginRight: 6, verticalAlign: -2 }} />}{r.title}</td>
                      <td className="nx-dl-for">{rowFor(r) || '-'}</td>
                      <td><StatusWord status={rowStatus(r)} /></td>
                      <td className="nx-dl-co">{r.company || '-'}</td>
                      <td className="nx-dl-date">{formatDate(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {visible.length > 500 && <p className="nx-dl-muted" style={{ marginTop: 10 }}>Showing the newest 500. Search to find the rest.</p>}
        </AsyncSection>
      </div>

      {selected && (
        <DocumentSidePanel key={selected.id} row={selected} folders={folders} toastOk={toastOk} toastErr={toastErr}
          onClose={() => setSelectedId('')} onEdit={openRow} onOrganize={setOrganizeDoc} onChanged={load} />
      )}

      {createOpen && (
        <CreateDocModal folders={folders} employees={employees} entities={entities} toastErr={toastErr} initialFile={createOpen.file || null}
          onClose={() => setCreateOpen(false)}
          onCreated={(doc) => {
            toastOk?.(doc.status === 'final' ? 'Document made' : 'Draft created');
            if (doc.status === 'final') { setView('all'); setSelectedId(doc.id); load(); }
            else if (doc.kind === 'sheet') setEditingSheet(doc.id);
            else setEditingDoc(doc.id);
          }} />
      )}

      {newFolderOpen && (
        <NewFolderModal toastErr={toastErr} onClose={() => setNewFolderOpen(false)}
          onCreated={(f) => { setFolders(prev => [...prev, f].sort((a, b) => a.name.localeCompare(b.name))); toastOk?.(`Folder "${f.name}" created`); }} />
      )}

      {organizeDoc && (
        <OrganizeModal doc={organizeDoc} folders={folders} toastErr={toastErr}
          onClose={() => setOrganizeDoc(null)}
          onSaved={() => { toastOk?.('Saved'); load(); }} />
      )}
    </div>
  );
}
