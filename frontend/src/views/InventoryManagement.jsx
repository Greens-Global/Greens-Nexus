import { useState, useRef } from 'react';
import { Package, Plus, Search, Filter, CheckCircle, Clock, XCircle, RotateCcw, Camera } from 'lucide-react';
import { useInventory } from '../contexts/InventoryContext';
import { useMsal } from '@azure/msal-react';

const CATEGORIES = ['All', 'Tools', 'IT Supplies', 'Office Supplies', 'Furniture', 'Safety Equipment', 'Electrical'];
const DEPARTMENTS = ['All', 'IT', 'Construction', 'Operations', 'Development', 'Accounting', 'HR', 'Marketing'];

const CATEGORY_COLORS = {
  'Tools':            { bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
  'IT Supplies':      { bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))' },
  'Office Supplies':  { bg: 'hsla(var(--color-purple),0.12)', fg: 'hsl(var(--color-purple))' },
  'Furniture':        { bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))' },
  'Safety Equipment': { bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))' },
  'Electrical':       { bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))' },
};

function RaiseRequestModal({ items, onClose, onSubmit, userName }) {
  const [itemSearch, setItemSearch] = useState('');
  const [selected,   setSelected]   = useState(null);
  const [qty,        setQty]        = useState(1);
  const [days,       setDays]       = useState(1);
  const [reason,     setReason]     = useState('');
  const [showList,   setShowList]   = useState(false);

  const filtered = items.filter(i =>
    i.available > 0 &&
    i.name.toLowerCase().includes(itemSearch.toLowerCase())
  );

  function selectItem(item) {
    setSelected(item);
    setItemSearch(item.name);
    setShowList(false);
    setQty(1);
  }

  function handleSubmit() {
    if (!selected || !reason.trim()) return;
    onSubmit({ item: selected, qty, days, reason: reason.trim() });
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 12, padding: 28, width: '100%', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 700, marginBottom: 4 }}>Raise Inventory Request</h3>
        <p style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: 24 }}>Search for an item and submit a request to your manager.</p>

        {/* Item search */}
        <div style={{ marginBottom: 14, position: 'relative' }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>ITEM</label>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
            <input
              className="form-input"
              style={{ width: '100%', paddingLeft: 32 }}
              placeholder="Search available items…"
              value={itemSearch}
              onChange={e => { setItemSearch(e.target.value); setSelected(null); setShowList(true); }}
              onFocus={() => setShowList(true)}
              autoFocus
            />
          </div>
          {showList && itemSearch && filtered.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--card)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 10, maxHeight: 200, overflowY: 'auto', marginTop: 4 }}>
              {filtered.map(item => {
                const cat = CATEGORY_COLORS[item.category] ?? { bg: 'var(--mist)', fg: 'var(--ink)' };
                return (
                  <div
                    key={item.id}
                    onClick={() => selectItem(item)}
                    style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--mist)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '13px' }}>{item.name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--muted)' }}>{item.department}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      <span style={{ fontSize: '11px', padding: '2px 7px', borderRadius: 20, background: cat.bg, color: cat.fg, fontWeight: 600 }}>{item.category}</span>
                      <span style={{ fontSize: '11px', color: 'hsl(var(--color-green))', fontWeight: 600 }}>{item.available} avail.</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {showList && itemSearch && filtered.length === 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--card)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px 14px', fontSize: '13px', color: 'var(--muted)', zIndex: 10, marginTop: 4 }}>
              No available items match "{itemSearch}"
            </div>
          )}
        </div>

        {/* Qty + Days row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>QUANTITY</label>
            <input
              type="number" min={1} max={selected?.available ?? 1}
              value={qty}
              onChange={e => setQty(Math.max(1, Math.min(selected?.available ?? 1, Number(e.target.value))))}
              className="form-input"
              style={{ width: '100%' }}
              disabled={!selected}
            />
          </div>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>DAYS NEEDED</label>
            <input
              type="number" min={1}
              value={days}
              onChange={e => setDays(Math.max(1, Number(e.target.value)))}
              className="form-input"
              style={{ width: '100%' }}
              disabled={!selected}
            />
          </div>
        </div>

        {/* Reason */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>REASON FOR REQUEST</label>
          <textarea
            rows={3}
            className="form-input"
            style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
            placeholder="Briefly explain why you need this item…"
            value={reason}
            onChange={e => setReason(e.target.value)}
            disabled={!selected}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" style={{ padding: '7px 16px' }} onClick={onClose}>Cancel</button>
          <button
            className="primary-btn"
            style={{ padding: '7px 16px' }}
            disabled={!selected || !reason.trim()}
            onClick={handleSubmit}>
            Submit Request
          </button>
        </div>
      </div>
    </div>
  );
}

