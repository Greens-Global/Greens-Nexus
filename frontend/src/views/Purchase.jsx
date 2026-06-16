import { useState, useEffect } from 'react';
import { Send, FileText, ClipboardList, User, Users, Link2, Package, Plus } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { useRequisitions }  from '../contexts/RequisitionContext';
import { cleanName } from '../lib/utils';
import { api } from '../api';

const ITEMS = ['Laptop','PC','Monitors','Speakers','Headset','Mouse','Keyboard','Battery Backup','Webcam','Safety Vest','Safety Helmet','Hand Tools','Power Tools','Nametag','Uniforms','Keys & Key Sets','Tablet','Phone'];
const OTHER_ITEM = '__other__';
const DEPTS = ['Operations','Accounting','IT Support','Real Estate','Marketing','Admin','Construction'];

const STATUS_LABEL = {
  pending_manager:   'Pending Approval',
  rejected:          'Rejected',
  manager_approved:  'Approved',
  ordered:           'Ordered',
  fulfilled:         'Fulfilled',
  asset_allocated:   'Asset Allocated',
  return_initiated:  'Return Initiated',
  returned:          'Returned & Closed',
  asset_lost:        'Asset Lost',
};
const STATUS_CLASS = {
  pending_manager:   'status-pending',
  rejected:          'status-rejected',
  manager_approved:  'status-approved',
  ordered:           'status-approved',
  fulfilled:         'status-approved',
  asset_allocated:   'status-approved',
  return_initiated:  'status-pending',
  returned:          'status-approved',
  asset_lost:        'status-rejected',
};

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

