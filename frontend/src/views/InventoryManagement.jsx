import { useState, useRef, useEffect } from 'react';
import {
  Package, Plus, Search, CheckCircle, Clock, XCircle,
  RotateCcw, Camera, Monitor, Wrench, Building2, Calculator,
  AlertCircle, Filter,
} from 'lucide-react';
import { useInventory }       from '../contexts/InventoryContext';
import { useNotifications }   from '../contexts/NotificationContext';
import { useRole }            from '../contexts/RoleContext';
import { useMsal } from '@azure/msal-react';

// ── Config ────────────────────────────────────────────────────────────────────
const DEPARTMENTS = ['All', 'IT', 'Construction', 'Operations', 'Accounting'];

const DEPT_META = {
  IT:           { icon: Monitor,    color: 'var(--color-blue)',   bg: 'hsla(var(--color-blue),0.10)'   },
  Construction: { icon: Wrench,     color: 'var(--color-orange)', bg: 'hsla(var(--color-orange),0.10)' },
  Operations:   { icon: Building2,  color: 'var(--color-green)',  bg: 'hsla(var(--color-green),0.10)'  },
  Accounting:   { icon: Calculator, color: 'var(--color-purple)', bg: 'hsla(var(--color-purple),0.10)' },
};

const CATEGORIES = ['All', 'Tools', 'IT Supplies', 'Office Supplies', 'Furniture', 'Safety Equipment', 'Electrical'];

const CAT_COLORS = {
  'Tools':            { bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  'IT Supplies':      { bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))' },
  'Office Supplies':  { bg: 'hsla(var(--color-purple),0.12)', fg: 'hsl(var(--color-purple))' },
  'Furniture':        { bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))' },
  'Safety Equipment': { bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))' },
  'Electrical':       { bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
};

const STATUS_META = {
  pending:   { label: 'Pending',         bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))', Icon: Clock },
  approved:  { label: 'To Be Allocated', bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: Package },
  allocated: { label: 'In Use',          bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))',  Icon: CheckCircle },
  rejected:  { label: 'Rejected',        bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
  returned:  { label: 'Returned',        bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: RotateCcw },
};

