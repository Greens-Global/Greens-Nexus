import { useEffect, useRef, useState } from 'react';
import { generateJSON } from '@tiptap/core';
import { Search, Loader2, FilePlus2, Copy, Archive, RotateCcw, Trash2, FileText, Folder, Pencil, PenTool, Upload, Cloud } from 'lucide-react';
import { api } from '../api';
import DocumentBuilder from './DocumentBuilder';
import EgnyteBrowser from './EgnyteBrowser';
import { BODY_EXTENSIONS } from '../lib/docBuilderSchema';
import { uploadToSupabase } from '../lib/docBuilderUpload';
import { importDocumentFile } from '../lib/docBuilderImport';

// ── My Documents (Phase 1 browse/organize, Phase 2 adds the editor) ─────────
// Folder browse + search/status filter + draft/library list. "Edit" opens
// DocumentBuilder in place — same "replace the tab content" convention
// ESign.jsx uses for SignModal/SendWizard (a plain early return, not a portal).
const DOC_STATUS = {
  draft:    { label: 'Draft',    fg: 'hsl(var(--color-blue))',   bg: 'hsla(var(--color-blue),0.12)' },
  final:    { label: 'Final',    fg: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)' },
  archived: { label: 'Archived', fg: 'var(--muted)',             bg: 'var(--mist)' },
};
// Mirrors ESign.jsx's REQ_STATUS color convention (Phase 5) — duplicated
// locally per the module's established pattern of not reaching into ESign.jsx.
const SIGN_STATUS = {
  pending:   { label: 'Awaiting signatures', fg: 'hsl(var(--color-orange))', bg: 'hsla(var(--color-orange),0.12)' },
  completed: { label: 'Signed',              fg: 'hsl(var(--color-green))',  bg: 'hsla(var(--color-green),0.12)' },
  declined:  { label: 'Declined',            fg: 'hsl(var(--color-red))',    bg: 'hsla(var(--color-red),0.12)' },
  voided:    { label: 'Voided',              fg: 'var(--muted)',             bg: 'var(--mist)' },
  expired:   { label: 'Expired',             fg: 'var(--muted)',             bg: 'var(--mist)' },
};

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = (maxWidth) => ({ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth, boxShadow: 'var(--shadow-lg)' });

