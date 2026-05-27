import { useState } from 'react';
import { Send, X } from 'lucide-react';

const ITEMS = ['Laptop','PC','Monitors','Speakers','Headset','Mouse','Keyboard','Battery Backup','Webcam','Safety Vest','Safety Helmet','Hand Tools','Power Tools','Nametag','Uniforms','Keys & Key Sets','Tablet','Phone'];
const DEPTS = ['OPS','Accounting','IT','Development','Marketing','Admin'];

const INIT_REQUESTS = [
  { id: 8492, item: 'Premium Ready-Mix Concrete - 120 Cubic Yards', vendor: 'Apex Building Supplies', cost: 120, qty: 120, dept: 'OPS', status: 'pending' },
  { id: 7721, item: 'Architectural Consulting Fees - Phase 3', vendor: 'Studio-D Designs', cost: 5000, qty: 1, dept: 'Development', status: 'pending' },
  { id: 3108, item: 'Heavy Duty Excavation Equipment Rental', vendor: 'Herc Rentals', cost: 1850, qty: 2, dept: 'OPS', status: 'pending' },
  { id: 6241, item: 'Autodesk AutoCAD Core Team Subscriptions', vendor: 'Autodesk Reseller', cost: 1680, qty: 6, dept: 'IT', status: 'pending' },
  { id: 4902, item: 'Corporate Financial Audit Consulting', vendor: 'Deloitte LLP', cost: 8500, qty: 1, dept: 'Accounting', status: 'pending' },
  { id: 1045, item: 'Google Local Service Ads - Q2 Budget Boost', vendor: 'Google Ads', cost: 4200, qty: 1, dept: 'Marketing', status: 'approved' },
];

export default function Purchase() {
  const [requests, setRequests] = useState(INIT_REQUESTS);
  const [item, setItem] = useState('');
  const [qty, setQty] = useState(1);
  const [dept, setDept] = useState('OPS');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!item) return;
    setRequests(prev => [{ id: Math.floor(1000 + Math.random() * 9000), item, vendor: '', cost: 0, qty: Number(qty), dept, status: 'pending' }, ...prev]);
    setItem(''); setQty(1); setDept('OPS');
  };

  const approve = (id) => setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'approved' } : r));
  const reject = (id) => setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'rejected' } : r));

  const formatCost = (r) => r.cost
    ? (r.cost * r.qty).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—';

  return (
    <div className="purchase-view">
      <div className="view-header">
        <div className="view-title-group">
          <h2>Purchase Requisition &amp; Approvals</h2>
          <p>Request construction materials, software licenses, or assets and approve pending requisitions</p>
        </div>
      </div>

      <div className="purchase-split">
        {/* Left: Form */}
        <div className="purchase-form-card">
          <h3>Create Purchase Requisition</h3>
          <form onSubmit={handleSubmit}>
            <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="form-group">
                <label htmlFor="req-item">Item Selection</label>
                <select id="req-item" className="form-select" required value={item} onChange={e => setItem(e.target.value)}>
                  <option value="" disabled>Select an item...</option>
                  {ITEMS.map(i => <option key={i}>{i}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="req-qty">Quantity</label>
                <input id="req-qty" type="number" className="form-input" min="1" value={qty} onChange={e => setQty(e.target.value)} required />
              </div>
              <div className="form-group">
                <label htmlFor="req-dept">Department</label>
                <select id="req-dept" className="form-select" value={dept} onChange={e => setDept(e.target.value)}>
                  {DEPTS.map(d => <option key={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <button type="submit" className="primary-btn" style={{ width: '100%', justifyContent: 'center', marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Send size={16} /> Submit Requisition
            </button>
          </form>
        </div>

        {/* Right: Table */}
        <div className="requisitions-list-card">
          <h3>Recent Requisition Logs</h3>
          <div className="req-table-wrapper">
            <table className="req-table">
              <thead>
                <tr>
                  <th>Req ID</th>
                  <th>Item / Department</th>
                  <th>Total Cost</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(req => (
                  <tr key={req.id}>
                    <td>#{req.id}</td>
                    <td>
                      <div className="req-item-name">{req.item}</div>
                      <div className="req-item-dept">{req.dept}{req.vendor ? ` • Vendor: ${req.vendor}` : ''}</div>
                    </td>
                    <td style={{ fontWeight: 600 }}>{formatCost(req)}</td>
                    <td><span className={`status-badge status-${req.status}`}>{req.status}</span></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {req.status === 'pending' ? (
                        <>
                          <button className="primary-btn" onClick={() => approve(req.id)} style={{ padding: '4px 8px', fontSize: '0.75rem', backgroundColor: 'hsl(var(--color-green))', borderRadius: 4, marginRight: 4 }}>Approve</button>
                          <button className="secondary-btn" onClick={() => reject(req.id)} style={{ padding: '4px 8px', fontSize: '0.75rem', color: 'hsl(var(--color-red))', borderColor: 'hsla(var(--color-red), 0.2)', borderRadius: 4 }}>Reject</button>
                        </>
                      ) : (
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>Closed</span>
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