// ── Raise Request Modal ───────────────────────────────────────────────────────
function RaiseRequestModal({ items, onClose, onSubmit, currentUser, canRaiseOnBehalf }) {
  const [itemSearch,  setItemSearch]  = useState('');
  const [selected,    setSelected]    = useState(null);
  const [qty,         setQty]         = useState(1);
  const [days,        setDays]        = useState(1);
  const [reason,      setReason]      = useState('');
  const [showList,    setShowList]    = useState(false);
  const [requestFor,  setRequestFor]  = useState(''); // optional: on behalf of

  const filtered = items.filter(i =>
    i.available > 0 && i.name.toLowerCase().includes(itemSearch.toLowerCase())
  );

  function selectItem(item) {
    setSelected(item); setItemSearch(item.name); setShowList(false); setQty(1);
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:460, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:'16px', fontWeight:700, marginBottom:4 }}>Raise Inventory Request</h3>
        <p style={{ fontSize:'13px', color:'var(--muted)', marginBottom:24 }}>Search for an item and submit a request.</p>

        <div style={{ marginBottom:14, position:'relative' }}>
          <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>ITEM</label>
          <div style={{ position:'relative' }}>
            <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--muted)', pointerEvents:'none' }} />
            <input className="form-input" style={{ width:'100%', paddingLeft:32 }}
              placeholder="Search available items…" value={itemSearch} autoFocus
              onChange={e => { setItemSearch(e.target.value); setSelected(null); setShowList(true); }}
              onFocus={() => setShowList(true)} />
          </div>
          {showList && itemSearch && filtered.length > 0 && (
            <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'var(--card)', border:'1px solid var(--line)', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.15)', zIndex:10, maxHeight:200, overflowY:'auto', marginTop:4 }}>
              {filtered.map(item => {
                const dm = DEPT_META[item.department];
                return (
                  <div key={item.id} onClick={() => selectItem(item)}
                    style={{ padding:'10px 14px', cursor:'pointer', display:'flex', justifyContent:'space-between', alignItems:'center', gap:10 }}
                    onMouseEnter={e => e.currentTarget.style.background='var(--mist)'}
                    onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                    <div>
                      <div style={{ fontWeight:600, fontSize:'13px' }}>{item.name}</div>
                      <div style={{ fontSize:'11px', color: dm ? `hsl(${dm.color})` : 'var(--muted)' }}>{item.department}</div>
                    </div>
                    <span style={{ fontSize:'11px', color:'hsl(var(--color-green))', fontWeight:600, flexShrink:0 }}>{item.available} avail.</span>
                  </div>
                );
              })}
            </div>
          )}
          {showList && itemSearch && filtered.length === 0 && (
            <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'var(--card)', border:'1px solid var(--line)', borderRadius:8, padding:'12px 14px', fontSize:'13px', color:'var(--muted)', zIndex:10, marginTop:4 }}>
              No available items match "{itemSearch}"
            </div>
          )}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:14 }}>
          <div>
            <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>QUANTITY</label>
            <input type="number" min={1} max={selected?.available ?? 1} value={qty} className="form-input" style={{ width:'100%' }}
              onChange={e => setQty(Math.max(1, Math.min(selected?.available ?? 1, Number(e.target.value))))} disabled={!selected} />
          </div>
          <div>
            <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>DAYS NEEDED</label>
            <input type="number" min={1} value={days} className="form-input" style={{ width:'100%' }}
              onChange={e => setDays(Math.max(1, Number(e.target.value)))} disabled={!selected} />
          </div>
        </div>

        {/* Request on behalf — supervisors and above only */}
        {canRaiseOnBehalf && (
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>
              REQUESTING FOR <span style={{ fontWeight:400, textTransform:'none' }}>(optional — leave blank if for yourself)</span>
            </label>
            <input className="form-input" style={{ width:'100%' }}
              placeholder={`e.g. Sarah Johnson  (you are: ${currentUser})`}
              value={requestFor}
              onChange={e => setRequestFor(e.target.value)} />
          </div>
        )}

        <div style={{ marginBottom:24 }}>
          <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>REASON FOR REQUEST</label>
          <textarea rows={3} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:'13px' }}
            placeholder="Briefly explain why you need this item…" value={reason}
            onChange={e => setReason(e.target.value)} disabled={!selected} />
        </div>

        {requestFor.trim() && (
          <div style={{ marginBottom:14, padding:'8px 12px', borderRadius:8, background:'hsla(var(--color-blue),0.08)', border:'1px solid hsla(var(--color-blue),0.2)', fontSize:12, color:'hsl(var(--color-blue))' }}>
            This request will be raised by <strong>{currentUser}</strong> on behalf of <strong>{requestFor.trim()}</strong>
          </div>
        )}

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={!selected || !reason.trim()}
            onClick={() => { if (selected && reason.trim()) onSubmit({ item: selected, qty, days, reason: reason.trim(), requestFor: requestFor.trim() || null }); }}>
            Submit Request
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Return Modal ──────────────────────────────────────────────────────────────
function ReturnModal({ request, onClose, onSubmit }) {
  const [photo,         setPhoto]         = useState(null);
  const [conditionNote, setConditionNote] = useState('');
  const fileRef = useRef(null);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto({ url: URL.createObjectURL(file), name: file.name });
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--card)', borderRadius:14, padding:28, width:'100%', maxWidth:440, boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize:'16px', fontWeight:700, marginBottom:4 }}>Return Item</h3>
        <p style={{ fontSize:'13px', color:'var(--muted)', marginBottom:24 }}>
          <strong>{request.itemName}</strong> — {request.quantity} unit{request.quantity > 1 ? 's' : ''}
        </p>

        <div style={{ marginBottom:18 }}>
          <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:8, letterSpacing:'.04em' }}>PHOTO OF ITEM</label>
          {photo ? (
            <div style={{ position:'relative', borderRadius:10, overflow:'hidden', border:'1px solid var(--line)' }}>
              <img src={photo.url} alt="Return" style={{ width:'100%', maxHeight:200, objectFit:'cover', display:'block' }} />
              <button onClick={() => { setPhoto(null); fileRef.current.value=''; }}
                style={{ position:'absolute', top:8, right:8, background:'rgba(0,0,0,0.6)', border:'none', borderRadius:6, padding:'4px 10px', color:'#fff', fontSize:'12px', cursor:'pointer', fontFamily:'Inter,sans-serif' }}>
                Remove
              </button>
            </div>
          ) : (
            <div onClick={() => fileRef.current.click()}
              style={{ border:'2px dashed var(--line)', borderRadius:10, padding:'28px 20px', textAlign:'center', cursor:'pointer' }}
              onMouseEnter={e => e.currentTarget.style.borderColor='var(--pine)'}
              onMouseLeave={e => e.currentTarget.style.borderColor='var(--line)'}>
              <Camera size={28} style={{ color:'var(--muted)', marginBottom:8 }} />
              <div style={{ fontSize:'13px', fontWeight:600, color:'var(--ink)' }}>Take a photo or upload</div>
              <div style={{ fontSize:'12px', color:'var(--muted)', marginTop:4 }}>On mobile, opens your camera</div>
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display:'none' }} onChange={handleFile} />
        </div>

        <div style={{ marginBottom:24 }}>
          <label style={{ fontSize:'12px', fontWeight:600, color:'var(--muted)', display:'block', marginBottom:6, letterSpacing:'.04em' }}>
            CONDITION NOTE <span style={{ fontWeight:400 }}>(optional)</span>
          </label>
          <textarea rows={2} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:'13px' }}
            placeholder="e.g. Good condition, minor scratch on handle…"
            value={conditionNote} onChange={e => setConditionNote(e.target.value)} />
        </div>

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button className="secondary-btn" onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={!photo}
            onClick={() => onSubmit({ photoUrl: photo?.url, photoName: photo?.name, conditionNote: conditionNote.trim() })}>
            Confirm Return
          </button>
        </div>
        {!photo && <p style={{ textAlign:'right', fontSize:'11px', color:'hsl(var(--color-red))', marginTop:8 }}>A photo is required to confirm return.</p>}
      </div>
    </div>
  );
}

