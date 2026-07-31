import { useEffect, useRef, useState } from 'react';
import { ExternalLink, File, FileImage, FileSpreadsheet, FileText, Files, Loader, Paperclip, Trash2, Upload } from 'lucide-react';
import { api } from '../api';
import { useNameResolver } from '../lib/useNameResolver';
import { formatDate } from './lib/format';
import { IR_BUCKET, safeFileName, uploadToSupabase } from './lib/upload';
import { EmptyState, ErrorState, FG, LoadingState, Modal, useIrLoad } from './lib/ui';

// Category → label + accent color (rendered as colored text, never a pill).
const CATEGORY_META = {
  subscription_agreement: { label: 'Subscription Agreement', color: 'hsl(var(--color-blue))' },
  k1:                     { label: 'K-1',                    color: 'hsl(var(--color-orange))' },
  ppm:                    { label: 'PPM',                    color: 'hsl(var(--color-blue))' },
  quarterly_report:       { label: 'Quarterly Report',       color: 'hsl(var(--color-green))' },
  capital_call_notice:    { label: 'Capital Call Notice',    color: 'hsl(var(--color-orange))' },
  distribution_notice:    { label: 'Distribution Notice',    color: 'hsl(var(--color-green))' },
  other:                  { label: 'Other',                  color: 'var(--muted)' },
};

function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return FileText;
  if (['doc', 'docx'].includes(ext)) return FileText;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return FileImage;
  return File;
}

