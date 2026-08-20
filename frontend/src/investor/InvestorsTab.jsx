import { useEffect, useState } from 'react';
import { Loader, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../api';
import { useNameResolver } from '../lib/useNameResolver';
import { usePeopleDirectory } from '../lib/queries';
import { formatCurrency, statusLabel } from './lib/format';
import { EmptyState, ErrorState, FG, LoadingState, Modal, PeopleSelect, StatusText, useIrLoad } from './lib/ui';

const BLANK = {
  displayName: '', entityType: 'individual', email: '', phone: '', address: '',
  accreditedStatus: 'unverified', kycStatus: 'pending', taxIdOnFile: false,
  relationshipOwnerEmail: '', notes: '', status: 'active',
};

const s = v => (v === null || v === undefined ? '' : String(v));

export default function InvestorsTab() {
  const nameOf = useNameResolver();
  const { data: investors, loading, error, reload } = useIrLoad(() => api.getIrInvestors(), []);
  const { data: people = [] } = usePeopleDirectory();

  const [modal, setModal] = useState(null); // { id?, form }
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');

  const openAdd = () => { setFormErr(''); setModal({ id: null, form: { ...BLANK }, initialForm: { ...BLANK } }); };
  const openEdit = (inv) => {
    setFormErr('');
    const form = {
      displayName: s(inv.displayName), entityType: inv.entityType || 'individual',
      email: s(inv.email), phone: s(inv.phone), address: s(inv.address),
      accreditedStatus: inv.accreditedStatus || 'unverified', kycStatus: inv.kycStatus || 'pending',
      taxIdOnFile: !!inv.taxIdOnFile, relationshipOwnerEmail: s(inv.relationshipOwnerEmail),
      notes: s(inv.notes), status: inv.status || 'active',
    };
    setModal({ id: inv.id, form, initialForm: form });
  };

  const setF = patch => setModal(m => ({ ...m, form: { ...m.form, ...patch } }));
  const dirty = modal ? JSON.stringify(modal.form) !== JSON.stringify(modal.initialForm) : false;

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr('');
    try {
      const f = modal.form;
      const payload = {
        displayName: f.displayName.trim(),
        entityType: f.entityType,
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
        address: f.address.trim() || null,
        accreditedStatus: f.accreditedStatus,
        kycStatus: f.kycStatus,
        taxIdOnFile: !!f.taxIdOnFile,
        relationshipOwnerEmail: f.relationshipOwnerEmail || null,
        notes: f.notes.trim() || null,
        status: f.status,
      };
      if (modal.id) await api.updateIrInvestor(modal.id, payload);
      else await api.createIrInvestor(payload);
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!modal?.id || busy) return;
    if (!window.confirm('Delete this investor? Their commitments and history may be affected.')) return;
    setBusy(true); setFormErr('');
    try {
      await api.deleteIrInvestor(modal.id);
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const rows = investors || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>Investors</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Investors - contact, accreditation, KYC, and total capital committed</p>
        </div>
        <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add Investor
        </button>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <EmptyState icon={Users} title="No Investors Yet" sub="Add your investors here - commitments and capital accounts link back to them." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="req-table stack-table">
            <thead>
              <tr>
                <th>Investor</th>
                <th>Type</th>
                <th>Contact</th>
                <th>Accredited</th>
                <th>KYC</th>
                <th style={{ textAlign: 'right' }}>Committed</th>
                <th style={{ textAlign: 'right' }}>Deals</th>
                <th>Relationship Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map(inv => (
                <tr key={inv.id} onClick={() => openEdit(inv)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                      {inv.displayName}
                      {inv.status !== 'active' && <StatusText status={inv.status} size={11} />}
                    </div>
                  </td>
                  <td data-th="Type" style={{ color: 'var(--muted)' }}>{statusLabel(inv.entityType)}</td>
                  <td data-th="Contact">
                    <div style={{ fontSize: 12.5 }}>{inv.email || '-'}</div>
                    {inv.phone && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{inv.phone}</div>}
                  </td>
                  <td data-th="Accredited"><StatusText status={inv.accreditedStatus} /></td>
                  <td data-th="KYC"><StatusText status={inv.kycStatus} /></td>
                  <td data-th="Committed" style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(inv.totalCommitted)}</td>
                  <td data-th="Deals" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{inv.fundCount ?? 0}</td>
                  <td data-th="Owner" style={{ color: 'var(--muted)' }}>{inv.relationshipOwnerEmail ? nameOf(inv.relationshipOwnerEmail) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal title={modal.id ? 'Edit Investor' : 'Add Investor'} onClose={() => setModal(null)} width={600} isDirty={dirty} onSave={() => save({ preventDefault() {} })}>
          <form onSubmit={save}>
            <div className="form-grid">
              <FG label="Display Name" full>
                <input className="form-input" required value={modal.form.displayName}
                  placeholder="e.g. The Patel Family Trust" onChange={e => setF({ displayName: e.target.value })} />
              </FG>
              <FG label="Entity Type">
                <select className="form-select" value={modal.form.entityType} onChange={e => setF({ entityType: e.target.value })}>
                  <option value="individual">Individual</option>
                  <option value="llc">LLC</option>
                  <option value="trust">Trust</option>
                  <option value="ira">IRA</option>
                  <option value="corporation">Corporation</option>
                  <option value="partnership">Partnership</option>
                </select>
              </FG>
              <FG label="Status">
                <select className="form-select" value={modal.form.status} onChange={e => setF({ status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="prospect">Prospect</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FG>
              <FG label="Email">
                <input className="form-input" type="email" value={modal.form.email} onChange={e => setF({ email: e.target.value })} />
              </FG>
              <FG label="Phone">
                <input className="form-input" value={modal.form.phone} onChange={e => setF({ phone: e.target.value })} />
              </FG>
              <FG label="Address" full>
                <input className="form-input" value={modal.form.address} onChange={e => setF({ address: e.target.value })} />
              </FG>
              <FG label="Accredited Status">
                <select className="form-select" value={modal.form.accreditedStatus} onChange={e => setF({ accreditedStatus: e.target.value })}>
                  <option value="unverified">Unverified</option>
                  <option value="self_certified">Self-Certified</option>
                  <option value="verified">Verified</option>
                </select>
              </FG>
              <FG label="KYC Status">
                <select className="form-select" value={modal.form.kycStatus} onChange={e => setF({ kycStatus: e.target.value })}>
                  <option value="pending">Pending</option>
                  <option value="in_review">In Review</option>
                  <option value="cleared">Cleared</option>
                  <option value="flagged">Flagged</option>
                </select>
              </FG>
              <FG label="Relationship Owner" full>
                <PeopleSelect value={modal.form.relationshipOwnerEmail} onChange={v => setF({ relationshipOwnerEmail: v })} people={people} placeholder="Who manages this relationship…" />
              </FG>
              <div className="form-group form-group-full">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', cursor: 'pointer' }}>
                  <input type="checkbox" checked={modal.form.taxIdOnFile} onChange={e => setF({ taxIdOnFile: e.target.checked })} />
                  Tax ID on File (W-9 / W-8 received)
                </label>
              </div>
              <FG label="Notes" full>
                <textarea className="form-input" value={modal.form.notes} onChange={e => setF({ notes: e.target.value })}
                  style={{ minHeight: 64, resize: 'vertical' }} placeholder="Source of relationship, preferences, anything the team should know…" />
              </FG>
              {formErr && <div className="form-group-full" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{formErr}</div>}
            </div>
            <div className="modal-footer">
              {modal.id && (
                <button type="button" className="secondary-btn" disabled={busy} onClick={remove}
                  style={{ marginRight: 'auto', color: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Trash2 size={14} /> Delete
                </button>
              )}
              <button type="button" className="secondary-btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy && <Loader size={13} style={{ animation: 'spin 0.8s linear infinite' }} />}
                {modal.id ? 'Save Changes' : 'Create Investor'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