// ── Request Stage Tracker ─────────────────────────────────────────────────────
function StageTracker({ request }) {
  const fmt = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

  // Due date counted from allocation (not creation) since that's when the clock starts
  const startDate = request.allocatedAt ?? request.createdAt;
  const dueDate   = request.days
    ? new Date(new Date(startDate).getTime() + request.days * 86400000)
    : null;
  const isOverdue = request.status === 'allocated' && dueDate && dueDate < new Date();
  const daysLeft  = dueDate ? Math.ceil((dueDate - new Date()) / 86400000) : null;
  const isRejected = request.status === 'rejected';

  // Status rank for easy comparison
  const rank = { pending: 0, approved: 1, allocated: 2, returned: 3, rejected: -1 };
  const cur  = rank[request.status] ?? 0;

  const stages = isRejected ? [
    { label: 'Submitted',    detail: fmt(request.createdAt), state: 'done'    },
    { label: 'Under Review', detail: 'Manager notified',     state: 'done'    },
    { label: 'Rejected',     detail: request.rejectReason ? `"${request.rejectReason}"` : 'Not approved', state: 'error' },
  ] : [
    {
      label: 'Submitted',
      detail: fmt(request.createdAt),
      state: 'done',
    },
    {
      label: 'Under Review',
      detail: cur > 0 ? 'Reviewed' : 'Awaiting manager',
      state: cur === 0 ? 'active' : 'done',
    },
    {
      label: 'Approved',
      detail: cur >= 1 ? `By ${request.resolvedBy ?? 'manager'}` : null,
      state: cur === 0 ? 'upcoming' : 'done',
    },
    {
      label: 'To Be Allocated',
      detail: cur >= 2 ? `By ${request.allocatedBy ?? 'supervisor'} · ${fmt(request.allocatedAt)}` : 'Waiting for supervisor',
      state: cur === 1 ? 'active' : cur >= 2 ? 'done' : 'upcoming',
    },
    {
      label: 'In Use',
      detail: cur >= 2
        ? (isOverdue
            ? `⚠ Overdue since ${fmt(dueDate?.toISOString())}`
            : daysLeft != null && daysLeft > 0
              ? `Due ${fmt(dueDate?.toISOString())} · ${daysLeft}d left`
              : daysLeft === 0 ? 'Due today' : null)
        : null,
      state: cur === 2 ? 'active' : cur >= 3 ? 'done' : 'upcoming',
      isOverdue,
    },
    {
      label: 'Returned',
      detail: request.returnedAt ? fmt(request.returnedAt) : null,
      state: cur >= 3 ? 'done' : 'upcoming',
    },
  ];

  const stateStyle = {
    done:    { bg: 'hsl(var(--color-green))',  text: '#fff', border: 'none' },
    active:  { bg: 'hsl(var(--color-blue))',   text: '#fff', border: 'none' },
    error:   { bg: 'hsl(var(--color-red))',    text: '#fff', border: 'none' },
    upcoming:{ bg: 'var(--card)',              text: 'var(--muted)', border: '2px solid var(--line)' },
  };
  const lineColor = s => s === 'done' ? 'hsl(var(--color-green))' : 'var(--line)';
  const icon = s => s === 'done' ? '✓' : s === 'error' ? '✕' : s === 'active' ? '●' : '';

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 16, overflowX: 'auto', paddingBottom: 4 }}>
      {stages.map((stage, i) => {
        const ss = stateStyle[stage.state];
        return (
          <div key={stage.label} style={{ display: 'flex', alignItems: 'flex-start', flex: i < stages.length - 1 ? '1 1 0' : 'none' }}>
            {/* Stage node */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 68 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: ss.bg, color: ss.text, border: ss.border,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700, flexShrink: 0,
                boxShadow: stage.state === 'active' ? `0 0 0 4px hsla(var(--color-blue),0.15)` : 'none',
              }}>
                {icon(stage.state)}
              </div>
              <div style={{ fontSize: 10.5, fontWeight: 600, marginTop: 5, textAlign: 'center', whiteSpace: 'nowrap', color: stage.state === 'upcoming' ? 'var(--muted)' : 'var(--ink)' }}>
                {stage.label}
              </div>
              {stage.detail && (
                <div style={{ fontSize: 10, color: stage.isOverdue ? 'hsl(var(--color-red))' : 'var(--muted)', textAlign: 'center', marginTop: 2, lineHeight: 1.3, maxWidth: 80 }}>
                  {stage.detail}
                </div>
              )}
            </div>
            {/* Connector line */}
            {i < stages.length - 1 && (
              <div style={{ flex: 1, height: 2, marginTop: 13, background: lineColor(stage.state), minWidth: 16, transition: 'background 0.3s' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main View ─────────────────────────────────────────────────────────────────
export default function InventoryManagement({ activeSub, onSubChange }) {
  const { items, requests, raiseRequest, returnItem } = useInventory();
  const { addNotification } = useNotifications();
  const { can }             = useRole();
  const { accounts }        = useMsal();
  const userName            = accounts[0]?.name ?? 'Employee';

  const [search,       setSearch]       = useState('');
  const [catFilter,    setCatFilter]    = useState('All');
  const [deptTab,      setDeptTab]      = useState('All');
  const [tab,          setTab]          = useState(activeSub === 'my-requests' ? 'my-requests' : 'inventory');
  const [showModal,    setShowModal]    = useState(false);
  const [returningReq, setReturningReq] = useState(null);

  useEffect(() => {
    if (activeSub === 'my-requests') setTab('my-requests');
  }, [activeSub]);

  const myReqs = requests.filter(r => r.requestedBy === userName);

  const filtered = items.filter(item => {
    const matchSearch = item.name.toLowerCase().includes(search.toLowerCase());
    const matchCat    = catFilter === 'All' || item.category   === catFilter;
    const matchDept   = deptTab   === 'All' || item.department === deptTab;
    return matchSearch && matchCat && matchDept;
  });

  // Dept summary stats
  const deptStats = DEPARTMENTS.filter(d => d !== 'All').map(dept => {
    const deptItems = items.filter(i => i.department === dept);
    const available = deptItems.reduce((s, i) => s + i.available, 0);
    const total     = deptItems.reduce((s, i) => s + i.total, 0);
    const outOfStock = deptItems.filter(i => i.available === 0).length;
    return { dept, total: deptItems.length, available, totalUnits: total, outOfStock };
  });

  const totalItems     = items.length;
  const totalAvailable = items.reduce((s, i) => s + i.available, 0);
  const totalCheckedOut = items.reduce((s, i) => s + (i.total - i.available), 0);
  const pendingReqs    = requests.filter(r => r.status === 'pending').length;

  function handleSubmit({ item, qty, days, reason, requestFor }) {
    const forPerson = requestFor || userName;
    const req = raiseRequest({
      itemId: item.id, itemName: item.name,
      requestedBy: forPerson,
      raisedBy: userName,
      department: item.department,
      quantity: qty, days, reason,
    });
    const byLine = requestFor ? `${userName} on behalf of ${requestFor}` : userName;
    addNotification({
      type:        'inv_request',
      refId:       req.id,
      title:       'New Inventory Request',
      body:        `${byLine} requested ${qty}× ${item.name} for ${days} day${days > 1 ? 's' : ''} — "${reason}"`,
      requestedBy: forPerson,   // who the item is for (used to target approval notification)
      itemName:    item.name,
      qty,
      days,
    });
    setShowModal(false);
  }

  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>

      {/* ── Header ── */}
      <div className="view-header">
        <div className="view-title-group">
          <h2>Inventory Management</h2>
          <p>Company assets and supplies across all departments</p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={() => setTab(t => t === 'my-requests' ? 'inventory' : 'my-requests')}
            className={tab === 'my-requests' ? 'primary-btn' : 'secondary-btn'}
            style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
            <Clock size={15} /> My Requests {myReqs.length > 0 && `(${myReqs.length})`}
          </button>
          <button onClick={() => setShowModal(true)} className="primary-btn"
            style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
            <Plus size={15} /> Raise Request
          </button>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom:24 }}>
        {[
          { label: 'Total Items',   value: totalItems,      sub: 'across all depts',       color: 'card-blue'   },
          { label: 'Available',     value: totalAvailable,  sub: 'units ready to request', color: 'card-green'  },
          { label: 'Checked Out',   value: totalCheckedOut, sub: 'units currently in use', color: 'card-orange' },
          { label: 'Pending Reqs',  value: pendingReqs,     sub: 'awaiting approval',      color: pendingReqs > 0 ? 'card-red' : '' },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className={`kpi-card ${color}`}>
            <div className="kpi-label">{label}</div>
            <div className="kpi-value">{value}</div>
            <div className="kpi-delta">{sub}</div>
          </div>
        ))}
      </div>

      {/* ── My Requests tab ── */}
      {tab === 'my-requests' && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
            <div>
              <h3 style={{ fontSize:15, fontWeight:700, margin:0 }}>My Requests</h3>
              <p style={{ fontSize:13, color:'var(--muted)', marginTop:3 }}>{myReqs.length} request{myReqs.length !== 1 ? 's' : ''} raised</p>
            </div>
          </div>

          {myReqs.length === 0 ? (
            <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)', fontSize:'14px' }}>
              <Package size={32} style={{ opacity:.2, marginBottom:10, display:'block', margin:'0 auto 10px' }} />
              You haven't raised any requests yet.
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              {myReqs.map(r => {
                const s   = STATUS_META[r.status];
                const dm  = DEPT_META[r.department];
                return (
                  <div key={r.id} style={{ background:'var(--card)', border:'1px solid var(--line)', borderRadius:14, padding:'18px 20px', boxShadow:'var(--shadow-sm)' }}>

                    {/* Top row */}
                    <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, flexWrap:'wrap', marginBottom:10 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:38, height:38, borderRadius:10, background: dm ? `hsl(${dm.color})` + '22' : 'var(--mist)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                          <Package size={18} color={dm ? `hsl(${dm.color})` : 'var(--muted)'} />
                        </div>
                        <div>
                          <div style={{ fontWeight:700, fontSize:'14.5px' }}>{r.itemName}</div>
                          <div style={{ fontSize:'12px', color:'var(--muted)', marginTop:2 }}>
                            {r.department} · ×{r.quantity} · {r.days} day{r.days > 1 ? 's' : ''}
                            {r.raisedBy && r.raisedBy !== r.requestedBy && (
                              <span style={{ marginLeft:6, color:'hsl(var(--color-blue))', fontWeight:500 }}>via {r.raisedBy}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
                        <span style={{ fontFamily:'monospace', fontSize:'11px', color:'var(--muted)', background:'var(--mist)', padding:'2px 7px', borderRadius:5 }}>{r.id}</span>
                        <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'3px 10px', borderRadius:20, fontSize:'11px', fontWeight:700, background:s.bg, color:s.fg }}>
                          <s.Icon size={11} /> {s.label}
                        </span>
                      </div>
                    </div>

                    {/* Reason */}
                    {r.reason && (
                      <div style={{ fontSize:'12.5px', color:'var(--muted)', background:'var(--mist)', borderRadius:8, padding:'7px 12px', marginBottom:4, borderLeft:`3px solid ${dm ? `hsl(${dm.color})` : 'var(--line)'}` }}>
                        "{r.reason}"
                      </div>
                    )}

                    {/* Stage tracker */}
                    <StageTracker request={r} />

                    {/* Actions */}
                    <div style={{ marginTop:14, display:'flex', gap:8, justifyContent:'flex-end', flexWrap:'wrap' }}>
                      {r.status === 'rejected' && r.rejectReason && (
                        <div style={{ flex:1, fontSize:'12px', color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.07)', padding:'5px 10px', borderRadius:7 }}>
                          Rejection reason: {r.rejectReason}
                        </div>
                      )}
                      {r.status === 'returned' && r.returnPhotoUrl && (
                        <div style={{ display:'flex', alignItems:'center', gap:10, flex:1 }}>
                          <img src={r.returnPhotoUrl} alt="Return" style={{ width:44, height:44, objectFit:'cover', borderRadius:7, border:'1px solid var(--line)', flexShrink:0 }} />
                          {r.conditionNote && <span style={{ fontSize:'12px', color:'var(--muted)' }}>{r.conditionNote}</span>}
                        </div>
                      )}
                      {r.status === 'allocated' && (
                        <button onClick={() => setReturningReq(r)} className="secondary-btn"
                          style={{ padding:'6px 14px', fontSize:'12.5px', display:'inline-flex', alignItems:'center', gap:5 }}>
                          <RotateCcw size={13} /> Return Item
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Department tab strip ── */}
      <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
        {DEPARTMENTS.map(dept => {
          const dm  = DEPT_META[dept];
          const active = deptTab === dept;
          return (
            <button key={dept}
              onClick={() => setDeptTab(dept)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '7px 16px', borderRadius: 20, border: 'none',
                fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: '13px',
                cursor: 'pointer', transition: 'all 0.15s',
                background: active
                  ? (dm ? `hsl(${dm.color})` : 'var(--pine)')
                  : 'var(--mist)',
                color: active ? '#fff' : 'var(--muted)',
                boxShadow: active ? `0 2px 10px hsla(${dm?.color ?? '0,0%,0%'},0.3)` : 'none',
              }}>
              {dm && <dm.icon size={13} />}
              {dept}
              {dept !== 'All' && (() => {
                const ds = deptStats.find(s => s.dept === dept);
                return <span style={{ opacity: active ? 0.75 : 0.5, fontSize:'11px', fontWeight:500 }}>({ds?.total})</span>;
              })()}
            </button>
          );
        })}
      </div>

      {/* ── Department summary (when a dept is selected) ── */}
      {deptTab !== 'All' && (() => {
        const ds = deptStats.find(s => s.dept === deptTab);
        const dm = DEPT_META[deptTab];
        return ds ? (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
            {[
              { label:'Items',         value: ds.total },
              { label:'Available',     value: ds.available },
              { label:'Total Units',   value: ds.totalUnits },
              { label:'Out of Stock',  value: ds.outOfStock },
            ].map(({ label, value }) => (
              <div key={label} style={{ background:'var(--card)', border:'1px solid var(--line)', borderRadius:12, padding:'14px 18px', boxShadow:'var(--shadow-sm)' }}>
                <div style={{ fontSize:'11px', fontWeight:700, color:'var(--muted)', textTransform:'uppercase', letterSpacing:'.04em', marginBottom:6 }}>{label}</div>
                <div style={{ fontSize:'22px', fontWeight:700, color:'var(--ink)' }}>{value}</div>
              </div>
            ))}
          </div>
        ) : null;
      })()}

      {/* ── Search + Category filter ── */}
      <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap', alignItems:'center' }}>
        <div className="search-bar" style={{ width:240 }}>
          <Search size={14} style={{ flexShrink:0 }} />
          <input placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <Filter size={13} style={{ color:'var(--muted)' }} />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="form-input"
            style={{ padding:'6px 10px', fontSize:'13px', height:34 }}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <span style={{ marginLeft:'auto', fontSize:'13px', color:'var(--muted)' }}>
          {filtered.length} item{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Item Grid ── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(230px,1fr))', gap:14 }}>
        {filtered.map(item => {
          const cat   = CAT_COLORS[item.category] ?? { bg:'var(--mist)', fg:'var(--ink)' };
          const dm    = DEPT_META[item.department];
          const avail = item.available > 0;
          const pct   = Math.round((item.available / item.total) * 100);
          return (
            <div key={item.id} className="motion-card"
              style={{ border:'1px solid var(--line)', borderRadius:12, padding:16, background:'var(--card)', display:'flex', flexDirection:'column', gap:10 }}>

              {/* Header row */}
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:36, height:36, borderRadius:9, background:cat.bg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <Package size={17} color={cat.fg} />
                  </div>
                  <div>
                    <div style={{ fontWeight:700, fontSize:'13.5px', lineHeight:1.2 }}>{item.name}</div>
                    <div style={{ fontSize:'11px', marginTop:2, color: dm ? `hsl(${dm.color})` : 'var(--muted)', fontWeight:600 }}>
                      {item.department}
                    </div>
                  </div>
                </div>
                <span style={{ padding:'3px 8px', borderRadius:20, fontSize:'10.5px', fontWeight:600, background:cat.bg, color:cat.fg, whiteSpace:'nowrap', flexShrink:0 }}>
                  {item.category}
                </span>
              </div>

              {/* Availability bar */}
              <div>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5, fontSize:'12px' }}>
                  <span style={{ fontWeight:600, color: avail ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))' }}>
                    {avail ? `${item.available} available` : 'Out of stock'}
                  </span>
                  <span style={{ color:'var(--muted)' }}>{item.total} total</span>
                </div>
                <div style={{ height:5, borderRadius:3, background:'var(--line)', overflow:'hidden' }}>
                  <div style={{
                    height:'100%', borderRadius:3,
                    width: `${pct}%`,
                    background: pct > 50 ? 'hsl(var(--color-green))' : pct > 20 ? 'hsl(var(--color-orange))' : 'hsl(var(--color-red))',
                    transition: 'width 0.4s ease',
                  }} />
                </div>
              </div>

              {/* Out of stock warning */}
              {!avail && (
                <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:'11.5px', color:'hsl(var(--color-red))', background:'hsla(var(--color-red),0.08)', padding:'5px 10px', borderRadius:7 }}>
                  <AlertCircle size={12} /> All units currently checked out
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign:'center', padding:'56px 0', color:'var(--muted)', fontSize:'14px' }}>
          No items match your filters.
        </div>
      )}

      {showModal && (
        <RaiseRequestModal items={items} currentUser={userName} canRaiseOnBehalf={can('supervisor')} onClose={() => setShowModal(false)} onSubmit={handleSubmit} />
      )}
      {returningReq && (
        <ReturnModal request={returningReq} onClose={() => setReturningReq(null)}
          onSubmit={data => { returnItem(returningReq.id, data); setReturningReq(null); }} />
      )}
    </div>
  );
}
