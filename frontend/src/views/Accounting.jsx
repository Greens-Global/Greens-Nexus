import { useState } from 'react';
import { TrendingUp, TrendingDown, DollarSign, FileText, ArrowUpRight, ArrowDownRight, CreditCard, SlidersHorizontal, Download, Plus, X, UploadCloud, PiggyBank } from 'lucide-react';

const INIT_TRX = [
  { id: 'TRX-1234', title: 'Project Payment - Downtown Complex', date: 'May 20, 2026', cost: 125000 },
  { id: 'TRX-1235', title: 'Construction Materials', date: 'May 19, 2026', cost: -45200 },
  { id: 'TRX-1236', title: 'Contractor Payment', date: 'May 18, 2026', cost: -67500 },
  { id: 'TRX-1237', title: 'Property Sale Commission', date: 'May 17, 2026', cost: 89000 },
  { id: 'TRX-1238', title: 'Office Rent', date: 'May 16, 2026', cost: -12000 },
];

const INIT_BUDGETS = [
  { id: 1, name: 'Real Estate Development', allocated: 3500000, spent: 2450000 },
  { id: 2, name: 'Operations (OPS)', allocated: 2000000, spent: 1900000 },
  { id: 3, name: 'IT & Infrastructure Support', allocated: 450000, spent: 180000 },
];

const RAMP_TXN = [
  { id: 'TXN-9031', vendor: 'Apex Building Supplies', cost: 145.00, date: 'May 22, 2026', category: 'Office Supplies', memo: 'PO-2209 office consumables', missing: false },
  { id: 'TXN-9032', vendor: 'Cemex Ready-Mix', cost: 1200.00, date: 'May 21, 2026', category: 'Construction', memo: '', missing: true },
  { id: 'TXN-9033', vendor: 'AWS Cloud Billing', cost: 452.10, date: 'May 21, 2026', category: 'IT Services', memo: '', missing: true },
  { id: 'TXN-9034', vendor: 'Home Depot', cost: 89.50, date: 'May 20, 2026', category: 'Supplies', memo: 'Misc. hardware fasteners', missing: false },
  { id: 'TXN-9035', vendor: 'Adobe Creative Cloud', cost: 79.99, date: 'May 19, 2026', category: 'Software', memo: '', missing: true },
];

const AMA_ENTITIES = [
  { id: 1, entity: 'Greens Nexus LLC', status: 'Active', feeRate: 3.5, billedYTD: 142000, nextBilling: '2026-06-01' },
  { id: 2, entity: 'GN Construction Co', status: 'Active', feeRate: 4.0, billedYTD: 98000, nextBilling: '2026-06-01' },
  { id: 3, entity: 'Greens Real Estate Dev Ltd', status: 'Pending Review', feeRate: 3.0, billedYTD: 0, nextBilling: 'TBD' },
  { id: 4, entity: 'Global Property Management Inc', status: 'Active', feeRate: 2.5, billedYTD: 45000, nextBilling: '2026-06-15' },
];

const TABS = ['transactions', 'invoices', 'budgets', 'imports', 'ramp', 'ama', 'mre', 'mri', 'reports'];
const TAB_LABELS = { transactions: 'Transactions', invoices: 'Invoices', budgets: 'Budgets', imports: 'Import Hub', ramp: 'Ramp Cards', ama: 'AMA Entities', mre: 'MRE', mri: 'MRI', reports: 'Reports' };

