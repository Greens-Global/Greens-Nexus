// Item Management - The checkout cart drawer.
// Moved out of views/InventoryManagement.jsx unchanged (items split, Nov 2 2026).
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, AlertCircle, X, MapPin, ShoppingCart } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { TYPE_META } from '../model/status';
import { fmtMoney } from '../model/format';
import { TYPE_DEPT_FALLBACK, suggestAllocator } from '../model/allocator';
import { FL } from './styles';
import { TypeBadge } from './badges';
import { PersonTypeahead } from './PersonTypeahead';

export function CartDrawer({ open, cart, onClose, onRemove, onSubmit, submitting, onDaysChange, showApprover = false, items = [] }) {
  const [reason, setReason] = useState('');
  // $ value per line + cart total - restored cart rows only carry id/name/type,
  // so values are looked up from the live items list
  const valueOf = ci => Number(items.find(i => i.id === ci.item.id)?.assetValue) || 0;
  const totalValue = cart.reduce((s, c) => s + valueOf(c), 0);
  const [approvers,     setApprovers]     = useState([]);
  const [approverEmail, setApproverEmail] = useState('');
  const [approverErr,   setApproverErr]   = useState(false);
  // On-behalf: ops staff check items out FOR a construction worker who came to
  // the office (Neil). Default = for myself; picking a person routes the checkout
  // into THEIR My Items via requested_by_email while raised_by stays this user.
  const [forSelf,  setForSelf]  = useState(true);
  const [forName,  setForName]  = useState('');
  const [forEmail, setForEmail] = useState('');
  useEffect(() => { if (!open) return; const h = e => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [open]);

  // Load the manager list once the drawer opens; default the pick to the last
  // manager this user sent a request to, else the majority department's usual
  // manager, else leave it for the employee to choose.
  const loadApprovers = useCallback(() => {
    setApproverErr(false);
    api.getItemApprovers().then(rows => {
      setApprovers(rows);
      setApproverEmail(prev => {
        if (prev) return prev;
        const remembered = localStorage.getItem('nexus-approver-email');
        if (remembered && rows.some(a => a.email === remembered)) return remembered;
        const pseudoItems = cart.map(c => ({ department: c.item.department || TYPE_DEPT_FALLBACK[c.item.itemType] || '' }));
        const pick = suggestAllocator(pseudoItems, rows);
        return pick ? pick.email : '';
      });
    // P4: surface a retry instead of leaving Submit permanently dead with no message.
    }).catch(() => setApproverErr(true));
  }, [cart]);
  useEffect(() => {
    if (!open || !showApprover || approvers.length) return;
    loadApprovers();
  }, [open, showApprover]); // eslint-disable-line react-hooks/exhaustive-deps

  const approver  = approvers.find(a => a.email === approverEmail) || null;
  // On-behalf needs a real directory match (email) - a free-typed name isn't enough.
  const behalfOk  = forSelf || !!forEmail;
  const canSubmit = cart.length > 0 && reason.trim() && !submitting && (!showApprover || !!approver) && behalfOk;

  function applyDaysToAll(days) {
    cart.forEach(c => onDaysChange(c.id, days));
  }

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1100, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transition:'opacity 0.25s ease' }} />
      <div className="cart-drawer" style={{ position:'fixed', top:0, right:0, height:'100vh', width:'min(460px,96vw)', background:'var(--card)', boxShadow: open ? '-12px 0 48px rgba(0,0,0,0.22)' : 'none', zIndex:1101, display:'flex', flexDirection:'column', transform: open ? 'translateX(0)' : 'translateX(100%)', transition:'transform 0.28s cubic-bezier(0.4,0,0.2,1)' }}>
        <div style={{ display:'flex', alignItems:'center', padding:'18px 22px', borderBottom:'1px solid var(--line)', gap:12, flexShrink:0 }}>
          <div style={{ width:34, height:34, borderRadius:10, background:'hsla(var(--color-green),0.12)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <ShoppingCart size={17} color="hsl(var(--color-green))" />
          </div>
          <div>
            <div style={{ fontWeight:700, fontSize:15 }}>Checkout cart</div>
            <div style={{ fontSize:12, color:'var(--muted)', marginTop:1 }}>
              {cart.length} item{cart.length !== 1 ? 's' : ''}{totalValue > 0 && <> · <strong style={{ color:'var(--ink)' }}>{fmtMoney(totalValue)}</strong> total value</>}
            </div>
          </div>
          <button onClick={onClose} style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:6, borderRadius:8, display:'flex' }}><X size={18} /></button>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'20px 22px' }}>
          {cart.length === 0 ? (
            <div style={{ textAlign:'center', padding:'48px 0', color:'var(--muted)' }}>
              <ShoppingCart size={32} style={{ opacity:.2, display:'block', margin:'0 auto 10px' }} />
              Your cart is empty. Add items from the list.
            </div>
          ) : (
            <>
              {/* Per-item days */}
              <div style={{ marginBottom:6 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                  <label style={{ ...FL, marginBottom:0 }}>HOW MANY DAYS IS IT NEEDED?</label>
                  <button onClick={() => applyDaysToAll(cart[0]?.days ?? 1)}
                    style={{ fontSize:11, color:'hsl(var(--color-blue))', background:'none', border:'none', cursor:'pointer', padding:'2px 6px', fontFamily:'Inter,sans-serif' }}>
                    Apply First to All
                  </button>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:20 }}>
                  {cart.map(cartItem => {
                    const tm = TYPE_META[cartItem.item.itemType] || TYPE_META.Other;
                    const itemDays = cartItem.days ?? 1;
                    return (
                      <div key={cartItem.id} style={{ border:'1px solid var(--line)', borderRadius:12, padding:'10px 14px', background:'var(--card)', display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:36, height:36, borderRadius:7, overflow:'hidden', flexShrink:0, border:'1px solid var(--line)', background: cartItem.item.photoUrl ? 'transparent' : tm.bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
                          {cartItem.item.photoUrl
                            ? <img src={cartItem.item.photoUrl} alt={cartItem.item.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                            : <tm.Icon size={16} color={tm.color} />}
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontWeight:700, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cartItem.item.name}</div>
                          <div style={{ display:'flex', alignItems:'center', gap:5, marginTop:2 }}>
                            <TypeBadge type={cartItem.item.itemType} />
                            {cartItem.item.location && <span style={{ fontSize:10.5, color:'var(--muted)' }}><MapPin size={9} style={{ display:'inline', marginRight:2 }} />{cartItem.item.location}</span>}
                            {valueOf(cartItem) > 0 && <span style={{ fontSize:10.5, fontWeight:700, color:'var(--muted)' }}>{fmtMoney(valueOf(cartItem))}</span>}
                          </div>
                        </div>
                        {/* Days stepper - explicit "days" unit so it can't be mistaken for quantity */}
                        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:2, flexShrink:0 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                            <button onClick={() => onDaysChange(cartItem.id, Math.max(1, itemDays - 1))}
                              style={{ width:26, height:26, borderRadius:6, border:'1px solid var(--line)', background:'var(--mist)', cursor:'pointer', fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Inter,sans-serif' }}>−</button>
                            <input type="number" min={1} max={90} value={itemDays}
                              onChange={e => onDaysChange(cartItem.id, Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                              style={{ width:38, textAlign:'center', padding:'4px 2px', border:'1px solid var(--line)', borderRadius:6, fontSize:13, fontWeight:700, fontFamily:'Inter,sans-serif', background:'var(--card)' }} />
                            <button onClick={() => onDaysChange(cartItem.id, Math.min(90, itemDays + 1))}
                              style={{ width:26, height:26, borderRadius:6, border:'1px solid var(--line)', background:'var(--mist)', cursor:'pointer', fontSize:14, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Inter,sans-serif' }}>+</button>
                          </div>
                          <span style={{ fontSize:10.5, fontWeight:700, color:'hsl(var(--color-blue))', letterSpacing:'.03em' }}>
                            {itemDays} day{itemDays !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <button onClick={() => onRemove(cartItem.id)}
                          style={{ background:'none', border:'none', cursor:'pointer', color:'var(--muted)', padding:4, borderRadius:6, display:'flex', flexShrink:0 }}>
                          <X size={15} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ background:'hsla(var(--color-blue),0.06)', border:'1px solid hsla(var(--color-blue),0.2)', borderRadius:9, padding:'10px 14px', marginBottom:16, display:'flex', alignItems:'flex-start', gap:8 }}>
                <AlertCircle size={14} color="hsl(var(--color-blue))" style={{ flexShrink:0, marginTop:1 }} />
                <span style={{ fontSize:12.5, color:'hsl(var(--color-blue))', lineHeight:1.4 }}>
                  Once approved, you'll be prompted to upload a photo confirming you received each item.
                </span>
              </div>

              <div style={{ marginBottom:16 }}>
                <label style={FL}>WHO IS THIS REQUEST FOR?</label>
                <div style={{ display:'flex', gap:8, marginBottom: forSelf ? 0 : 8 }}>
                  {[[true, 'Myself'], [false, 'Someone else']].map(([v, l]) => (
                    <button key={l} type="button" onClick={() => { setForSelf(v); if (v) { setForName(''); setForEmail(''); } }}
                      style={{ flex:1, padding:'8px 0', borderRadius:9, border:`1px solid ${forSelf === v ? 'var(--pine)' : 'var(--line)'}`, background: forSelf === v ? 'var(--pine)' : 'transparent', color: forSelf === v ? '#fff' : 'var(--muted)', fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'Inter,sans-serif' }}>{l}</button>
                  ))}
                </div>
                {!forSelf && (
                  <>
                    <PersonTypeahead valueName={forName} placeholder="Type a name…"
                      onPick={({ email, name }) => { setForName(name); setForEmail(email); }} />
                    <p style={{ fontSize:11.5, color: forEmail ? 'var(--muted)' : 'hsl(var(--color-orange))', margin:'6px 0 0' }}>
                      {forEmail ? `It'll show in ${forName}'s My items.` : 'Pick the person from the list so it lands in their account.'}
                    </p>
                  </>
                )}
              </div>

              {showApprover && (
                <div style={{ marginBottom:16 }}>
                  <label style={FL}>WHO SHOULD APPROVE THIS? <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
                  {approverErr ? (
                    <div style={{ fontSize:12.5, color:'hsl(var(--color-red))', display:'flex', alignItems:'center', gap:8 }}>
                      Couldn't load approvers.
                      <button className="secondary-btn" style={{ fontSize:12, padding:'4px 12px' }} onClick={loadApprovers}>Retry</button>
                    </div>
                  ) : (
                    <select className="form-input" style={{ width:'100%' }} value={approverEmail} onChange={e => setApproverEmail(e.target.value)}>
                      <option value="">- select a manager -</option>
                      {approvers.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
                    </select>
                  )}
                  <p style={{ fontSize:11.5, color:'var(--muted)', margin:'6px 0 0' }}>
                    Only this manager will be notified of your request.
                  </p>
                </div>
              )}

              <div>
                <label style={FL}>REASON FOR CHECKOUT <span style={{ color:'hsl(var(--color-red))' }}>*</span></label>
                <textarea rows={3} className="form-input" style={{ width:'100%', resize:'vertical', fontSize:13 }}
                  placeholder="Briefly explain why you need these items…"
                  value={reason} onChange={e => setReason(e.target.value)} />
              </div>
            </>
          )}
        </div>

        {cart.length > 0 && (
          <div style={{ padding:'16px 22px', borderTop:'1px solid var(--line)', flexShrink:0 }}>
            {totalValue > 0 && (
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10, fontSize:12.5 }}>
                <span style={{ color:'var(--muted)', fontWeight:600 }}>Total value being checked out</span>
                <span style={{ fontWeight:800, fontSize:15 }}>{fmtMoney(totalValue)}</span>
              </div>
            )}
            <button className="primary-btn" disabled={!canSubmit}
              style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}
              onClick={() => {
                if (approver) localStorage.setItem('nexus-approver-email', approver.email);
                onSubmit({ reason, approverEmail: approver?.email || '', approverName: approver?.name || '',
                           forName: forSelf ? '' : forName, forEmail: forSelf ? '' : forEmail });
              }}>
              {submitting ? <><Spinner size={15} /> Submitting…</> : <><CheckCircle size={15} /> Submit {cart.length} checkout{cart.length !== 1 ? 's' : ''}</>}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