function CreateDocModal({ folders, onClose, onCreated, toastErr }) {
  const [title, setTitle] = useState('');
  const [folderId, setFolderId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState([]);
  const [importFile, setImportFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [egnyteOpen, setEgnyteOpen] = useState(false);
  const importInputRef = useRef(null);

  useEffect(() => { api.getDocTemplates({ status: 'active' }).then(setTemplates).catch(() => setTemplates([])); }, []);

  const uploadImportedImage = async (docId, bytes, mime, n) => {
    const extGuess = (mime || '').split('/')[1]?.split('+')[0] || 'png';
    const path = `document-images/${docId}/imported-${Date.now()}-${n}.${extGuess}`;
    const file = new File([bytes], `imported-${n}.${extGuess}`, { type: mime || 'image/png' });
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    return error ? '' : url;
  };

  const pickImportFile = (file) => {
    setImportFile(file);
    setTemplateId('');
    if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ''));
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

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    let created = null;
    try {
      created = await api.createDocument({ title: title.trim(), folderId, templateId: importFile ? '' : templateId });
      if (importFile) {
        const { html, warnings } = await importDocumentFile(importFile, {
          uploadImage: (bytes, mime, n) => uploadImportedImage(created.id, bytes, mime, n),
        });
        const json = generateJSON(html || '<p></p>', BODY_EXTENSIONS);
        await api.updateDocument(created.id, { content: { body: json, header: null, footer: null } });
        if (warnings?.length) toastErr?.(`Imported with notes: ${warnings.slice(0, 2).join(' ')}`);
      }
      onCreated(created);
      onClose();
    } catch (e) {
      // If the draft row was already created but the import itself failed,
      // don't leave an empty orphaned draft behind — clean it up so a failed
      // import doesn't clutter the document list.
      if (created && importFile) api.deleteDocument(created.id).catch(() => {});
      toastErr?.(e.message || 'Failed to create document');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle(420)} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--line)', fontSize: 15, fontWeight: 700 }}>New Document</div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 5 }}>Title</label>
            <input className="form-input" style={{ width: '100%' }} autoFocus value={title}
              onChange={e => setTitle(e.target.value)} placeholder="e.g. Q3 Vendor Agreement"
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
            Opens straight into the editor once created.
          </div>
        </div>
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button className="primary-btn" disabled={!title.trim() || busy} onClick={create} style={{ opacity: (!title.trim() || busy) ? 0.6 : 1 }}>
            {busy ? (importFile ? 'Importing…' : 'Creating…') : 'Create Draft'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DocumentsBrowser({ openCreateSignal, openDocSignal, employees = [], entities = [], toastOk, toastErr }) {
  const [folders, setFolders] = useState([]);
  const [docs, setDocs] = useState(null);
  const [folderId, setFolderId] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [editingDoc, setEditingDoc] = useState(null);

  const load = () => {
    api.getDocuments({ ...(folderId ? { folder_id: folderId } : {}), ...(statusFilter !== 'all' ? { status: statusFilter } : {}), ...(search.trim() ? { q: search.trim() } : {}) })
      .then(setDocs).catch(() => setDocs([]));
  };

  useEffect(() => { api.getDocFolders().then(setFolders).catch(() => setFolders([])); }, []);
  useEffect(() => { load(); }, [folderId, statusFilter, search]);
  useEffect(() => { if (openCreateSignal) setCreateOpen(true); }, [openCreateSignal]);
  useEffect(() => { if (openDocSignal?.id) setEditingDoc(openDocSignal.id); }, [openDocSignal]);

  const act = (id, fn, okMsg) => {
    setBusyId(id);
    fn(id).then(() => { toastOk?.(okMsg); load(); }).catch(e => toastErr?.(e.message || 'Action failed')).finally(() => setBusyId(''));
  };

  if (editingDoc) return (
    <DocumentBuilder docId={editingDoc} employees={employees} entities={entities} toastOk={toastOk} toastErr={toastErr}
      onClose={() => { setEditingDoc(null); load(); }} />
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4, flex: 1 }}>
          <button onClick={() => setFolderId('')}
            style={{ padding: '5px 12px', borderRadius: 16, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid var(--line)', background: folderId === '' ? 'var(--ink)' : 'transparent', color: folderId === '' ? 'var(--card)' : 'var(--muted)' }}>
            All
          </button>
          {folders.map(f => (
            <button key={f.id} onClick={() => setFolderId(f.id)}
              style={{ padding: '5px 12px', borderRadius: 16, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid var(--line)', background: folderId === f.id ? 'var(--ink)' : 'transparent', color: folderId === f.id ? 'var(--card)' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Folder size={11} /> {f.name}
            </button>
          ))}
        </div>
        <button className="primary-btn" onClick={() => setCreateOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <FilePlus2 size={13} /> New Document
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 320 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input className="form-input" style={{ width: '100%', fontSize: 12.5, paddingLeft: 30 }}
            placeholder="Search title…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="scroll-tabs" style={{ display: 'flex', gap: 4 }}>
          {[['all', 'All'], ['draft', 'Drafts'], ['final', 'Final'], ['archived', 'Archived']].map(([v, l]) => (
            <button key={v} onClick={() => setStatusFilter(v)}
              style={{ padding: '5px 12px', borderRadius: 16, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid var(--line)', background: statusFilter === v ? 'var(--ink)' : 'transparent', color: statusFilter === v ? 'var(--card)' : 'var(--muted)' }}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {!docs ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
      ) : docs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '52px 20px', color: 'var(--muted)' }}>
          <FileText size={36} style={{ opacity: 0.3, marginBottom: 12 }} />
          <p style={{ fontSize: 13.5, margin: '0 0 16px' }}>No documents match here yet.</p>
          <button className="primary-btn" onClick={() => setCreateOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FilePlus2 size={13} /> Create one</button>
        </div>
      ) : docs.map(d => {
        const st = DOC_STATUS[d.status] || DOC_STATUS.draft;
        const signSt = d.signRequestId ? SIGN_STATUS[d.signStatus] : null;
        const folder = folders.find(f => f.id === d.folderId);
        return (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: '1px solid var(--line)', borderRadius: 12, marginBottom: 8, background: 'var(--card)' }}>
            <FileText size={17} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {folder ? folder.name : 'No folder'} · v{d.currentVersion} · updated {(d.updatedAt || '').slice(0, 10)}
              </div>
            </div>
            <span style={{ padding: '2px 9px', borderRadius: 12, fontSize: 10.5, fontWeight: 800, color: st.fg, background: st.bg, whiteSpace: 'nowrap' }}>{st.label}</span>
            {signSt && (
              <button title="View in E-Sign"
                onClick={() => window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'documents', sub: 'documents-esign-requests' } }))}
                style={{ padding: '2px 9px', borderRadius: 12, fontSize: 10.5, fontWeight: 800, color: signSt.fg, background: signSt.bg, whiteSpace: 'nowrap', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <PenTool size={10} /> {signSt.label}
              </button>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button title="Edit" onClick={() => setEditingDoc(d.id)}
                style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}><Pencil size={14} /></button>
              <button title="Duplicate" disabled={busyId === d.id} onClick={() => act(d.id, api.duplicateDocument, 'Duplicated')}
                style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}><Copy size={14} /></button>
              {d.status === 'archived' ? (
                <button title="Restore" disabled={busyId === d.id} onClick={() => act(d.id, api.restoreDocument, 'Restored')}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}><RotateCcw size={14} /></button>
              ) : (
                <button title="Archive" disabled={busyId === d.id} onClick={() => act(d.id, api.archiveDocument, 'Archived')}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}><Archive size={14} /></button>
              )}
              {d.status === 'draft' && (
                <button title="Delete" disabled={busyId === d.id} onClick={() => { if (window.confirm(`Delete "${d.title}"? This can't be undone.`)) act(d.id, api.deleteDocument, 'Deleted'); }}
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex', color: 'hsl(var(--color-red))' }}><Trash2 size={14} /></button>
              )}
            </div>
          </div>
        );
      })}

      {createOpen && (
        <CreateDocModal folders={folders} toastErr={toastErr}
          onClose={() => setCreateOpen(false)}
          onCreated={(doc) => { toastOk?.('Draft created'); setEditingDoc(doc.id); }} />
      )}
    </div>
  );
}
