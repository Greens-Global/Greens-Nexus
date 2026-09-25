// Personal Link add/edit form, shared by the Links tab (views/ExternalLinks.jsx,
// which controls the modal state itself) and the dashboard (the Quick Actions
// "Add Personal Link" composer and the My Personal Links widget's Add tile,
// which use the self-contained PersonalLinkComposer below). One form, one
// dupe check, one code path - the dashboard never gets a second, drifting
// copy of this modal (Neil, Sep 24).
import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Lock, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { useUnsavedGuard } from '../lib/useUnsavedGuard';
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt';

// Duplicate-URL detection (Add Link / Add Personal Link) - normalizes away
// the differences that would otherwise let the same site get added twice
// (http vs https, www. vs not, a trailing slash, mixed case) without masking
// genuinely different pages on the same host (different path = different
// link). Mirrors _normalize_url in external_links.py - keep both in sync.
export function normalizeUrl(u) {
  try {
    const withProto = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    const parsed = new URL(withProto);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return (u || '').trim().toLowerCase();
  }
}

export const EMPTY_PERSONAL_LINK_FORM = { name: '', url: '', description: '', icon: 'Link2', vault_cred_id: '', department: '', category: '' };

// Does this pasted/typed text look like a web address? Used by the dashboard
// widget's Ctrl+V shortcut to decide whether a paste should open the composer.
export function looksLikeUrl(text) {
  const t = (text || '').trim();
  if (!t || /\s/.test(t)) return false;
  if (/^https?:\/\/\S+\.\S+/i.test(t)) return true;
  return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t);
}

