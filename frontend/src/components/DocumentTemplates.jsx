import { useEffect, useState } from 'react';
import { Search, Loader2, Plus, Copy, Archive, FileText, Award, Star, Pencil, Trash2, Eye } from 'lucide-react';
import { api } from '../api';
import { useRole } from '../contexts/RoleContext';
import DocumentBuilder from './DocumentBuilder';
import { uploadToSupabase, imageFromPaste } from '../lib/docBuilderUpload';

// ── Document Templates & Letterheads (Phase 3) ───────────────────────────────
// Category tabs + search over doc_templates, reusing DocumentBuilder (kind=
// "template") for both editing and read-only Preview — same in-tab-replace
// convention as My Documents / E-Sign (a plain early return, not a portal).
const CATEGORIES = [
  ['letterhead', 'Letterhead'], ['hr', 'HR'], ['legal', 'Legal'], ['finance', 'Finance'],
  ['operations', 'Operations'], ['sales', 'Sales'], ['engineering', 'Engineering'], ['general', 'General'],
];

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const cardStyle = (maxWidth) => ({ background: 'var(--card)', borderRadius: 16, width: '100%', maxWidth, boxShadow: 'var(--shadow-lg)' });

function CreateTemplateModal({ letterheads, onClose, onCreated, toastErr }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('general');
  const [requiresLetterhead, setRequiresLetterhead] = useState(false);
  const [letterheadId, setLetterheadId] = useState('');
  const [busy, setBusy] = useState(false);

  const create = () => {
    if (!name.trim()) return;
    setBusy(true);
    api.createDocTemplate({ name: name.trim(), category, requiresLetterhead, letterheadId: requiresLetterhead ? letterheadId : '' })
      .then(t => { onCreated(t); onClose(); })
      .catch(e => toastErr?.(e.message || 'Failed to create template'))
      .finally(() => setBusy(false));
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle(420)} onClick={e => e.stopPropagation()}>
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

function LetterheadForm({ letterhead, onSaved, toastErr }) {
  const isNew = !letterhead;
  const [name, setName] = useState(letterhead?.name || '');
  const [address, setAddress] = useState(letterhead?.address || '');
  const [logoPath, setLogoPath] = useState(letterhead?.logoPath || '');
  const [headerText, setHeaderText] = useState(letterhead?.headerJson?.text || '');
  const [footerText, setFooterText] = useState(letterhead?.footerJson?.text || '');
  const [busy, setBusy] = useState(false);

  const doUpload = async (file) => {
    const path = `document-images/letterheads/${Date.now()}-${(file.name || 'logo').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { url, error } = await uploadToSupabase(file, 'document-images', path);
    if (error) { toastErr?.(error); return; }
    setLogoPath(url);
  };

  const save = () => {
    if (!name.trim()) return;
    setBusy(true);
    const data = {
      name: name.trim(), address, logoPath,
      headerJson: headerText.trim() ? { text: headerText.trim() } : {},
      footerJson: footerText.trim() ? { text: footerText.trim() } : {},
    };
    const call = isNew ? api.createDocLetterhead(data) : api.updateDocLetterhead(letterhead.id, data);
    call.then(() => onSaved()).catch(e => toastErr?.(e.message || 'Failed to save letterhead')).finally(() => setBusy(false));
  };

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--card)' }}
      onPaste={e => { const f = imageFromPaste(e); if (f) { e.preventDefault(); doUpload(f); } }} tabIndex={0}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        {logoPath ? <img src={logoPath} alt="" style={{ height: 44, maxWidth: 120, objectFit: 'contain' }} /> : (
          <div style={{ width: 60, height: 44, borderRadius: 6, background: 'var(--mist)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}><Award size={18} /></div>
        )}
        <label style={{ fontSize: 11.5, color: 'var(--muted)', cursor: 'pointer' }}>
          Upload logo (or press Ctrl+V to paste)
          <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = ''; }} />
        </label>
      </div>
      <input className="form-input" placeholder="Letterhead name" value={name} onChange={e => setName(e.target.value)} />
      <textarea className="form-input" placeholder="Address" rows={2} value={address} onChange={e => setAddress(e.target.value)} />
      <input className="form-input" placeholder="Header text (e.g. a tagline — optional)" value={headerText} onChange={e => setHeaderText(e.target.value)} />
      <input className="form-input" placeholder="Footer text (e.g. registration/disclaimer — optional)" value={footerText} onChange={e => setFooterText(e.target.value)} />
      <button className="primary-btn" disabled={!name.trim() || busy} onClick={save} style={{ alignSelf: 'flex-start', opacity: (!name.trim() || busy) ? 0.6 : 1 }}>
        {busy ? 'Saving…' : isNew ? 'Add Letterhead' : 'Save'}
      </button>
    </div>
  );
}

function LetterheadsPanel({ toastOk, toastErr }) {
  const { can } = useRole();
  const isAdmin = can('administrator');
  const [letterheads, setLetterheads] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = () => api.getDocLetterheads().then(setLetterheads).catch(() => setLetterheads([]));
  useEffect(() => { load(); }, []);

  const setDefault = (id) => api.updateDocLetterhead(id, { isDefault: true }).then(() => { toastOk?.('Default letterhead updated'); load(); }).catch(e => toastErr?.(e.message));
  const remove = (id, name) => {
    if (!window.confirm(`Delete letterhead "${name}"?`)) return;
    api.deleteDocLetterhead(id).then(() => { toastOk?.('Deleted'); load(); }).catch(e => toastErr?.(e.message));
  };

  if (!letterheads) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>;

  return (
    <div>
      {!isAdmin && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>Only administrators can add or edit letterheads.</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: isAdmin ? 20 : 0 }}>
        {letterheads.map(l => (
          <div key={l.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--card)' }}>
            {l.logoPath ? <img src={l.logoPath} alt="" style={{ height: 36, maxWidth: '100%', objectFit: 'contain', marginBottom: 8 }} /> : null}
            <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              {l.name}
              {l.isDefault && <span style={{ padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 800, color: 'hsl(var(--color-green))', background: 'hsla(var(--color-green),0.12)' }}>Default</span>}
            </div>
            {l.address && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{l.address}</div>}
            {isAdmin && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                {!l.isDefault && (
                  <button onClick={() => setDefault(l.id)} title="Set as default"
                    style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: 6, cursor: 'pointer', display: 'flex' }}><Star size={13} /></button>
                )}
                <button onClick={() => remove(l.id, l.name)} title="Delete"
                  style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 7, padding: 6, cursor: 'pointer', display: 'flex', color: 'hsl(var(--color-red))' }}><Trash2 size={13} /></button>
              </div>
            )}
          </div>
        ))}
      </div>
      {isAdmin && (adding ? (
        <LetterheadForm toastErr={toastErr} onSaved={() => { setAdding(false); toastOk?.('Letterhead saved'); load(); }} />
      ) : (
        <button className="primary-btn" onClick={() => setAdding(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <Plus size={13} /> Add Letterhead
        </button>
      ))}
    </div>
  );
}

export default function DocumentTemplates({ openCreateSignal, openTemplateSignal, toastOk, toastErr }) {
  const [sub, setSub] = useState('library');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [templates, setTemplates] = useState(null);
  const [letterheads, setLetterheads] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [seeding, setSeeding] = useState(false);

  const load = () => {
    api.getDocTemplates({ ...(category ? { category } : {}), ...(search.trim() ? { q: search.trim() } : {}) })
      .then(setTemplates).catch(() => setTemplates([]));
  };

  useEffect(() => { load(); }, [category, search]);
  useEffect(() => { api.getDocLetterheads().then(setLetterheads).catch(() => setLetterheads([])); }, []);
  useEffect(() => { if (openCreateSignal) setCreateOpen(true); }, [openCreateSignal]);
  useEffect(() => { if (openTemplateSignal?.id) setEditingId(openTemplateSignal.id); }, [openTemplateSignal]);

  const seedStarters = () => {
    setSeeding(true);
    api.seedDocTemplateStarters().then(r => { toastOk?.(`Added ${r.added} starter template${r.added === 1 ? '' : 's'}`); load(); })
      .catch(e => toastErr?.(e.message || 'Failed to seed starters')).finally(() => setSeeding(false));
  };

  const act = (id, fn, okMsg) => {
    setBusyId(id);
    fn(id).then(() => { toastOk?.(okMsg); load(); }).catch(e => toastErr?.(e.message || 'Action failed')).finally(() => setBusyId(''));
  };

  if (editingId) return (
    <DocumentBuilder docId={editingId} kind="template" toastOk={toastOk} toastErr={toastErr}
      onClose={() => { setEditingId(null); load(); }} />
  );
  if (previewId) return (
    <DocumentBuilder docId={previewId} kind="template" toastOk={toastOk} toastErr={toastErr}
      onClose={() => setPreviewId(null)} />
  );

  return (
    <div>
      <div className="scroll-tabs" style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--line)' }}>
        {[['library', 'Templates'], ['letterheads', 'Letterheads']].map(([v, l]) => (
          <button key={v} onClick={() => setSub(v)}
            style={{ padding: '9px 14px', fontSize: 13, fontWeight: 600, fontFamily: 'Inter,sans-serif', background: 'none', border: 'none', borderBottom: `2px solid ${sub === v ? 'var(--pine)' : 'transparent'}`, color: sub === v ? 'var(--ink)' : 'var(--muted)', cursor: 'pointer', marginBottom: -1 }}>
            {l}
          </button>
        ))}
      </div>

      {sub === 'letterheads' ? (
        <LetterheadsPanel toastOk={toastOk} toastErr={toastErr} />
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="scroll-tabs" style={{ display: 'flex', gap: 4, flex: 1 }}>
              <button onClick={() => setCategory('')}
                style={{ padding: '5px 12px', borderRadius: 16, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid var(--line)', background: category === '' ? 'var(--ink)' : 'transparent', color: category === '' ? 'var(--card)' : 'var(--muted)' }}>
                All
              </button>
              {CATEGORIES.map(([v, l]) => (
                <button key={v} onClick={() => setCategory(v)}
                  style={{ padding: '5px 12px', borderRadius: 16, fontSize: 11.5, fontWeight: 700, fontFamily: 'Inter,sans-serif', cursor: 'pointer', whiteSpace: 'nowrap', border: '1px solid var(--line)', background: category === v ? 'var(--ink)' : 'transparent', color: category === v ? 'var(--card)' : 'var(--muted)' }}>
                  {l}
                </button>
              ))}
            </div>
            <button className="primary-btn" onClick={() => setCreateOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <Plus size={13} /> New Template
            </button>
          </div>

          <div style={{ position: 'relative', maxWidth: 320, marginBottom: 14 }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input className="form-input" style={{ width: '100%', fontSize: 12.5, paddingLeft: 30 }}
              placeholder="Search templates…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          {!templates ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /></div>
          ) : templates.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '52px 20px', color: 'var(--muted)' }}>
              <FileText size={36} style={{ opacity: 0.3, marginBottom: 12 }} />
              <p style={{ fontSize: 13.5, margin: '0 0 16px' }}>No templates here yet.</p>
              <button className="primary-btn" disabled={seeding} onClick={seedStarters} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {seeding ? 'Adding…' : 'Add starter templates'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {templates.map(t => (
                <div key={t.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 14, background: 'var(--card)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <FileText size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <div style={{ fontSize: 13.5, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
                    <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 800, color: 'hsl(var(--color-blue))', background: 'hsla(var(--color-blue),0.12)' }}>
                      {CATEGORIES.find(([v]) => v === t.category)?.[1] || t.category}
                    </span>
                    {t.requiresLetterhead && (
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 800, color: '#92400e', background: 'rgba(245,158,11,0.13)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Award size={10} /> Letterhead
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button title="Preview" onClick={() => setPreviewId(t.id)}
                      style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}><Eye size={14} /></button>
                    <button title="Edit" onClick={() => setEditingId(t.id)}
                      style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}><Pencil size={14} /></button>
                    <button title="Duplicate" disabled={busyId === t.id} onClick={() => act(t.id, api.duplicateDocTemplate, 'Duplicated')}
                      style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}><Copy size={14} /></button>
                    {t.status === 'active' && (
                      <button title="Archive" disabled={busyId === t.id} onClick={() => act(t.id, (id) => api.updateDocTemplate(id, { status: 'archived' }), 'Archived')}
                        style={{ background: 'none', border: '1px solid var(--line)', borderRadius: 8, padding: 7, cursor: 'pointer', display: 'flex' }}><Archive size={14} /></button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {createOpen && (
        <CreateTemplateModal letterheads={letterheads} toastErr={toastErr}
          onClose={() => setCreateOpen(false)}
          onCreated={(t) => { toastOk?.('Template created'); setEditingId(t.id); }} />
      )}
    </div>
  );
}
