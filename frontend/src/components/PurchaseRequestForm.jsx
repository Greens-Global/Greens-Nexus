// The purchase request form (moved out of the old Purchase view, Neil Oct 22
// 2026: Purchase Requisition now lives in Workday > Purchase Requests). Workday
// shows it in the New Purchase Request popup; the logic is unchanged.
import { useState, useEffect } from 'react';
import { Send, User, Users, Link2 } from 'lucide-react';
import { useMsal } from '@azure/msal-react';
import { useRequisitions } from '../contexts/RequisitionContext';
import { cleanName } from '../lib/utils';
import { usePeopleDirectory, useItemApprovers } from '../lib/queries';

const ITEMS = ['Laptop','PC','Monitors','Speakers','Headset','Mouse','Keyboard','Battery Backup','Webcam','Safety Vest','Safety Helmet','Hand Tools','Power Tools','Nametag','Uniforms','Keys & Key Sets','Tablet','Phone'];
const OTHER_ITEM = '__other__';
const DEPTS = ['Operations','Accounting','IT Support','Real Estate','Marketing','Admin','Construction'];

const FL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6, letterSpacing: '.04em' };

/** `onSubmitted()` runs once the backend has accepted the request. */
export default function PurchaseRequestForm({ onSubmitted, onCancel }) {
  const { submitRequisition } = useRequisitions() || {};
  const { accounts } = useMsal();
  const myName = cleanName(accounts[0]?.name ?? '');

  const [forSelf,      setForSelf]      = useState(true);
  const [behalfName,   setBehalfName]   = useState('');
  const [item,         setItem]         = useState('');
  const [customItem,   setCustomItem]   = useState('');
  const [qty,          setQty]          = useState(1);
  const [dept,         setDept]         = useState('Operations');
  const [reason,       setReason]       = useState('');
  const [refLink,      setRefLink]      = useState('');
  const [submitError,  setSubmitError]  = useState('');   // P0-6: shown when the submit actually fails
  const [submitting,   setSubmitting]   = useState(false);
  const { data: directory = [] } = usePeopleDirectory();   // shared cache across all pickers
  const { data: approvers = [] } = useItemApprovers();     // manager list - only the picked one is notified
  const [approverEmail, setApproverEmail] = useState('');

  useEffect(() => {
    let remembered = null;
    try { remembered = localStorage.getItem('nexus-approver-email'); } catch { /* ignore */ }
    if (remembered && approvers.some(a => a.email === remembered)) setApproverEmail(remembered);
  }, [approvers]);

  const isOther       = item === OTHER_ITEM;
  const resolvedItem  = isOther ? customItem.trim() : item;
  const employeeName  = forSelf ? myName : behalfName.trim();
  // Match against the directory so the requisition lands in THEIR log
  // (employee_email), not the submitter's. The datalist inserts "Name - email",
  // so resolve on that first - this disambiguates duplicate display names by
  // email (P4). Fall back to a plain name only when it's uniquely a single
  // person, so a typed-but-not-picked unique name still works.
  const behalfQuery   = behalfName.trim().toLowerCase();
  const behalfByName  = directory.filter(d => (d.name || '').toLowerCase() === behalfQuery);
  const behalfMatch   = !forSelf && behalfQuery
    ? (directory.find(d => `${d.name} - ${d.email}`.toLowerCase() === behalfQuery)
       || (behalfByName.length === 1 ? behalfByName[0] : null))
    : null;
  const approver      = approvers.find(a => a.email === approverEmail) || null;
  const canSubmit     = resolvedItem && employeeName && reason.trim() && approver && (forSelf || behalfMatch);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    // Reference link travels inside the reason so no backend change is needed
    const fullReason = refLink.trim() ? `${reason.trim()}\nReference: ${refLink.trim()}` : reason.trim();
    // Notification is created by the BACKEND (targeted at the picked manager) -
    // employees can't write to the notifications API, so a client-side
    // addNotification here silently 403'd and nobody ever got notified.
    setSubmitting(true); setSubmitError('');
    try {
      // P0-6: await the real result. submitRequisition rejects on failure -
      // only report success once the backend has actually accepted it. On
      // failure the form (and the typed reason) is kept.
      await submitRequisition({
        employeeName, employeeDept: dept, item: resolvedItem, quantity: qty, reason: fullReason,
        employeeEmail: forSelf ? '' : behalfMatch?.email || '',
        approverEmail: approver.email,
      });
      try { localStorage.setItem('nexus-approver-email', approver.email); } catch { /* ignore */ }
      setItem(''); setCustomItem(''); setQty(1); setDept('Operations'); setReason(''); setRefLink('');
      setForSelf(true); setBehalfName('');
      onSubmitted?.();
    } catch (err) {
      setSubmitError(err?.message || 'Could not submit the request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-label="New Purchase Request" className="nx-fill">
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 18px' }}>
        Ask for anything the company needs to buy - equipment, materials, software, or something new.
      </p>

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
            <User size={14} /> Myself{myName ? ` - ${myName}` : ''}
          </button>
          <button type="button" onClick={() => setForSelf(false)}
            style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'8px 16px', borderRadius:10,
              border:`1px solid ${!forSelf ? 'var(--pine)' : 'var(--line)'}`,
              background: !forSelf ? 'hsla(var(--color-green),0.08)' : 'var(--card)',
              color: !forSelf ? 'hsl(var(--color-green))' : 'var(--muted)',
              fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
            <Users size={14} /> Someone Else
          </button>
        </div>
        {!forSelf && (
          <>
            <input className="form-input" style={{ width:'100%', maxWidth:380, marginTop:10 }}
              placeholder="Start typing their name…" list="behalf-people"
              value={behalfName} onChange={e => setBehalfName(e.target.value)} autoFocus />
            <datalist id="behalf-people">
              {/* Value carries the email so duplicate names resolve to the
                  right account when picked (P4). */}
              {directory.map(d => <option key={d.email} value={`${d.name} - ${d.email}`} />)}
            </datalist>
            {behalfName.trim() && !behalfMatch && (
              <p style={{ fontSize:11.5, color:'hsl(var(--color-orange))', margin:'6px 0 0' }}>
                Pick a name from the list so the request shows in their requests.
              </p>
            )}
            {behalfMatch && (
              <p style={{ fontSize:11.5, color:'hsl(var(--color-green))', margin:'6px 0 0' }}>
                ✓ Will appear in {behalfMatch.name}'s purchase requests ({behalfMatch.email})
              </p>
            )}
          </>
        )}
      </div>

      {/* Item + qty + dept */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:16, marginBottom:20 }}>
        <div>
          <label style={FL} htmlFor="pr-item">WHAT DO YOU NEED? <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
          <select id="pr-item" className="form-select" style={{ width:'100%' }} required value={item} onChange={e => setItem(e.target.value)}>
            <option value="" disabled>Select an item…</option>
            {ITEMS.map(i => <option key={i}>{i}</option>)}
            <option value={OTHER_ITEM}>Something else (type it in)…</option>
          </select>
          {isOther && (
            <input className="form-input" style={{ width:'100%', marginTop:8 }} autoFocus
              placeholder="Describe the item - e.g. Dell UltraSharp 32&quot; monitor"
              value={customItem} onChange={e => setCustomItem(e.target.value)} />
          )}
        </div>
        <div>
          <label style={FL} htmlFor="pr-qty">QUANTITY <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
          <input id="pr-qty" type="number" className="form-input" style={{ width:'100%' }} min="1" required
            value={qty} onChange={e => setQty(e.target.value)} />
        </div>
        <div>
          <label style={FL} htmlFor="pr-dept">DEPARTMENT</label>
          <select id="pr-dept" className="form-select" style={{ width:'100%' }} value={dept} onChange={e => setDept(e.target.value)}>
            {DEPTS.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
      </div>

      {/* Reason */}
      <div className="nx-fill" style={{ marginBottom:20 }}>
        <label style={FL} htmlFor="pr-reason">REASON / JUSTIFICATION <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
        <textarea id="pr-reason" className="form-input" rows={4} required
          placeholder="Give the approver enough detail to say yes - what is it for, why now, any specs that matter…"
          value={reason} onChange={e => setReason(e.target.value)}
          style={{ width:'100%', resize:'vertical', lineHeight:1.5 }} />
      </div>

      {/* Who should approve - only the picked manager is notified */}
      <div style={{ marginBottom:20 }}>
        <label style={FL} htmlFor="pr-approver">WHO SHOULD APPROVE THIS? <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
        <select id="pr-approver" className="form-select" style={{ width:'100%', maxWidth:380 }} required
          value={approverEmail} onChange={e => setApproverEmail(e.target.value)}>
          <option value="">- select a manager -</option>
          {approvers.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
        </select>
        <p style={{ fontSize:11.5, color:'var(--muted)', margin:'6px 0 0' }}>
          Only this manager will be notified of your request.
        </p>
      </div>

      {/* Reference link */}
      <div style={{ marginBottom:24 }}>
        <label style={FL} htmlFor="pr-ref"><Link2 size={11} style={{ display:'inline', verticalAlign:'-1px', marginRight:4 }} />REFERENCE LINK <span style={{ fontSize:11, fontWeight:400 }}>(optional - product page, quote, or spec sheet)</span></label>
        <input id="pr-ref" type="url" className="form-input" style={{ width:'100%' }}
          placeholder="https://…" value={refLink} onChange={e => setRefLink(e.target.value)} />
      </div>

      {submitError && (
        <p role="alert" style={{ color:'hsl(var(--color-red))', fontSize:'0.85rem', fontWeight:600, margin:'0 0 12px' }}>
          {submitError}
        </p>
      )}
      <div style={{ display:'flex', gap:10, justifyContent:'flex-end', flexWrap:'wrap' }}>
        {onCancel && <button type="button" className="secondary-btn" onClick={onCancel} disabled={submitting}>Cancel</button>}
        <button type="submit" className="primary-btn" disabled={!canSubmit || submitting}
          style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'10px 26px', fontSize:14, opacity: (!canSubmit || submitting) ? 0.5 : 1 }}>
          <Send size={14} /> {submitting ? 'Submitting…' : 'Submit Request'}
        </button>
      </div>
    </form>
  );
}
