import { useState } from 'react';
import { Send, FileText } from 'lucide-react';
import { useRequisitions } from '../contexts/RequisitionContext';

const ITEMS = ['Laptop','PC','Monitors','Speakers','Headset','Mouse','Keyboard','Battery Backup','Webcam','Safety Vest','Safety Helmet','Hand Tools','Power Tools','Nametag','Uniforms','Keys & Key Sets','Tablet','Phone'];
const DEPTS = ['Operations','Accounting','IT Support','Real Estate','Marketing','Admin','Construction'];

const STATUS_LABEL = {
  pending_manager:   'Pending Approval',
  rejected:          'Rejected',
  manager_approved:  'Manager Approved',
  asset_allocated:   'Asset Allocated',
  return_initiated:  'Return Initiated',
  returned:          'Returned & Closed',
  asset_lost:        'Asset Lost',
};
const STATUS_CLASS = {
  pending_manager:   'status-pending',
  rejected:          'status-rejected',
  manager_approved:  'status-badge',
  asset_allocated:   'status-approved',
  return_initiated:  'status-pending',
  returned:          'status-approved',
  asset_lost:        'status-rejected',
};

export default function Purchase() {
  const { requisitions, submitRequisition, exportToCsv } = useRequisitions();

  const [employeeName, setEmployeeName] = useState('');
  const [item,         setItem]         = useState('');
  const [qty,          setQty]          = useState(1);
  const [dept,         setDept]         = useState('Operations');
  const [reason,       setReason]       = useState('');
  const [flash,        setFlash]        = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!item || !employeeName.trim() || !reason.trim()) return;
    submitRequisition({ employeeName: employeeName.trim(), employeeDept: dept, item, quantity: qty, reason: reason.trim() });
    setEmployeeName(''); setItem(''); setQty(1); setDept('Operations'); setReason('');
    setFlash(true);
    setTimeout(() => setFlash(false), 3500);
  };

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <div className="purchase-view">
      <div className="view-header">
        <div className="view-title-group">
          <h2>Purchase Requisition &amp; Approvals</h2>
          <p>Request construction materials, software licenses, or assets and track approval status</p>
        </div>
        {requisitions.length > 0 && (
          <button className="secondary-btn" onClick={exportToCsv} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FileText size={15} /> Export to CSV
          </button>
        )}
      </div>

      <div className="purchase-split">
        {/* ── Left: Form ── */}
        <div className="purchase-form-card">
          <h3>Create Purchase Requisition</h3>

          {flash && (
            <div style={{ background: 'hsla(142,60%,45%,0.12)', border: '1px solid hsla(142,60%,45%,0.35)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '0.85rem', color: 'hsl(142,60%,40%)' }}>
              ✓ Requisition submitted — pending manager approval.
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="form-group">
                <label htmlFor="req-name">Employee Name</label>
                <input
                  id="req-name" type="text" className="form-input"
                  placeholder="Your full name" required
                  value={employeeName} onChange={e => setEmployeeName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="req-dept">Department</label>
                <select id="req-dept" className="form-select" value={dept} onChange={e => setDept(e.target.value)}>
                  {DEPTS.map(d => <option key={d}>{d}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="req-item">Item Selection</label>
                <select id="req-item" className="form-select" required value={item} onChange={e => setItem(e.target.value)}>
                  <option value="" disabled>Select an item...</option>
                  {ITEMS.map(i => <option key={i}>{i}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="req-qty">Quantity</label>
                <input
                  id="req-qty" type="number" className="form-input"
                  min="1" value={qty} onChange={e => setQty(e.target.value)} required
                />
              </div>

              <div className="form-group">
                <label htmlFor="req-reason">Reason / Justification</label>
                <textarea
                  id="req-reason" className="form-input" rows={3}
                  placeholder="Describe why this item is needed..."
                  required value={reason} onChange={e => setReason(e.target.value)}
                  style={{ resize: 'vertical', lineHeight: 1.5 }}
                />
              </div>
            </div>

            <button type="submit" className="primary-btn" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}>
              <Send size={14} /> Submit Requisition
            </button>
          </form>
        </div>

        {/* ── Right: Table ── */}
        <div className="requisitions-list-card">
          <h3>Requisition Logs</h3>
          <div className="req-table-wrapper">
            <table className="req-table">
              <thead>
                <tr>
                  <th>Req ID</th>
                  <th>Item / Department</th>
                  <th>Submitted By</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {requisitions.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '36px 0', fontSize: '0.9rem' }}>
                      No requisitions yet — submit one using the form.
                    </td>
                  </tr>
                )}
                {requisitions.map(req => (
                  <tr key={req.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{req.id}</td>
                    <td>
                      <div className="req-item-name">{req.item}</div>
                      <div className="req-item-dept">{req.employeeDept} · Qty: {req.quantity}</div>
                    </td>
                    <td style={{ fontSize: '0.88rem' }}>{req.employeeName}</td>
                    <td>
                      <span className={`status-badge ${STATUS_CLASS[req.status] || 'status-badge'}`}>
                        {STATUS_LABEL[req.status] || req.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {req.status === 'rejected' && (
                        <span style={{ color: 'hsl(var(--color-red))' }} title={req.rejectionReason}>
                          ⚠ {req.rejectionReason ? req.rejectionReason.substring(0, 28) + (req.rejectionReason.length > 28 ? '…' : '') : 'Rejected'}
                        </span>
                      )}
                      {req.status === 'asset_allocated' && (
                        <span style={{ color: 'hsl(var(--color-green))' }}>✓ {req.assetName}</span>
                      )}
                      {req.status === 'manager_approved' && (
                        <span style={{ color: 'hsl(var(--color-blue))' }}>Routing to {req.supervisorName}</span>
                      )}
                      {req.status === 'pending_manager' && (
                        <span style={{ color: 'var(--text-muted)' }}>{fmtDate(req.createdAt)}</span>
                      )}
                      {req.status === 'returned' && (
                        <span style={{ color: 'hsl(var(--color-green))' }}>Closed {fmtDate(req.actualReturnDate)}</span>
                      )}
                      {req.status === 'return_initiated' && (
                        <span style={{ color: 'hsl(var(--color-orange))' }}>Awaiting confirmation</span>
                      )}
                      {req.status === 'asset_lost' && (
                        <span style={{ color: 'hsl(var(--color-red))' }}>Asset lost</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
