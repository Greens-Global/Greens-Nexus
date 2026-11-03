// Item Management - THE cart (Items redesign, Neil 11/02/2026).
//
// There used to be two carts (the employee screen's and Manage mode's), each
// with its own state, and they drifted apart. Now every screen reads this one
// store: the rows live on the server (/items/cart - they survive a sign-out
// and a device switch), the return date picked for each row lives here for
// the session. One load, many subscribers, the same pattern as
// useAssignments (components/Assignments.jsx).
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';

let _rows = [];            // [{ id, item: { id, name, itemType, ... }, dueDate }]
let _loaded = false;
let _loading = null;
const _subs = new Set();

function _emit(next) {
  _rows = next;
  _subs.forEach((fn) => fn(_rows));
}

function _load(force = false) {
  if (_loading) return _loading;
  if (_loaded && !force) return Promise.resolve(_rows);
  const before = new Set(_rows.map((r) => r.item.id));
  _loading = api.getItemCart()
    .then((rows) => {
      const local = new Map(_rows.map((r) => [r.item.id, r]));
      const server = (rows || []).map((r) => ({
        id: r.id,
        item: local.get(r.itemId)?.item || { id: r.itemId, name: r.itemName, itemType: r.itemType },
        dueDate: local.get(r.itemId)?.dueDate || '',
      }));
      // A row added while this load was in flight is not in the server's
      // answer yet - keep it rather than wiping it.
      const onServer = new Set(server.map((r) => r.item.id));
      const pending = _rows.filter((r) => !onServer.has(r.item.id) && (!before.has(r.item.id) || String(r.id).startsWith('cart-')));
      _loaded = true;
      _emit([...server, ...pending]);
      return _rows;
    })
    .catch(() => _rows)
    .finally(() => { _loading = null; });
  return _loading;
}

/** Add an item (optimistic; the server row id replaces the temporary one). */
export function addToCart(item, { onError } = {}) {
  if (!item?.id || _rows.some((r) => r.item.id === item.id)) return;
  const tempId = `cart-${item.id}-${Date.now()}`;
  _emit([..._rows, { id: tempId, item, dueDate: '' }]);
  api.addItemToCart({ item_id: item.id, item_name: item.name, item_type: item.itemType })
    .then((saved) => _emit(_rows.map((r) => (r.id === tempId ? { ...r, id: saved?.id || tempId } : r))))
    .catch((err) => {
      _emit(_rows.filter((r) => r.id !== tempId));
      onError?.(err?.message || 'Could not add the item to your cart.');
    });
}

/** Remove by item id; a failure puts the row back and says so. */
export function removeFromCart(itemId, { onError } = {}) {
  const entry = _rows.find((r) => r.item.id === itemId);
  if (!entry) return;
  _emit(_rows.filter((r) => r.item.id !== itemId));
  api.removeItemFromCart(itemId).catch((err) => {
    if (!_rows.some((r) => r.item.id === itemId)) _emit([..._rows, entry]);
    onError?.(err?.message || 'Could not remove the item from your cart.');
  });
}

export function setCartDue(itemId, dueDate) {
  _emit(_rows.map((r) => (r.item.id === itemId ? { ...r, dueDate } : r)));
}

/** One date for every row (each row may still be changed after). */
export function setAllCartDue(dueDate) {
  _emit(_rows.map((r) => ({ ...r, dueDate })));
}

/** After a submit: drop the rows that went through (server and here). */
export async function dropSubmitted(itemIds) {
  const gone = new Set(itemIds);
  _emit(_rows.filter((r) => !gone.has(r.item.id)));
  await Promise.all([...gone].map((id) => api.removeItemFromCart(id).catch(() => {})));
}

/** For tests: forget everything. */
export function _resetCart() { _rows = []; _loaded = false; _loading = null; _subs.forEach((fn) => fn(_rows)); }

export function useItemCart() {
  const [rows, setRows] = useState(_rows);
  useEffect(() => {
    _subs.add(setRows);
    setRows(_rows);
    _load();
    return () => { _subs.delete(setRows); };
  }, []);
  const inCart = useMemo(() => new Set(rows.map((r) => r.item.id)), [rows]);
  return { cart: rows, inCart, count: rows.length, reload: () => _load(true) };
}
