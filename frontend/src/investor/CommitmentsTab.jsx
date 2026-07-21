import { useEffect, useRef, useState } from 'react';
import { FileSignature, FileText, Loader, Paperclip, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatCurrency, formatDate } from './lib/format';
import { IR_BUCKET, safeFileName, uploadToSupabase } from './lib/upload';
import { EmptyState, ErrorState, FG, LoadingState, Modal, StatusText, useIrLoad } from './lib/ui';

const today = () => new Date().toISOString().slice(0, 10);

export default function CommitmentsTab() {
  const [fundFilter, setFundFilter] = useState('');
  const [investorFilter, setInvestorFilter] = useState('');
  const { data: commitments, loading, error, reload } =
    useIrLoad(() => api.getIrCommitments({ fundId: fundFilter, investorId: investorFilter }), [fundFilter, investorFilter]);

  const [funds, setFunds] = useState([]);
  const [investors, setInvestors] = useState([]);
  useEffect(() => {
    api.getIrFunds().then(d => setFunds(Array.isArray(d) ? d : [])).catch(() => {});
    api.getIrInvestors().then(d => setInvestors(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const [modal, setModal] = useState(null); // { id?, form }
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [rowErr, setRowErr] = useState('');

  // Per-row subscription-doc upload: one hidden input, remember which row asked.
  const fileRef = useRef(null);
  const uploadRowRef = useRef(null);
  const [uploadingId, setUploadingId] = useState(null);

  const startUpload = (c) => { uploadRowRef.current = c; fileRef.current?.click(); };
  const onFilePicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const row = uploadRowRef.current;
    if (!file || !row) return;
    setUploadingId(row.id); setRowErr('');
    const path = `commitments/${row.fundId}/${Date.now()}-${safeFileName(file.name)}`;
    const { url, error: upErr } = await uploadToSupabase(file, IR_BUCKET, path);
    if (upErr) { setRowErr(upErr); setUploadingId(null); return; }
    try {
      await api.updateIrCommitment(row.id, { signedDocUrl: url, signedDocName: file.name });
      await reload();
    } catch (err) {
      setRowErr(err?.message || 'Could not attach the document.');
    } finally {
      setUploadingId(null);
    }
  };

  const openAdd = () => {
    setFormErr('');
    setModal({ id: null, form: { fundId: fundFilter || '', investorId: investorFilter || '', commitmentAmount: '', units: '', subscriptionDate: today(), status: 'pending' } });
  };
  const openEdit = (c) => {
    setFormErr('');
    setModal({
      id: c.id, investorName: c.investorName, fundName: c.fundName,
      form: {
        fundId: String(c.fundId), investorId: String(c.investorId),
        commitmentAmount: c.commitmentAmount ?? '', units: c.units ?? '',
        subscriptionDate: (c.subscriptionDate || '').slice(0, 10), status: c.status || 'pending',
      },
    });
  };

  const setF = patch => setModal(m => ({ ...m, form: { ...m.form, ...patch } }));

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr('');
    try {
      const f = modal.form;
      const payload = {
        fundId: Number(f.fundId), investorId: Number(f.investorId),
        commitmentAmount: Number(f.commitmentAmount) || 0,
        units: f.units === '' ? null : Number(f.units),
        subscriptionDate: f.subscriptionDate || null,
        status: f.status,
      };
      if (modal.id) await api.updateIrCommitment(modal.id, payload);
      else await api.createIrCommitment(payload);
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
    if (!window.confirm('Delete this commitment? Allocations already generated from it may be affected.')) return;
    setBusy(true); setFormErr('');
    try {
      await api.deleteIrCommitment(modal.id);
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const rows = commitments || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>Commitments</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Signed subscriptions — who committed how much, to which deal</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-select" style={{ width: 200 }} value={fundFilter} onChange={e => setFundFilter(e.target.value)}>
            <option value="">All Deals</option>
            {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select className="form-select" style={{ width: 200 }} value={investorFilter} onChange={e => setInvestorFilter(e.target.value)}>
            <option value="">All Investors</option>
            {investors.map(i => <option key={i.id} value={i.id}>{i.displayName}</option>)}
          </select>
          <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> Add Commitment
          </button>
        </div>
      </div>

      <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" style={{ display: 'none' }} onChange={onFilePicked} />
      {rowErr && <ErrorState message={rowErr} />}

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <EmptyState icon={FileSignature} title="No Commitments Found"
          sub={fundFilter || investorFilter ? 'Nothing matches the current filters.' : 'Record a subscription to link an investor to a fund.'} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="req-table stack-table">
            <thead>
              <tr>
                <th>Investor</th>
                <th>Deal</th>
                <th style={{ textAlign: 'right' }}>Commitment</th>
                <th style={{ textAlign: 'right' }}>Units</th>
                <th>Subscription Date</th>
                <th>Status</th>
                <th>Subscription Doc</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600, cursor: 'pointer' }} onClick={() => openEdit(c)}>{c.investorName}</td>
                  <td data-th="Deal" style={{ cursor: 'pointer' }} onClick={() => openEdit(c)}>{c.fundName}</td>
                  <td data-th="Commitment" style={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }} onClick={() => openEdit(c)}>{formatCurrency(c.commitmentAmount)}</td>
                  <td data-th="Units" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }} onClick={() => openEdit(c)}>{c.units ?? '—'}</td>
                  <td data-th="Subscribed" style={{ cursor: 'pointer' }} onClick={() => openEdit(c)}>{formatDate(c.subscriptionDate)}</td>
                  <td data-th="Status" style={{ cursor: 'pointer' }} onClick={() => openEdit(c)}><StatusText status={c.status} /></td>
                  <td data-th="Doc">
                    {c.signedDocUrl ? (
                      <a href={c.signedDocUrl} target="_blank" rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'hsl(var(--color-blue))', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>
                        <FileText size={13} /> {c.signedDocName || 'View Document'}
                      </a>
                    ) : (
                      <button className="secondary-btn" disabled={uploadingId === c.id} onClick={() => startUpload(c)}
                        style={{ fontSize: 12, padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {uploadingId === c.id
                          ? <Loader size={12} style={{ animation: 'spin 0.8s linear infinite' }} />
                          : <Paperclip size={12} />} Attach
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal title={modal.id ? `Edit Commitment — ${modal.investorName}` : 'Add Commitment'} onClose={() => setModal(null)}>
          <form onSubmit={save}>
            <div className="form-grid">
              <FG label="Investor" full>
                <select className="form-select" required disabled={!!modal.id} value={modal.form.investorId} onChange={e => setF({ investorId: e.target.value })}>
                  <option value="">Select an investor…</option>
                  {investors.map(i => <option key={i.id} value={i.id}>{i.displayName}</option>)}
                </select>
              </FG>
              <FG label="Deal" full>
                <select className="form-select" required disabled={!!modal.id} value={modal.form.fundId} onChange={e => setF({ fundId: e.target.value })}>
                  <option value="">Select a deal…</option>
                  {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </FG>
              <FG label="Commitment Amount ($)">
                <input className="form-input" type="number" min="0" step="any" required value={modal.form.commitmentAmount}
                  onChange={e => setF({ commitmentAmount: e.target.value })} />
              </FG>
              <FG label="Units">
                <input className="form-input" type="number" min="0" step="any" value={modal.form.units}
                  onChange={e => setF({ units: e.target.value })} />
              </FG>
              <FG label="Subscription Date">
                <input className="form-input" type="date" value={modal.form.subscriptionDate} onChange={e => setF({ subscriptionDate: e.target.value })} />
              </FG>
              <FG label="Status">
                <select className="form-select" value={modal.form.status} onChange={e => setF({ status: e.target.value })}>
                  <option value="pending">Pending</option>
                  <option value="active">Active</option>
                  <option value="closed">Closed</option>
                  <option value="withdrawn">Withdrawn</option>
                </select>
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
                {modal.id ? 'Save Changes' : 'Record Commitment'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
