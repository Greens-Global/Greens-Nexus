// Item Management - the cart, reviewed and sent (Items redesign, Neil 11/02/2026).
//
// A sheet from the right. Borrow asks for a RETURN DATE on a calendar (the
// shared date box), one per item, capped by the item type's longest loan;
// "Same Date for All" fills every row at once. Then who it is for, who
// approves it and why. The server works out the loan from the date
// (backend item_due.py).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, X } from 'lucide-react';
import { Spinner } from '../../components/AsyncState';
import { api } from '../../api';
import { useInventory } from '../../contexts/InventoryContext';
import { formatDate } from '../../lib/datetime';
import { TYPE_DEPT_FALLBACK, suggestAllocator } from '../model/allocator';
import { fmtMoney } from '../model/format';
import { addDaysISO, todayISO } from '../model/due';
import { loanCapFor, useTypeSettings } from '../model/useTypeSettings';
import { useItemsIdentity } from '../model/identity';
import { setAllCartDue, setCartDue, removeFromCart, dropSubmitted, useItemCart } from '../cart/useItemCart';
import { PersonTypeahead } from '../ui/PersonTypeahead';
import { DateBox } from '../ui/DateBox';
import { NoPhoto } from '../ui/photos';
import { itemsToast } from '../ui/Toast';
import { ItemSheet, LABEL, HINT, ERROR } from '../ui/Sheet';

/** The latest return date this person may pick for an item of `type`. */
export function maxReturnDate(byName, type, today = todayISO()) {
  return addDaysISO(today, loanCapFor(byName, type));
}