function ReturnModal({ request, onClose, onSubmit }) {
  const [photo,         setPhoto]         = useState(null); // { url, name }
  const [conditionNote, setConditionNote] = useState('');
  const fileRef = useRef(null);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPhoto({ url, name: file.name });
  }

  function handleSubmit() {
    onSubmit({
      photoUrl:      photo?.url  ?? null,
      photoName:     photo?.name ?? null,
      conditionNote: conditionNote.trim(),
    });
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--card)', borderRadius: 12, padding: 28, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 700, marginBottom: 4 }}>Return Item</h3>
        <p style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: 24 }}>
          <strong>{request.itemName}</strong> — {request.quantity} unit{request.quantity > 1 ? 's' : ''}
        </p>

        {/* Photo capture */}
        <div style={{ marginBottom: 18 }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 8 }}>PHOTO OF ITEM</label>

          {photo ? (
            <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border-color)' }}>
              <img src={photo.url} alt="Return photo" style={{ width: '100%', maxHeight: 200, objectFit: 'cover', display: 'block' }} />
              <button
                onClick={() => { setPhoto(null); fileRef.current.value = ''; }}
                style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: 6, padding: '4px 10px', color: '#fff', fontSize: '12px', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                Remove
              </button>
            </div>
          ) : (
            <div
              onClick={() => fileRef.current.click()}
              style={{ border: '2px dashed var(--border-color)', borderRadius: 10, padding: '28px 20px', textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--pine)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}>
              <Camera size={28} style={{ color: 'var(--muted)', marginBottom: 8 }} />
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>Take a photo or upload</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: 4 }}>On mobile, this opens your camera</div>
            </div>
          )}

          {/* Hidden file input — capture="environment" uses rear camera on mobile */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={handleFile}
          />
        </div>

        {/* Condition note */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>
            CONDITION NOTE <span style={{ fontWeight: 400 }}>(optional)</span>
          </label>
          <textarea
            rows={2}
            className="form-input"
            style={{ width: '100%', resize: 'vertical', fontSize: '13px' }}
            placeholder="e.g. Good condition, minor scratch on handle…"
            value={conditionNote}
            onChange={e => setConditionNote(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="secondary-btn" style={{ padding: '7px 16px' }} onClick={onClose}>Cancel</button>
          <button
            className="primary-btn"
            style={{ padding: '7px 16px' }}
            disabled={!photo}
            onClick={handleSubmit}>
            Confirm Return
          </button>
        </div>
        {!photo && (
          <p style={{ textAlign: 'right', fontSize: '11px', color: 'hsl(var(--color-red))', marginTop: 8 }}>
            A photo is required to confirm the return.
          </p>
        )}
      </div>
    </div>
  );
}

export default function InventoryManagement() {
  const { items, requests, raiseRequest, returnItem } = useInventory();
  const { accounts } = useMsal();
  const userName = accounts[0]?.name ?? 'Employee';

  const [search,     setSearch]     = useState('');
  const [catFilter,  setCatFilter]  = useState('All');
  const [deptFilter, setDeptFilter] = useState('All');
  const [showModal,    setShowModal]    = useState(false);
  const [myRequests,   setMyRequests]   = useState(false);
  const [returningReq, setReturningReq] = useState(null);

  const myReqs = requests.filter(r => r.requestedBy === userName);

  const filtered = items.filter(item => {
    const matchSearch = item.name.toLowerCase().includes(search.toLowerCase());
    const matchCat    = catFilter  === 'All' || item.category   === catFilter;
    const matchDept   = deptFilter === 'All' || item.department === deptFilter;
    return matchSearch && matchCat && matchDept;
  });

  function handleSubmit({ item, qty, days, reason }) {
    raiseRequest({
      itemId:      item.id,
      itemName:    item.name,
      requestedBy: userName,
      department:  item.department,
      quantity:    qty,
      days,
      reason,
    });
    setShowModal(false);
  }

  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const statusMeta = (s) => ({
    pending:  { label: 'Pending',  bg: 'hsla(var(--color-orange),0.12)', fg: 'hsl(var(--color-orange))', Icon: Clock },
    approved: { label: 'Approved', bg: 'hsla(var(--color-green),0.12)',  fg: 'hsl(var(--color-green))',  Icon: CheckCircle },
    rejected: { label: 'Rejected', bg: 'hsla(var(--color-red),0.12)',    fg: 'hsl(var(--color-red))',    Icon: XCircle },
    returned: { label: 'Returned', bg: 'hsla(var(--color-blue),0.12)',   fg: 'hsl(var(--color-blue))',   Icon: RotateCcw },
  }[s]);

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <div className="view-header">
        <div className="view-title-group">
          <h2>Inventory Management</h2>
          <p>Browse company assets and supplies across all departments</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => setMyRequests(v => !v)}
            className={myRequests ? 'primary-btn' : 'secondary-btn'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Clock size={16} /> My Requests {myReqs.length > 0 && `(${myReqs.length})`}
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="primary-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Plus size={16} /> Raise Request
          </button>
        </div>
      </div>

      {/* My Requests panel */}
      {myRequests && (
        <div className="requisitions-list-card" style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: 14 }}>My Inventory Requests</h3>
          {myReqs.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: '13px' }}>You haven't raised any requests yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {myReqs.map(r => {
                const s = statusMeta(r.status);
                return (
                  <div key={r.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-primary)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--muted)', background: 'var(--border-color)', padding: '2px 6px', borderRadius: 4 }}>{r.id}</span>
                      <span style={{ fontWeight: 600, flex: 1, minWidth: 120 }}>{r.itemName}</span>
                      <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>× {r.quantity} &nbsp;·&nbsp; {r.days}d</span>
                      <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>{fmtDate(r.createdAt)}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 20, fontSize: '0.78rem', fontWeight: 600, background: s.bg, color: s.fg }}>
                        <s.Icon size={12} /> {s.label}
                      </span>
                      {r.status === 'approved' && (
                        <button
                          onClick={() => setReturningReq(r)}
                          className="secondary-btn"
                          style={{ padding: '4px 12px', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <RotateCcw size={12} /> Return
                        </button>
                      )}
                    </div>
                    {r.status === 'returned' && r.returnPhotoUrl && (
                      <div style={{ padding: '0 14px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <img src={r.returnPhotoUrl} alt="Return photo" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border-color)', flexShrink: 0 }} />
                        {r.conditionNote && <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{r.conditionNote}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="search-bar" style={{ width: 240 }}>
          <Search size={14} style={{ flexShrink: 0 }} />
          <input placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Filter size={14} style={{ color: 'var(--muted)' }} />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)} className="form-input" style={{ padding: '6px 10px', fontSize: '13px', height: 34 }}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} className="form-input" style={{ padding: '6px 10px', fontSize: '13px', height: 34 }}>
          {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: '13px', color: 'var(--muted)' }}>
          {filtered.length} item{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Item Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
        {filtered.map(item => {
          const cat   = CATEGORY_COLORS[item.category] ?? { bg: 'var(--mist)', fg: 'var(--ink)' };
          const avail = item.available > 0;
          return (
            <div key={item.id} className="motion-card" style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '16px', background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: cat.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Package size={18} color={cat.fg} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14px', lineHeight: 1.2 }}>{item.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: 2 }}>{item.department}</div>
                  </div>
                </div>
                <span style={{ padding: '3px 8px', borderRadius: 20, fontSize: '11px', fontWeight: 600, background: cat.bg, color: cat.fg, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {item.category}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: avail ? 'hsl(var(--color-green))' : 'hsl(var(--color-red))', fontWeight: 600 }}>
                  {avail ? `${item.available} available` : 'Out of stock'}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{item.total} total</span>
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--muted)', fontSize: '14px' }}>
          No items match your filters.
        </div>
      )}

      {showModal && (
        <RaiseRequestModal
          items={items}
          userName={userName}
          onClose={() => setShowModal(false)}
          onSubmit={handleSubmit}
        />
      )}

      {returningReq && (
        <ReturnModal
          request={returningReq}
          onClose={() => setReturningReq(null)}
          onSubmit={(data) => { returnItem(returningReq.id, data); setReturningReq(null); }}
        />
      )}
    </div>
  );
}