const fmt = (n) => Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function Accounting({ activeSub, onSubChange }) {
  const sub = activeSub || 'transactions';
  const [trx, setTrx] = useState(INIT_TRX);
  const [budgets, setBudgets] = useState(INIT_BUDGETS);
  const [rampMemos, setRampMemos] = useState({});
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [invForm, setInvForm] = useState({ title: '', type: 'outflow', cost: '', date: new Date().toISOString().split('T')[0] });
  const [budgetForm, setBudgetForm] = useState({ dept: '1', action: 'increase', amt: '' });

  const submitInvoice = (e) => {
    e.preventDefault();
    const cost = parseFloat(invForm.cost) * (invForm.type === 'outflow' ? -1 : 1);
    const id = `TRX-${Math.floor(1000 + Math.random() * 9000)}`;
    const d = new Date(invForm.date);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    setTrx(prev => [{ id, title: invForm.title, date: dateStr, cost }, ...prev]);
    setShowInvoiceModal(false);
    setInvForm({ title: '', type: 'outflow', cost: '', date: new Date().toISOString().split('T')[0] });
  };

  const submitBudget = (e) => {
    e.preventDefault();
    const id = parseInt(budgetForm.dept);
    const amt = parseInt(budgetForm.amt);
    setBudgets(prev => prev.map(b => b.id === id ? { ...b, allocated: b.allocated + (budgetForm.action === 'increase' ? amt : -amt) } : b));
    setShowBudgetModal(false);
    setBudgetForm({ dept: '1', action: 'increase', amt: '' });
  };

  const utilColor = (util) => util > 90 ? 'hsl(var(--color-red))' : util < 50 ? 'hsl(var(--color-green))' : 'hsl(var(--color-blue))';

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header" style={{ marginBottom: 24 }}>
        <div className="view-title-group">
          <h2>Accounting</h2>
          <p>Financial overview, transactions, and budget management</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="secondary-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Download size={16} /> Export Report
          </button>
          {(sub === 'transactions' || sub === 'invoices') && (
            <button className="primary-btn" onClick={() => setShowInvoiceModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Plus size={16} /> New Invoice
            </button>
          )}
          {sub === 'budgets' && (
            <button className="primary-btn" onClick={() => setShowBudgetModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <SlidersHorizontal size={16} /> Adjust Budget
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="cards-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
        {[
          { label: 'Total Revenue', value: '$8.4M', helper: '↑ 12.5% from last quarter', color: 'card-green', helperColor: 'hsl(var(--color-green))', Icon: TrendingUp },
          { label: 'Total Expenses', value: '$6.1M', helper: '↑ 8.2% from last quarter', color: 'card-green', helperColor: 'hsl(var(--color-green))', Icon: TrendingDown },
          { label: 'Net Profit', value: '$2.3M', helper: '↓ 18.9% from last quarter', color: 'card-red', helperColor: 'hsl(var(--color-red))', Icon: DollarSign },
          { label: 'Outstanding Invoices', value: '$450K', helper: '↓ 5.3% from last quarter', color: 'card-red', helperColor: 'hsl(var(--color-red))', Icon: FileText },
        ].map(({ label, value, helper, color, helperColor, Icon }) => (
          <div key={label} className={`kpi-card ${color}`} style={{ cursor: 'default' }}>
            <div className="kpi-card-header">
              <span className="kpi-title">{label}</span>
              <div className="kpi-icon-container"><Icon size={18} /></div>
            </div>
            <div className="kpi-stat" style={{ fontSize: '2rem' }}>{value}</div>
            <div className="kpi-helper" style={{ color: helperColor, fontWeight: 600 }}>{helper}</div>
          </div>
        ))}
      </div>

      {/* Scrollable Tab Pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, overflowX: 'auto', paddingBottom: 8, borderBottom: '1px solid var(--border-color)' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => onSubChange(t)}
            style={{ background: sub === t ? 'var(--text-primary)' : 'none', border: '1px solid var(--border-color)', padding: '8px 16px', borderRadius: 20, fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', color: sub === t ? 'var(--bg-primary)' : 'var(--text-secondary)', whiteSpace: 'nowrap', transition: 'all 0.15s' }}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div style={{ marginBottom: 24 }}>

        {/* Transactions */}
        {sub === 'transactions' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Recent Transactions</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Latest financial activities</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {trx.map(t => {
                const pos = t.cost > 0;
                const color = pos ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))';
                return (
                  <div key={t.id} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', backgroundColor: pos ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-red), 0.1)', color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {pos ? <ArrowUpRight size={18} strokeWidth={2.5} /> : <ArrowDownRight size={18} strokeWidth={2.5} />}
                      </div>
                      <div>
                        <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{t.title}</strong>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>{t.id} · {t.date}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color }}>{pos ? '+' : '-'}{fmt(t.cost)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Invoices */}
        {sub === 'invoices' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Client Invoices</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Outstanding billing statements and due invoices</p>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead>
                  <tr><th>Invoice ID</th><th>Client Name</th><th>Project Name</th><th>Amount</th><th>Status</th><th>Due Date</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>#INV-4029</td>
                    <td style={{ fontWeight: 600 }}>Apex Real Estate Holdings</td>
                    <td>Downtown Commercial Complex</td>
                    <td style={{ fontWeight: 700 }}>$180,000</td>
                    <td><span className="status-badge status-pending">Awaiting Payment</span></td>
                    <td>2026-06-15</td>
                  </tr>
                  <tr>
                    <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>#INV-4028</td>
                    <td style={{ fontWeight: 600 }}>Sarah Jenkins Estates</td>
                    <td>Oakridge Subdivision Phase 1</td>
                    <td style={{ fontWeight: 700 }}>$270,000</td>
                    <td><span className="status-badge status-pending">Awaiting Payment</span></td>
                    <td>2026-06-12</td>
                  </tr>
                  <tr>
                    <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>#INV-4027</td>
                    <td style={{ fontWeight: 600 }}>Metro Retail Corp.</td>
                    <td>Commercial Retail Center Site-B</td>
                    <td style={{ fontWeight: 700 }}>$410,000</td>
                    <td><span className="status-badge status-approved">Paid</span></td>
                    <td>2026-05-18</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Budgets */}
        {sub === 'budgets' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Departmental Budgets</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Approved capital allocations and expenditures</p>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead><tr><th>Department</th><th>Allocated Budget</th><th>Spent Value</th><th>Remaining Budget</th><th>Utilization</th></tr></thead>
                <tbody>
                  {budgets.map(b => {
                    const rem = b.allocated - b.spent;
                    const util = Math.min(100, Math.round((b.spent / b.allocated) * 100));
                    return (
                      <tr key={b.id}>
                        <td style={{ fontWeight: 600 }}>{b.name}</td>
                        <td>{fmt(b.allocated)}</td>
                        <td>{fmt(b.spent)}</td>
                        <td style={{ fontWeight: 600, color: rem < 0 ? 'hsl(var(--color-red))' : 'var(--text-primary)' }}>{fmt(rem)}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 140 }}>
                            <div style={{ flex: 1, height: 6, backgroundColor: 'var(--border-color)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{ width: `${util}%`, height: '100%', backgroundColor: utilColor(util), borderRadius: 3 }} />
                            </div>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{util}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Import Hub */}
        {sub === 'imports' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Financial Import Hub</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Process Fidelity, QuickBooks Payroll, and Tally transactions into Sage Intacct</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
              {[
                { name: 'Fidelity Investments', desc: 'Import retirement accounts, employee benefits, and capital logs.' },
                { name: 'QuickBooks Payroll', desc: 'Import payroll runs, W-4 deductions, and contractor payments.' },
                { name: 'Tally Import', desc: 'Import Tally accounting entries and GST transaction logs.' },
              ].map(svc => (
                <div key={svc.name} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 6, backgroundColor: 'hsla(var(--color-blue), 0.1)', color: 'hsl(var(--color-blue))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <PiggyBank size={18} />
                    </div>
                    <strong style={{ fontSize: '1rem' }}>{svc.name}</strong>
                  </div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.3 }}>{svc.desc}</p>
                  <div style={{ border: '2px dashed var(--border-color)', borderRadius: 8, padding: '24px 16px', textAlign: 'center', cursor: 'pointer' }}>
                    <UploadCloud size={24} style={{ color: 'var(--text-muted)', marginBottom: 8 }} />
                    <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600 }}>Drag file or Click to Browse</span>
                    <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>Supports CSV, XLSX</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Ramp Cards */}
        {sub === 'ramp' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Ramp Corporate Card Transactions</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Review and add missing memo references to card transactions</p>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead><tr><th>Transaction ID</th><th>Vendor</th><th>Category</th><th>Date</th><th>Amount</th><th>Memo / Reference</th><th>Status</th></tr></thead>
                <tbody>
                  {RAMP_TXN.map(t => (
                    <tr key={t.id}>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 600 }}>{t.id}</td>
                      <td style={{ fontWeight: 600 }}>{t.vendor}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{t.category}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{t.date}</td>
                      <td style={{ fontWeight: 700 }}>${t.cost.toFixed(2)}</td>
                      <td>
                        {t.missing
                          ? <input type="text" className="form-input" style={{ height: 28, fontSize: '0.8rem', padding: '4px 8px' }}
                              value={rampMemos[t.id] || ''} onChange={e => setRampMemos(p => ({ ...p, [t.id]: e.target.value }))}
                              placeholder="Add memo..." />
                          : <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.memo}</span>
                        }
                      </td>
                      <td>
                        <span style={{ backgroundColor: t.missing ? 'hsla(var(--color-orange), 0.1)' : 'hsla(var(--color-green), 0.1)', color: t.missing ? 'hsl(var(--color-orange))' : 'hsl(var(--color-green))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
                          {t.missing ? 'Missing Memo' : 'Complete'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* AMA Entities */}
        {sub === 'ama' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>AMA Entity Billing Tracker</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Asset Management Agreement entities, fee rates, and billing schedules</p>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead><tr><th>Entity Name</th><th>Status</th><th>Fee Rate</th><th>Billed YTD</th><th>Next Billing</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {AMA_ENTITIES.map(e => {
                    const active = e.status === 'Active';
                    return (
                      <tr key={e.id}>
                        <td style={{ fontWeight: 600 }}>{e.entity}</td>
                        <td>
                          <span style={{ backgroundColor: active ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-orange), 0.1)', color: active ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{e.status}</span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{e.feeRate}%</td>
                        <td style={{ fontWeight: 700 }}>${e.billedYTD.toLocaleString()}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{e.nextBilling}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.75rem' }}>View Agreement</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* MRE */}
        {sub === 'mre' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>MRE Tenant Payment Register</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Monthly rent collections and tenant payment statuses</p>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th>Rent Amount</th><th>Due Date</th><th>Status</th></tr></thead>
                <tbody>
                  {[
                    { tenant: 'Apex Retail Corp', unit: 'Suite 101', property: 'Downtown Commercial Complex', rent: 18000, due: '2026-06-01', status: 'Paid' },
                    { tenant: 'Metro Coffee House', unit: 'Suite 102', property: 'Downtown Commercial Complex', rent: 6500, due: '2026-06-01', status: 'Paid' },
                    { tenant: 'Harbor View Resident - Unit 4B', unit: 'Unit 4B', property: 'Harbor View Condos', rent: 3200, due: '2026-06-01', status: 'Pending' },
                    { tenant: 'Warehouse Logistics LLC', unit: 'Bay A', property: 'North Industrial Warehouse', rent: 12000, due: '2026-06-15', status: 'Paid' },
                  ].map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.tenant}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{r.unit}</td>
                      <td>{r.property}</td>
                      <td style={{ fontWeight: 700 }}>${r.rent.toLocaleString()}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{r.due}</td>
                      <td><span className={`status-badge ${r.status === 'Paid' ? 'status-approved' : 'status-pending'}`}>{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* MRI */}
        {sub === 'mri' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>MRI Software Sync</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Real-time MRI property management software integration status</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { module: 'General Ledger Sync', lastSync: '2026-05-27 09:15 AM', records: 1240, status: 'Synced' },
                { module: 'Tenant Ledger Export', lastSync: '2026-05-27 09:10 AM', records: 86, status: 'Synced' },
                { module: 'Accounts Payable', lastSync: '2026-05-26 11:00 PM', records: 42, status: 'Pending Review' },
                { module: 'Budget Variance Report', lastSync: '2026-05-26 06:00 PM', records: 18, status: 'Synced' },
              ].map((m, i) => (
                <div key={i} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{m.module}</strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>Last sync: {m.lastSync} · {m.records} records</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ backgroundColor: m.status === 'Synced' ? 'hsla(var(--color-green), 0.1)' : 'hsla(var(--color-orange), 0.1)', color: m.status === 'Synced' ? 'hsl(var(--color-green))' : 'hsl(var(--color-orange))', fontSize: '0.75rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>{m.status}</span>
                    <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.75rem' }}>Force Sync</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reports */}
        {sub === 'reports' && (
          <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow-sm)' }}>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Financial Report Downloads</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 20 }}>Download certified financial statements and audit documents</p>
            <div className="req-table-wrapper">
              <table className="req-table">
                <thead><tr><th>Report Name</th><th>Period</th><th>Generated By</th><th>File Size</th><th style={{ textAlign: 'right' }}>Download</th></tr></thead>
                <tbody>
                  {[
                    { name: 'Q1 2026 Financial Statement', period: 'Jan – Mar 2026', by: 'Deloitte LLP', size: '4.2 MB' },
                    { name: 'Annual Budget Variance Report FY2025', period: 'Full Year 2025', by: 'Internal Finance', size: '2.8 MB' },
                    { name: 'Q4 2025 Audited Balance Sheet', period: 'Oct – Dec 2025', by: 'Deloitte LLP', size: '5.1 MB' },
                    { name: 'Cash Flow Projection H2 2026', period: 'Jul – Dec 2026', by: 'CFO Office', size: '1.4 MB' },
                  ].map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>{r.period}</td>
                      <td>{r.by}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{r.size}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="secondary-btn" style={{ padding: '4px 10px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Download size={12} /> Download PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
        {[
          { label: 'Payment Processing', sub: 'Process payments', Icon: CreditCard },
          { label: 'Financial Reports', sub: 'Generate reports', Icon: TrendingUp },
          { label: 'Tax Documents', sub: 'View tax filings', Icon: DollarSign },
        ].map(({ label, sub: s, Icon }) => (
          <div key={label} style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, boxShadow: 'var(--shadow-sm)', display: 'flex', gap: 16, alignItems: 'center', cursor: 'pointer' }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
              <Icon size={20} />
            </div>
            <div>
              <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{label}</strong>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>{s}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Invoice Modal */}
      {showInvoiceModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Create New Invoice</h3>
              <button className="close-btn" onClick={() => setShowInvoiceModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={submitInvoice}>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="form-group">
                  <label>Invoice Title / Reference</label>
                  <input type="text" className="form-input" required placeholder="e.g. Subcontractor Payment - Framing Q2" value={invForm.title} onChange={e => setInvForm(p => ({ ...p, title: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Transaction Type</label>
                  <select className="form-select" value={invForm.type} onChange={e => setInvForm(p => ({ ...p, type: e.target.value }))}>
                    <option value="inflow">Inflow (Income/Revenue)</option>
                    <option value="outflow">Outflow (Expense/Payment)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Total Cost ($)</label>
                  <input type="number" className="form-input" required min="1" placeholder="e.g. 45000" value={invForm.cost} onChange={e => setInvForm(p => ({ ...p, cost: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Transaction Date</label>
                  <input type="date" className="form-input" required value={invForm.date} onChange={e => setInvForm(p => ({ ...p, date: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setShowInvoiceModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Save Invoice</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Budget Adjustment Modal */}
      {showBudgetModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Adjust Capital Allocation</h3>
              <button className="close-btn" onClick={() => setShowBudgetModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={submitBudget}>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="form-group">
                  <label>Target Department</label>
                  <select className="form-select" value={budgetForm.dept} onChange={e => setBudgetForm(p => ({ ...p, dept: e.target.value }))}>
                    {budgets.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Adjustment Type</label>
                  <select className="form-select" value={budgetForm.action} onChange={e => setBudgetForm(p => ({ ...p, action: e.target.value }))}>
                    <option value="increase">Increase Allocation (+)</option>
                    <option value="decrease">Decrease Allocation (-)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Adjustment Amount ($)</label>
                  <input type="number" className="form-input" required min="1000" step="1000" placeholder="e.g. 50000" value={budgetForm.amt} onChange={e => setBudgetForm(p => ({ ...p, amt: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setShowBudgetModal(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Process Adjustment</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