export function CartSheet({ onClose, onSubmitted, isManager = false }) {
  const { items = [], submitCartCheckouts } = useInventory() || {};
  const { cart } = useItemCart();
  const { byName } = useTypeSettings();
  const { myEmail, myName } = useItemsIdentity();
  const [reason, setReason] = useState('');
  const [forSelf, setForSelf] = useState(true);
  const [forName, setForName] = useState('');
  const [forEmail, setForEmail] = useState('');
  const [approvers, setApprovers] = useState([]);
  const [approverEmail, setApproverEmail] = useState('');
  const [approverErr, setApproverErr] = useState(false);
  const [allDate, setAllDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The borrower's calendar comes from the server (GET /items/borrow-window):
  // today and each item's first and last return date in the BORROWER's zone
  // - the person the request is for. The viewer's clock is only a fallback
  // until it answers.
  const [win, setWin] = useState(null);
  const idsKey = cart.map(c => c.item.id).sort().join(',');
  const forKey = forSelf ? '' : forEmail;
  useEffect(() => {
    if (!idsKey) return undefined;
    let alive = true;
    api.getBorrowWindow(idsKey.split(','), forKey).then(w => { if (alive) setWin(w); }).catch(() => {});
    return () => { alive = false; };
  }, [idsKey, forKey]);
  const today = win?.today || todayISO();
  const itemOf = useCallback((ci) => items.find(i => i.id === ci.item.id) || ci.item, [items]);
  const firstOf = (ci) => win?.items?.[ci.item.id]?.first || addDaysISO(today, 1);
  const capOf = (ci) => win?.items?.[ci.item.id]?.last || maxReturnDate(byName, itemOf(ci).itemType, today);
  // A line the server no longer lends (taken, lost, out of reach) is marked
  // and left out of the request, with a note.
  const unavailable = (ci) => !!win?.items && (!win.items[ci.item.id] || win.items[ci.item.id].available === false);
  const lines = cart.filter(ci => !unavailable(ci));
  const tomorrow = lines.length ? lines.map(firstOf).sort()[0] : addDaysISO(today, 1);
  // "Same Date for All" can go only as far as the shortest cap in the cart.
  const allMax = useMemo(() => lines.reduce((m, ci) => { const c = capOf(ci); return !m || c < m ? c : m; }, ''), [cart, byName, items, win]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalValue = cart.reduce((s, ci) => s + (Number(itemOf(ci).assetValue) || 0), 0);
  // A manager's own request is approved at once (server) - no approver to pick.
  const needApprover = !(isManager && forSelf);

  const loadApprovers = useCallback(() => {
    setApproverErr(false);
    // Only managers who can reach every item's company (the server narrows by
    // item; a cart across companies keeps the people common to all of them).
    const ids = [...new Set(cart.map(c => c.item.id))].slice(0, 6);
    (ids.length ? Promise.all(ids.map(id => api.getItemApproversFor(id))) : api.getItemApprovers().then(r => [r])).then(lists => {
      const rows = (lists[0] || []).filter(a => lists.every(l => (l || []).some(x => x.email === a.email)));
      setApprovers(rows);
      setApproverEmail(prev => {
        if (prev) return prev;
        let remembered = '';
        try { remembered = localStorage.getItem('nexus-approver-email') || ''; } catch { /* storage blocked */ }
        if (remembered && rows.some(a => a.email === remembered)) return remembered;
        const pseudo = cart.map(c => ({ department: itemOf(c).department || TYPE_DEPT_FALLBACK[itemOf(c).itemType] || '' }));
        const pick = suggestAllocator(pseudo, rows);
        return pick ? pick.email : '';
      });
    }).catch(() => setApproverErr(true));
  }, [cart, itemOf]);
  // Again whenever the cart's items change (the narrowing is per item).
  const cartKey = cart.map(c => c.item.id).sort().join(',');
  useEffect(() => { if (cartKey) loadApprovers(); }, [cartKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const approver = approvers.find(a => a.email === approverEmail) || null;
  const datesOk = lines.length > 0 && lines.every(ci => ci.dueDate && ci.dueDate >= firstOf(ci) && ci.dueDate <= capOf(ci));
  const ready = datesOk && reason.trim() && (forSelf || !!forEmail) && (!needApprover || !!approver) && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      if (approver) { try { localStorage.setItem('nexus-approver-email', approver.email); } catch { /* storage blocked */ } }
      const rows = lines.map(ci => ({ ...ci, item: { ...itemOf(ci), ...ci.item, department: itemOf(ci).department } }));
      const results = await submitCartCheckouts(rows, {
        reason: reason.trim(), raisedBy: myName, raisedByEmail: myEmail,
        forName: forSelf ? '' : forName, forEmail: forSelf ? '' : forEmail,
        approverEmail: needApprover ? (approver?.email || '') : '', approverName: needApprover ? (approver?.name || '') : '',
      });
      const ok = rows.filter((_, i) => results[i].status === 'fulfilled').map(r => r.item.id);
      const failed = rows.filter((_, i) => results[i].status === 'rejected');
      await dropSubmitted(ok);
      if (ok.length) itemsToast(`${ok.length} request${ok.length === 1 ? '' : 's'} sent.`);
      if (failed.length) {
        // Say exactly what went and what did not - never a half-sent cart in silence.
        const sent = rows.filter((_, i) => results[i].status === 'fulfilled').map(r => r.item.name);
        const notSent = rows.map((r, i) => ({ r, res: results[i] })).filter(x => x.res.status === 'rejected')
          .map(x => `${x.r.item.name} (${x.res.reason?.message || 'please try again'})`);
        setError(`${sent.length ? `Sent: ${sent.join(', ')}. ` : ''}Not sent: ${notSent.join('; ')}. The ones not sent stay in your cart.`);
        setBusy(false);
        return;
      }
      onSubmitted?.();
      onClose();
    } catch (e) {
      setError(e?.message || 'Could not send the request.');
      setBusy(false);
    }
  }

  const dirty = reason.trim() !== '' || !forSelf;
  return (
    <ItemSheet title="Your Cart" onClose={onClose} isDirty={dirty}
      footer={<>
        {totalValue > 0 && <span style={{ marginRight: 'auto', fontSize: 13, color: 'var(--muted)' }}>Total value <strong style={{ color: 'var(--ink)' }}>{fmtMoney(totalValue)}</strong></span>}
        <button className="secondary-btn" onClick={onClose} disabled={busy}>Keep Browsing</button>
        <button className="primary-btn" disabled={!ready} onClick={submit} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          {busy ? <><Spinner size={14} /> Sending…</> : <><CheckCircle size={14} /> Request {lines.length} Item{lines.length === 1 ? '' : 's'}</>}
        </button>
      </>}>
      {cart.length === 0 ? (
        <div className="it-empty">
          <div className="it-empty-title">Your cart is empty</div>
          <div className="it-empty-sub">Add items from Borrow, then come back here to pick the return dates.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <section>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ ...LABEL, marginBottom: 0 }}>Return Dates</span>
              {cart.length > 1 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--muted)' }}>
                  Same Date for All
                  <DateBox compact value={allDate} min={tomorrow} max={allMax} noPast ariaLabel="Same return date for all"
                    onChange={v => { setAllDate(v); if (v) setAllCartDue(v); }} style={{ width: 150 }} />
                </span>
              )}
            </div>
            <div className="it-list">
              {cart.map(ci => {
                const it = itemOf(ci);
                const max = capOf(ci);
                const first = firstOf(ci);
                const gone = unavailable(ci);
                const bad = ci.dueDate && (ci.dueDate < first || ci.dueDate > max);
                return (
                  <div key={ci.id} className="it-row it-cart-row">
                    <span className="it-row-main" style={{ cursor: 'default' }}>
                      {it.photoUrl ? <img src={it.photoUrl} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', border: '1px solid var(--line)' }} /> : <NoPhoto size={40} />}
                      <span className="it-row-text">
                        <span className="it-row-title">{it.name}</span>
                        <span className="it-row-sub">{gone ? 'No longer available - it will not be requested' : `${[it.itemType, it.location].filter(Boolean).join(' · ')} · up to ${formatDate(max)}`}</span>
                      </span>
                    </span>
                    <span className="it-row-acts">
                      {!gone && <DateBox compact value={ci.dueDate} min={first} max={max} noPast placeholder="Return by"
                        ariaLabel={`Return date for ${it.name}`} onChange={v => setCartDue(ci.item.id, v)} style={{ width: 150, borderColor: bad ? 'var(--wk-red)' : undefined }} />}
                      <button type="button" aria-label={`Remove ${it.name}`} onClick={() => removeFromCart(ci.item.id, { onError: m => itemsToast(m, 'error') })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 6, display: 'flex' }}>
                        <X size={15} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
            {!datesOk && <p style={HINT}>Pick a return date for each item. Each type has its longest loan.</p>}
          </section>

          <section>
            <span style={LABEL}>Who Is It For?</span>
            <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: 'var(--mist)', maxWidth: 360 }}>
              {[[true, 'Myself'], [false, 'Someone Else']].map(([v, l]) => (
                <button key={l} type="button" aria-pressed={forSelf === v} onClick={() => { setForSelf(v); if (v) { setForName(''); setForEmail(''); } }}
                  style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', background: forSelf === v ? 'var(--wk-brand-tint)' : 'transparent', boxShadow: 'none', color: forSelf === v ? 'var(--wk-brand)' : 'var(--muted)', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>{l}</button>
              ))}
            </div>
            {!forSelf && (
              <div style={{ marginTop: 10, maxWidth: 420 }}>
                <PersonTypeahead valueName={forName} placeholder="Type a name…"
                  onPick={({ email, name }) => { setForName(name); setForEmail(email); }} />
                <p style={HINT}>{forEmail ? `It shows in ${forName}'s My Stuff.` : 'Pick the person from the list so it lands in their account.'}</p>
              </div>
            )}
          </section>

          {needApprover && (
            <section>
              <label style={LABEL} htmlFor="cart-approver">Who Approves It?</label>
              {approverErr ? (
                <div style={{ fontSize: 13, color: 'var(--bad-fg)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  Could not load the approvers.
                  <button className="secondary-btn" style={{ fontSize: 12, padding: '4px 12px' }} onClick={loadApprovers}>Retry</button>
                </div>
              ) : (
                <select id="cart-approver" className="form-input" style={{ width: '100%', maxWidth: 420 }} value={approverEmail} onChange={e => setApproverEmail(e.target.value)}>
                  <option value="">Choose a manager</option>
                  {approvers.map(a => <option key={a.email} value={a.email}>{a.name}</option>)}
                </select>
              )}
              <p style={HINT}>Only this manager is told about your request.</p>
            </section>
          )}

          <section>
            <label style={LABEL} htmlFor="cart-reason">Why Do You Need It?</label>
            <textarea id="cart-reason" rows={3} className="form-input" style={{ width: '100%', resize: 'vertical', fontSize: 13.5 }}
              placeholder="e.g. Pressure washing the Austin site this week" value={reason} onChange={e => setReason(e.target.value)} />
            <p style={HINT}>Once it is approved, you confirm you have each item with a photo.</p>
          </section>
          {error && <p style={ERROR}>{error}</p>}
        </div>
      )}
    </ItemSheet>
  );
}