export default function Purchase({ activeSub = null }) {
  const { requisitions, submitRequisition, exportToCsv } = useRequisitions();
  const { accounts } = useMsal();
  const myName = cleanName(accounts[0]?.name ?? '');

  const [tab,          setTab]          = useState(activeSub === 'log' ? 'log' : 'new');     // 'new' | 'log'
  // Deep-link: global search / notifications land on a specific tab. The prop
  // covers fresh mounts, the window event covers repeat navigations.
  useEffect(() => {
    if (activeSub === 'log' || activeSub === 'new') setTab(activeSub);
  }, [activeSub]);
  useEffect(() => {
    const h = e => {
      const { view, sub } = e.detail || {};
      if (view === 'purchase' && (sub === 'log' || sub === 'new')) setTab(sub);
    };
    window.addEventListener('nexus:navigate', h);
    return () => window.removeEventListener('nexus:navigate', h);
  }, []);
  const [forSelf,      setForSelf]      = useState(true);
  const [behalfName,   setBehalfName]   = useState('');
  const [item,         setItem]         = useState('');
  const [customItem,   setCustomItem]   = useState('');
  const [qty,          setQty]          = useState(1);
  const [dept,         setDept]         = useState('Operations');
  const [reason,       setReason]       = useState('');
  const [refLink,      setRefLink]      = useState('');
  const [flash,        setFlash]        = useState(false);
  const [directory,    setDirectory]    = useState([]);   // company people picker for on-behalf
  const [approvers,    setApprovers]    = useState([]);   // manager list — only the picked one is notified
  const [approverEmail, setApproverEmail] = useState('');

  useEffect(() => {
    api.getRolesDirectory().then(setDirectory).catch(() => {});
    api.getItemApprovers().then(rows => {
      setApprovers(rows);
      const remembered = localStorage.getItem('nexus-approver-email');
      if (remembered && rows.some(a => a.email === remembered)) setApproverEmail(remembered);
    }).catch(() => {});
  }, []);

  const isOther       = item === OTHER_ITEM;
  const resolvedItem  = isOther ? customItem.trim() : item;
  const employeeName  = forSelf ? myName : behalfName.trim();
  // Match the typed name against the directory so the requisition lands in
  // THEIR log (employee_email), not the submitter's
  const behalfMatch   = !forSelf
    ? directory.find(d => d.name.toLowerCase() === behalfName.trim().toLowerCase())
    : null;
  const approver      = approvers.find(a => a.email === approverEmail) || null;
  const canSubmit     = resolvedItem && employeeName && reason.trim() && approver && (forSelf || behalfMatch);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    // Reference link travels inside the reason so no backend change is needed
    const fullReason = refLink.trim() ? `${reason.trim()}\nReference: ${refLink.trim()}` : reason.trim();
    // Notification is created by the BACKEND (targeted at the picked manager) —
    // employees can't write to the notifications API, so a client-side
    // addNotification here silently 403'd and nobody ever got notified.
    submitRequisition({
      employeeName, employeeDept: dept, item: resolvedItem, quantity: qty, reason: fullReason,
      employeeEmail: forSelf ? '' : behalfMatch?.email || '',
      approverEmail: approver.email,
    });
    localStorage.setItem('nexus-approver-email', approver.email);
    setItem(''); setCustomItem(''); setQty(1); setDept('Operations'); setReason(''); setRefLink('');
    setForSelf(true); setBehalfName('');
    setFlash(true);
    setTimeout(() => setFlash(false), 3500);
    setTab('log');
  };

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <div className="purchase-view">
      <div className="view-header">
        <div className="view-title-group">
          <h2>Purchase Requisition</h2>
          <p>Ask for anything the company needs to buy — equipment, materials, software, or something new</p>
        </div>
        {tab === 'log' && requisitions.length > 0 && (
          <button className="secondary-btn" onClick={exportToCsv} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FileText size={15} /> Export to CSV
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="scroll-tabs" style={{ display:'flex', gap:0, margin:'8px 0 24px', borderBottom:'1px solid var(--line)' }}>
        {[
          { id:'new', label:'New Request',     Icon: Send          },
          { id:'log', label:'Requisition Log', Icon: ClipboardList, badge: requisitions.length || null },
        ].map(({ id, label, Icon, badge }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'10px 18px', background:'none', border:'none',
              borderBottom: tab === id ? '2px solid var(--pine)' : '2px solid transparent',
              color: tab === id ? 'var(--ink)' : 'var(--muted)', fontWeight: tab === id ? 700 : 600,
              fontSize:13.5, cursor:'pointer', fontFamily:'Inter,sans-serif', marginBottom:-1, whiteSpace:'nowrap', flexShrink:0 }}>
            <Icon size={14} /> {label}
            {badge > 0 && <span style={{ background:'var(--mist)', color:'var(--muted)', borderRadius:20, fontSize:10.5, fontWeight:800, padding:'1px 7px', marginLeft:2 }}>{badge}</span>}
          </button>
        ))}
      </div>

      {flash && (
        <div style={{ background: 'hsla(142,60%,45%,0.12)', border: '1px solid hsla(142,60%,45%,0.35)', borderRadius: 10, padding: '12px 16px', marginBottom: 18, fontSize: '0.88rem', color: 'hsl(142,60%,38%)', fontWeight: 600 }}>
          ✓ Requisition submitted — it is now pending manager approval.
        </div>
      )}

      {/* ── New Request (full-width form) ── */}
      {tab === 'new' && (
        <form onSubmit={handleSubmit}
          style={{ background:'var(--card)', border:'1px solid var(--line)', borderRadius:14, padding:'26px 28px', boxShadow:'var(--shadow-sm)', maxWidth:880 }}>

          {/* Who is this for */}
          <div style={{ marginBottom:20 }}>
            <label style={FL}>WHO IS THIS REQUEST FOR?</label>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <button type="button" onClick={() => setForSelf(true)}
                style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'8px 16px', borderRadius:10,
                  border:`1px solid ${forSelf ? 'var(--pine)' : 'var(--line)'}`,
                  background: forSelf ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
                  color: forSelf ? 'hsl(var(--color-green))' : 'var(--muted)',
                  fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                <User size={14} /> Myself{myName ? ` — ${myName}` : ''}
              </button>
              <button type="button" onClick={() => setForSelf(false)}
                style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'8px 16px', borderRadius:10,
                  border:`1px solid ${!forSelf ? 'var(--pine)' : 'var(--line)'}`,
                  background: !forSelf ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
                  color: !forSelf ? 'hsl(var(--color-green))' : 'var(--muted)',
                  fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                <Users size={14} /> Someone else
              </button>
            </div>
            {!forSelf && (
              <>
                <input className="form-input" style={{ width:'100%', maxWidth:380, marginTop:10 }}
                  placeholder="Start typing their name…" list="behalf-people"
                  value={behalfName} onChange={e => setBehalfName(e.target.value)} autoFocus />
                <datalist id="behalf-people">
                  {directory.map(d => <option key={d.email} value={d.name} />)}
                </datalist>
                {behalfName.trim() && !behalfMatch && (
                  <p style={{ fontSize:11.5, color:'hsl(var(--color-orange))', margin:'6px 0 0' }}>
                    Pick a name from the list so the request shows in their log.
                  </p>
                )}
                {behalfMatch && (
                  <p style={{ fontSize:11.5, color:'hsl(var(--color-green))', margin:'6px 0 0' }}>
                    ✓ Will appear in {behalfMatch.name}'s requisition log ({behalfMatch.email})
                  </p>
                )}
              </>
            )}
          </div>

          {/* Item + qty + dept */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))', gap:16, marginBottom:20 }}>
            <div>
              <label style={FL}>WHAT DO YOU NEED? <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
              <select className="form-select" style={{ width:'100%' }} required value={item} onChange={e => setItem(e.target.value)}>
                <option value="" disabled>Select an item…</option>
                {ITEMS.map(i => <option key={i}>{i}</option>)}
                <option value={OTHER_ITEM}>Something else (type it in)…</option>
              </select>
              {isOther && (
                <input className="form-input" style={{ width:'100%', marginTop:8 }} autoFocus
                  placeholder="Describe the item — e.g. Dell UltraSharp 32&quot; monitor"
                  value={customItem} onChange={e => setCustomItem(e.target.value)} />
              )}
            </div>
            <div>
              <label style={FL}>QUANTITY <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
              <input type="number" className="form-input" style={{ width:'100%' }} min="1" required
                value={qty} onChange={e => setQty(e.target.value)} />
            </div>
            <div>
              <label style={FL}>DEPARTMENT</label>
              <select className="form-select" style={{ width:'100%' }} value={dept} onChange={e => setDept(e.target.value)}>
                {DEPTS.map(d => <option key={d}>{d}</option>)}
              </select>
            </div>
          </div>

          {/* Reason */}
          <div style={{ marginBottom:20 }}>
            <label style={FL}>REASON / JUSTIFICATION <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            <textarea className="form-input" rows={4} required
              placeholder="Give the approver enough detail to say yes — what is it for, why now, any specs that matter…"
              value={reason} onChange={e => setReason(e.target.value)}
              style={{ width:'100%', resize:'vertical', lineHeight:1.5 }} />
          </div>

          {/* Who should approve — only the picked manager is notified */}
          <div style={{ marginBottom:20 }}>
            <label style={FL}>WHO SHOULD APPROVE THIS? <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
            <select className="form-select" style={{ width:'100%', maxWidth:380 }} required
              value={approverEmail} onChange={e => setApproverEmail(e.target.value)}>
              <option value="">— select a manager —</option>
              {approvers.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
            </select>
            <p style={{ fontSize:11.5, color:'var(--muted)', margin:'6px 0 0' }}>
              Only this manager will be notified of your request.
            </p>
          </div>

          {/* Reference link */}
          <div style={{ marginBottom:24 }}>
            <label style={FL}><Link2 size={11} style={{ display:'inline', verticalAlign:'-1px', marginRight:4 }} />REFERENCE LINK <span style={{ fontSize:11, fontWeight:400 }}>(optional — product page, quote, or spec sheet)</span></label>
            <input type="url" className="form-input" style={{ width:'100%' }}
              placeholder="https://…" value={refLink} onChange={e => setRefLink(e.target.value)} />
          </div>

          <button type="submit" className="primary-btn" disabled={!canSubmit}
            style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'10px 26px', fontSize:14, opacity: canSubmit ? 1 : 0.5 }}>
            <Send size={14} /> Submit Requisition
          </button>
        </form>
      )}

      {/* ── Requisition Log ── */}
      {tab === 'log' && (
        <div className="requisitions-list-card" style={{ maxWidth:'none' }}>
          <div className="req-table-wrapper">
            <table className="req-table stack-table">
              <thead>
                <tr>
                  <th>Req ID</th>
                  <th>Item / Department</th>
                  <th>Requested For</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {requisitions.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '36px 0', fontSize: '0.9rem' }}>
                      <Package size={26} style={{ opacity:.25, display:'block', margin:'0 auto 8px' }} />
                      No requisitions yet — submit one from the New Request tab.
                    </td>
                  </tr>
                )}
                {requisitions.map(req => (
                  <tr key={req.id}>
                    <td data-th="Req ID" style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{req.id}</td>
                    <td>
                      <div className="req-item-name">{req.item}</div>
                      <div className="req-item-dept">{req.employeeDept} · Qty: {req.quantity}</div>
                    </td>
                    <td data-th="Requested for" style={{ fontSize: '0.88rem' }}>{req.employeeName}</td>
                    <td data-th="Status">
                      <span className={`status-badge ${STATUS_CLASS[req.status] || 'status-badge'}`}>
                        {STATUS_LABEL[req.status] || req.status}
                      </span>
                    </td>
                    <td data-th="Details" style={{ textAlign: 'right', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {req.status === 'rejected' && (
                        <span style={{ color: 'hsl(var(--color-red))' }} title={req.rejectionReason}>
                          ⚠ {req.rejectionReason ? req.rejectionReason.substring(0, 28) + (req.rejectionReason.length > 28 ? '…' : '') : 'Rejected'}
                        </span>
                      )}
                      {req.status === 'asset_allocated' && (
                        <span style={{ color: 'hsl(var(--color-green))' }}>✓ {req.assetName}</span>
                      )}
                      {req.status === 'manager_approved' && (
                        <span style={{ color: 'hsl(var(--color-green))' }}>
                          {req.allocatorName ? `${req.allocatorName} is purchasing it` : 'Being processed'}
                        </span>
                      )}
                      {req.status === 'ordered' && (
                        <span style={{ color: 'hsl(var(--color-blue))' }}>
                          Ordered{req.allocatorName ? ` by ${req.allocatorName}` : ''}
                        </span>
                      )}
                      {req.status === 'fulfilled' && (
                        <span style={{ color: 'hsl(var(--color-green))' }} title={req.fulfillmentNote || ''}>
                          ✓ Ready — see {req.allocatorName || 'your fulfiller'}
                        </span>
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
      )}

      {/* Phone: floating + jumps to the request form from anywhere in the log */}
      {tab === 'log' && (
        <button className="fab" onClick={() => setTab('new')} aria-label="New purchase request">
          <Plus size={24} />
        </button>
      )}
    </div>
  );
}