export function PersonalLinkModal({ modal, setModal, save, saving, existingLinks, departments, categories, error }) {
  const { mode, form } = modal;
  const setForm = (patch) => setModal(m => ({ ...m, form: { ...m.form, ...patch } }));
  const duplicate = useMemo(() => {
    if (!form.url.trim()) return null;
    return existingLinks.find(l => l.id !== modal.id && normalizeUrl(l.url) === normalizeUrl(form.url)) || null;
  }, [form.url, existingLinks, modal.id]);
  const initialFormRef = useRef(form);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialFormRef.current);
  const closeModal = () => setModal(null);
  const guard = useUnsavedGuard(dirty, closeModal, duplicate ? undefined : save);

  // Same auto-fill as the Company Links Add Link modal (see LinkModal) -
  // fetch the site's own meta description once the URL field is blurred,
  // fill it in only if the description is still empty or was itself the
  // last auto-fill (never overwrite something the user actually typed).
  const [fetchingPreview, setFetchingPreview] = useState(false);
  const autoFilledDescRef = useRef('');
  const fetchPreview = async () => {
    const raw = form.url.trim();
    if (!raw || (form.description && form.description !== autoFilledDescRef.current)) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    setFetchingPreview(true);
    try {
      const preview = await api.previewExternalLink(url);
      if (preview?.description) {
        autoFilledDescRef.current = preview.description;
        setForm({ description: preview.description });
      }
    } catch {
      /* best-effort prefill - the field just stays as it was */
    } finally {
      setFetchingPreview(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !saving && guard.requestClose()}>
      <div className="modal-content" style={{ width: '60vw', maxWidth: '60vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{mode === 'add' ? 'Add Personal Link' : 'Edit Personal Link'}</h3>
          <button className="close-btn" onClick={guard.requestClose}><X size={16} /></button>
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
            <Lock size={12} /> Only visible to you - no one else, including managers, can see this.
          </p>
          <div className="form-group">
            <label>Name</label>
            <input className="form-input" value={form.name} onChange={e => setForm({ name: e.target.value })} placeholder="e.g. My Timesheet" autoFocus />
          </div>
          <div className="form-group">
            <label>URL</label>
            <input className="form-input" value={form.url} onChange={e => setForm({ url: e.target.value })} onBlur={fetchPreview} placeholder="https://..." />
            {duplicate && (
              <p style={{ fontSize: 11.5, color: 'hsl(var(--color-red))', margin: '5px 0 0', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                Already in your Personal Links as "{duplicate.name}" - pick a different link, or edit that one instead.
              </p>
            )}
          </div>
          <div className="form-group">
            <label>
              Description
              {fetchingPreview && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginLeft: 8 }}>Fetching from site...</span>}
            </label>
            <textarea className="form-input" rows={2} value={form.description}
              onChange={e => setForm({ description: e.target.value })} placeholder="Optional note to yourself - or leave blank, we'll try to pull it from the site" />
          </div>
          <div className="form-grid" style={{ padding: 0 }}>
            <div className="form-group">
              <label>Category</label>
              <input className="form-input" list="personal-link-categories" value={form.category}
                onChange={e => setForm({ category: e.target.value })} placeholder="e.g. Productivity" />
              <datalist id="personal-link-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            <div className="form-group">
              <label>Department</label>
              <select className="form-select" value={form.department} onChange={e => setForm({ department: e.target.value })}>
                <option value="">None</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>
          {/* The Links tab reports save problems in its own page banner; the
              dashboard composer has no banner, so it hands one in here. */}
          {error && (
            <p style={{ fontSize: 12, color: 'hsl(var(--color-red))', margin: 0, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} /> {error}
            </p>
          )}
        </div>
        <p style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: 'var(--muted)', margin: '4px 0 18px' }}>
          Icon Auto Fetched From AI
        </p>
        <div className="modal-footer">
          <button className="secondary-btn" onClick={() => setModal(null)} disabled={saving}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={saving || !!duplicate}>{saving ? 'Saving...' : mode === 'add' ? 'Add Link' : 'Save Changes'}</button>
        </div>
      </div>
      {guard.confirming && (
        <UnsavedChangesPrompt onKeepEditing={guard.keepEditing} onDiscard={closeModal} onSave={duplicate ? undefined : guard.saveAndClose} saving={saving} />
      )}
    </div>
  );
}

// Self-contained "add one Personal Link" composer for the dashboard. Owns the
// modal state, loads the user's existing links (for the dupe check) and the
// admin taxonomy (for the Category / Department pickers) itself, since a
// dashboard tile has no guarantee the Links tab was ever opened this session.
//
// `onClose(result)` follows the Quick Actions composer contract in
// dashboard/widgets.jsx: `result.toast` is a one-line confirmation the tile
// shows, `result.created` is the new row so a widget can append it without
// a refetch. Cancel / backdrop close calls onClose() with nothing.
export function PersonalLinkComposer({ initialUrl = '', onClose }) {
  const [modal, setModal] = useState({ mode: 'add', id: null, form: { ...EMPTY_PERSONAL_LINK_FORM, url: initialUrl } });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [existing, setExisting] = useState([]);
  const [taxonomy, setTaxonomy] = useState({ departments: [], categories: [] });
  useEffect(() => {
    let alive = true;
    api.getPersonalLinks().then(p => { if (alive) setExisting(p || []); }).catch(() => {});
    api.getExternalLinksTaxonomy().then(t => { if (alive) setTaxonomy(t || { departments: [], categories: [] }); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // PersonalLinkModal signals "close" by setting the modal state to null.
  useEffect(() => { if (modal === null) onClose?.(); }, [modal, onClose]);
  if (modal === null) return null;

  const save = async () => {
    const f = modal.form;
    if (!f.name.trim() || !f.url.trim()) { setError('Name and URL are required.'); return; }
    const url = /^https?:\/\//i.test(f.url.trim()) ? f.url.trim() : `https://${f.url.trim()}`;
    const dupe = existing.find(l => normalizeUrl(l.url) === normalizeUrl(url));
    if (dupe) { setError(`This is already in your Personal Links as "${dupe.name}".`); return; }
    setSaving(true);
    setError('');
    try {
      const created = await api.createPersonalLink({ ...f, url });
      onClose?.({ toast: `"${created.name}" added to Personal Links.`, created });
    } catch (e) {
      setError(e?.message || 'Could not save this link.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <PersonalLinkModal modal={modal} setModal={setModal} save={save} saving={saving} error={error}
      existingLinks={existing}
      departments={taxonomy.departments.map(d => d.name)} categories={taxonomy.categories.map(c => c.name)} />
  );
}
