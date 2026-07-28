import { useEffect, useState } from 'react';
import { Loader, Megaphone, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useNameResolver } from '../lib/useNameResolver';
import { formatDate } from './lib/format';
import { EmptyState, ErrorState, FG, LoadingState, Modal, useIrLoad } from './lib/ui';

export default function UpdatesTab() {
  const nameOf = useNameResolver();
  const { data: updates, loading, error, reload } = useIrLoad(() => api.getIrUpdates(), []);

  const [funds, setFunds] = useState([]);
  useEffect(() => { api.getIrFunds().then(d => setFunds(Array.isArray(d) ? d : [])).catch(() => {}); }, []);

  const [modal, setModal] = useState(null); // { id?, title, body, fundId, pinned }
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [rowErr, setRowErr] = useState('');

  const openAdd = () => { setFormErr(''); setModal({ id: null, title: '', body: '', fundId: '', pinned: false }); };
  const openEdit = (u) => {
    setFormErr('');
    setModal({ id: u.id, title: u.title || '', body: u.body || '', fundId: u.fundId ? String(u.fundId) : '', pinned: !!u.pinned });
  };

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr('');
    try {
      const payload = {
        title: modal.title.trim(),
        body: modal.body.trim(),
        fundId: modal.fundId ? Number(modal.fundId) : null,
        pinned: !!modal.pinned,
      };
      if (modal.id) await api.updateIrUpdate(modal.id, payload);
      else await api.createIrUpdate(payload);
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (u) => {
    setRowErr('');
    try {
      await api.updateIrUpdate(u.id, { pinned: !u.pinned });
      await reload();
    } catch (err) {
      setRowErr(err?.message || 'Could not update the pin.');
    }
  };

  const remove = async (u) => {
    if (!window.confirm(`Delete the update "${u.title}"?`)) return;
    setRowErr('');
    try {
      await api.deleteIrUpdate(u.id);
      await reload();
    } catch (err) {
      setRowErr(err?.message || 'Delete failed.');
    }
  };

  // Pinned first, then newest first.
  const rows = [...(updates || [])].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });

  const iconBtn = (title, onClick, Icon, hoverColor = 'var(--ink)') => (
    <button onClick={onClick} title={title}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4, display: 'inline-flex' }}
      onMouseEnter={e => { e.currentTarget.style.color = hoverColor; }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--muted)'; }}>
      <Icon size={14} />
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>Updates</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Investor communications feed - pinned announcements stay on top</p>
        </div>
        <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Post Update
        </button>
      </div>

      {rowErr && <ErrorState message={rowErr} />}

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <EmptyState icon={Megaphone} title="No Updates Posted"
          sub="Share deal progress, quarterly letters, and announcements - they land here and on the module dashboard." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 }}>
          {rows.map(u => (
            <div key={u.id} style={{
              background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '16px 18px',
              borderLeft: u.pinned ? '3px solid hsl(var(--color-blue))' : '1px solid var(--line)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    {u.pinned && <Pin size={13} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0 }} />}
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{u.title}</div>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                    {u.fundName || 'All Deals'} · {nameOf(u.createdBy)} · {formatDate(u.createdAt)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  {iconBtn(u.pinned ? 'Unpin' : 'Pin to top', () => togglePin(u), u.pinned ? PinOff : Pin, 'hsl(var(--color-blue))')}
                  {iconBtn('Edit', () => openEdit(u), Pencil)}
                  {iconBtn('Delete', () => remove(u), Trash2, 'hsl(var(--color-red))')}
                </div>
              </div>
              {u.body && <p style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6, margin: '10px 0 0', whiteSpace: 'pre-line' }}>{u.body}</p>}
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal title={modal.id ? 'Edit Update' : 'Post Update'} onClose={() => setModal(null)}>
          <form onSubmit={save}>
            <div className="form-grid">
              <FG label="Title" full>
                <input className="form-input" required value={modal.title} placeholder="e.g. Riverside Renovation - Phase 1 Complete"
                  onChange={e => setModal(m => ({ ...m, title: e.target.value }))} />
              </FG>
              <FG label="Update" full>
                <textarea className="form-input" required value={modal.body} placeholder="What investors should know…"
                  onChange={e => setModal(m => ({ ...m, body: e.target.value }))} style={{ minHeight: 110, resize: 'vertical' }} />
              </FG>
              <FG label="Deal (Optional)">
                <select className="form-select" value={modal.fundId} onChange={e => setModal(m => ({ ...m, fundId: e.target.value }))}>
                  <option value="">All Deals</option>
                  {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </FG>
              <div className="form-group" style={{ justifyContent: 'flex-end' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', cursor: 'pointer' }}>
                  <input type="checkbox" checked={modal.pinned} onChange={e => setModal(m => ({ ...m, pinned: e.target.checked }))} />
                  Pin to Top
                </label>
              </div>
              {formErr && <div className="form-group-full" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{formErr}</div>}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy && <Loader size={13} style={{ animation: 'spin 0.8s linear infinite' }} />}
                {modal.id ? 'Save Changes' : 'Post Update'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