export default function DocumentsTab() {
  const nameOf = useNameResolver();
  const [fundFilter, setFundFilter] = useState('');
  const [investorFilter, setInvestorFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const { data: docs, loading, error, reload } =
    useIrLoad(() => api.getIrDocuments({ fundId: fundFilter, investorId: investorFilter, category: categoryFilter }), [fundFilter, investorFilter, categoryFilter]);

  const [funds, setFunds] = useState([]);
  const [investors, setInvestors] = useState([]);
  useEffect(() => {
    api.getIrFunds().then(d => setFunds(Array.isArray(d) ? d : [])).catch(() => {});
    api.getIrInvestors().then(d => setInvestors(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const [modal, setModal] = useState(null); // { file, title, category, fundId, investorId }
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState('');
  const [rowErr, setRowErr] = useState('');
  const fileRef = useRef(null);

  const openUpload = () => {
    setFormErr('');
    setModal({ file: null, title: '', category: 'other', fundId: fundFilter || '', investorId: investorFilter || '' });
  };

  const takeFile = (file) => {
    if (!file) return;
    setModal(m => ({ ...m, file, title: m.title || file.name.replace(/\.[^.]+$/, '') }));
  };

  // Ctrl+V a screenshot/snip anywhere in the modal → attach it (app-wide
  // convention: every upload widget accepts clipboard paste).
  const handlePaste = (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      const f = it.getAsFile?.();
      if (f) { takeFile(f); e.preventDefault(); return; }
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFormErr('');
    try {
      let fileUrl = '';
      let fileName = '';
      if (modal.file) {
        const path = `documents/${modal.fundId || 'general'}/${Date.now()}-${safeFileName(modal.file.name)}`;
        const { url, error: upErr } = await uploadToSupabase(modal.file, IR_BUCKET, path);
        if (upErr) throw new Error(upErr);
        fileUrl = url;
        fileName = modal.file.name;
      }
      await api.createIrDocument({
        title: modal.title.trim(),
        category: modal.category,
        fundId: modal.fundId ? Number(modal.fundId) : null,
        investorId: modal.investorId ? Number(modal.investorId) : null,
        fileUrl, fileName,
      });
      setModal(null);
      await reload();
    } catch (err) {
      setFormErr(err?.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (doc) => {
    if (!window.confirm(`Delete "${doc.title}"? The record is removed from the register (the stored file is kept).`)) return;
    setRowErr('');
    try {
      await api.deleteIrDocument(doc.id);
      await reload();
    } catch (err) {
      setRowErr(err?.message || 'Delete failed.');
    }
  };

  const rows = docs || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--ink)', margin: 0 }}>Documents</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '3px 0 0' }}>Deal and investor paperwork - PPMs, K-1s, notices, and reports</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="form-select" style={{ width: 180 }} value={fundFilter} onChange={e => setFundFilter(e.target.value)}>
            <option value="">All Deals</option>
            {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <select className="form-select" style={{ width: 180 }} value={investorFilter} onChange={e => setInvestorFilter(e.target.value)}>
            <option value="">All Investors</option>
            {investors.map(i => <option key={i.id} value={i.id}>{i.displayName}</option>)}
          </select>
          <select className="form-select" style={{ width: 180 }} value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
            <option value="">All Categories</option>
            {Object.entries(CATEGORY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
          <button className="primary-btn" onClick={openUpload} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Upload size={14} /> Upload Document
          </button>
        </div>
      </div>

      {rowErr && <ErrorState message={rowErr} />}

      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={reload} /> : rows.length === 0 ? (
        <EmptyState icon={Files} title="No Documents"
          sub={fundFilter || investorFilter || categoryFilter ? 'Nothing matches the current filters.' : 'Upload subscription agreements, K-1s, and reports to build the register.'} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="req-table stack-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Category</th>
                <th>Scope</th>
                <th>Uploaded By</th>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(doc => {
                const meta = CATEGORY_META[doc.category] || CATEGORY_META.other;
                const Icon = fileIcon(doc.fileName || doc.fileUrl);
                return (
                  <tr key={doc.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <Icon size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{doc.title}</div>
                          {doc.fileName && <div style={{ fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>{doc.fileName}</div>}
                        </div>
                      </div>
                    </td>
                    <td data-th="Category"><span style={{ color: meta.color, fontSize: 12.5, fontWeight: 600 }}>{meta.label}</span></td>
                    <td data-th="Scope" style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                      {[doc.fundName, doc.investorName].filter(Boolean).join(' · ') || 'All Deals'}
                    </td>
                    <td data-th="Uploaded By" style={{ fontSize: 12.5, color: 'var(--muted)' }}>{doc.uploadedBy ? nameOf(doc.uploadedBy) : '-'}</td>
                    <td data-th="Date" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{formatDate(doc.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        {doc.fileUrl ? (
                          <a href={doc.fileUrl} target="_blank" rel="noreferrer"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--color-blue))', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>
                            <ExternalLink size={13} /> Open
                          </a>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>No file attached</span>
                        )}
                        <button onClick={() => remove(doc)} title="Delete document"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4, display: 'inline-flex' }}
                          onMouseEnter={e => { e.currentTarget.style.color = 'hsl(var(--color-red))'; }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'var(--muted)'; }}>
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal title="Upload Document" onClose={() => setModal(null)}>
          <form onSubmit={save} onPaste={handlePaste}>
            <div className="form-grid">
              <div className="form-group form-group-full">
                <label>File</label>
                <input ref={fileRef} type="file" style={{ display: 'none' }}
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp"
                  onChange={e => { takeFile(e.target.files?.[0]); e.target.value = ''; }} />
                <div onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') fileRef.current?.click(); }}
                  style={{ border: '1px dashed var(--line)', borderRadius: 10, padding: '18px 16px', textAlign: 'center', cursor: 'pointer', color: 'var(--muted)', fontSize: 12.5 }}>
                  {modal.file ? (
                    <span style={{ color: 'var(--ink)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <Paperclip size={13} /> {modal.file.name}
                    </span>
                  ) : (
                    <>Click to choose a file - or press Ctrl+V to paste a screenshot<br />
                      <span style={{ fontSize: 11 }}>PDF, Word, Excel, or image · up to 25 MB · optional</span></>
                  )}
                </div>
              </div>
              <FG label="Title" full>
                <input className="form-input" required value={modal.title} placeholder="e.g. 2026 K-1 - Patel Family Trust"
                  onChange={e => setModal(m => ({ ...m, title: e.target.value }))} />
              </FG>
              <FG label="Category">
                <select className="form-select" value={modal.category} onChange={e => setModal(m => ({ ...m, category: e.target.value }))}>
                  {Object.entries(CATEGORY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                </select>
              </FG>
              <FG label="Deal (Optional)">
                <select className="form-select" value={modal.fundId} onChange={e => setModal(m => ({ ...m, fundId: e.target.value }))}>
                  <option value="">All Deals</option>
                  {funds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </FG>
              <FG label="Investor (Optional)" full>
                <select className="form-select" value={modal.investorId} onChange={e => setModal(m => ({ ...m, investorId: e.target.value }))}>
                  <option value="">Not investor-specific</option>
                  {investors.map(i => <option key={i.id} value={i.id}>{i.displayName}</option>)}
                </select>
              </FG>
              {formErr && <div className="form-group-full" style={{ color: 'hsl(var(--color-red))', fontSize: 12.5 }}>{formErr}</div>}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-btn" onClick={() => setModal(null)}>Cancel</button>
              <button type="submit" className="primary-btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {busy && <Loader size={13} style={{ animation: 'spin 0.8s linear infinite' }} />}
                Save Document
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
