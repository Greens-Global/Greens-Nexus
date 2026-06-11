/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { cleanName } from '../lib/utils';

const InventoryContext = createContext(null);

function genCheckoutId() {
  return `ICHK-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().replace(/-/g,'').slice(0,8).toUpperCase()}`;
}

// Polls usually return identical data — keeping the previous array reference
// lets React bail out of re-rendering every consumer on each 10s cycle.
function keepIfSame(prev, next) {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

export function InventoryProvider({ children }) {
  const [items,            setItems]            = useState([]);
  const [itemsLoading,     setItemsLoading]     = useState(true);
  const [itemsError,       setItemsError]       = useState(null);
  const [checkouts,        setCheckouts]        = useState([]);
  const [checkoutsLoading, setCheckoutsLoading] = useState(true);
  const [checkoutsError,   setCheckoutsError]   = useState(null);

  const eventsRef     = useRef(null);
  const pollRef       = useRef(null);
  const itemsInFlight = useRef(false);
  const cosInFlight   = useRef(false);
  // Consecutive error counts for backoff
  const itemsErrCount = useRef(0);
  const cosErrCount   = useRef(0);

  const fetchItems = useCallback(() => {
    if (itemsInFlight.current) return Promise.resolve(); // deduplicate
    itemsInFlight.current = true;
    return api.getItems()
      .then(rows => { setItems(prev => keepIfSame(prev, rows)); setItemsError(null); itemsErrCount.current = 0; })
      .catch(err => { setItemsError(err?.message || 'Failed to load items'); itemsErrCount.current += 1; })
      .finally(() => { setItemsLoading(false); itemsInFlight.current = false; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchCheckouts = useCallback(() => {
    if (cosInFlight.current) return Promise.resolve(); // deduplicate
    cosInFlight.current = true;
    return api.getItemCheckouts()
      .then(rows => {
        const mapped = rows.map(r => ({
          ...r,
          requestedBy:           cleanName(r.requestedBy),
          raisedBy:              cleanName(r.raisedBy),
          resolvedBy:            cleanName(r.resolvedBy),
          assignedAllocatorName: cleanName(r.assignedAllocatorName),
          allocatedBy:           cleanName(r.allocatedBy),
        }));
        setCheckouts(prev => keepIfSame(prev, mapped));
        setCheckoutsError(null);
        cosErrCount.current = 0;
      })
      .catch(err => { setCheckoutsError(err?.message || 'Failed to load checkouts'); cosErrCount.current += 1; })
      .finally(() => { setCheckoutsLoading(false); cosInFlight.current = false; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function rowToCheckout(r) {
    return {
      id:                     r.id,
      itemId:                 r.item_id,
      itemName:               r.item_name,
      itemType:               r.item_type,
      requestedBy:            cleanName(r.requested_by),
      requestedByEmail:       r.requested_by_email,
      raisedBy:               cleanName(r.raised_by),
      department:             r.department,
      days:                   r.days,
      reason:                 r.reason,
      status:                 r.status,
      createdAt:              r.created_at,
      resolvedAt:             r.resolved_at              || null,
      resolvedBy:             cleanName(r.resolved_by)   || null,
      rejectReason:           r.reject_reason            || null,
      assignedAllocatorEmail: r.assigned_allocator_email || null,
      assignedAllocatorName:  cleanName(r.assigned_allocator_name) || null,
      allocatedAt:            r.allocated_at             || null,
      allocatedBy:            cleanName(r.allocated_by)  || null,
      checkoutPhotoUrl:       r.checkout_photo_url       || null,
      checkoutPhotoName:      r.checkout_photo_name      || null,
      returnedAt:             r.returned_at              || null,
      returnPhotoUrl:         r.return_photo_url         || null,
      returnPhotoName:        r.return_photo_name        || null,
      conditionNote:          r.condition_note           || null,
      orderId:                r.orderId                  || r.order_id || '',
    };
  }

  // Adaptive polling: backs off from 10s to 60s when errors accumulate,
  // then ramps back down on the first successful response.
  const scheduleNext = useCallback(() => {
    clearTimeout(pollRef.current);
    const errCount = Math.max(itemsErrCount.current, cosErrCount.current);
    const delay = errCount === 0 ? 10_000
                : errCount === 1 ? 20_000
                : errCount === 2 ? 40_000
                : 60_000;
    pollRef.current = setTimeout(() => {
      fetchItems();
      fetchCheckouts();
      scheduleNext();
    }, delay);
  }, [fetchItems, fetchCheckouts]);

  useEffect(() => {
    fetchItems().then(scheduleNext);
    fetchCheckouts();

    if (supabase) {
      // inventory_events ONLY: a skinny ping table (checkout id + status, no
      // personal data) the backend writes on every checkout change. The old
      // second subscription watched item_checkouts directly, which required an
      // anon SELECT policy that exposed the ENTIRE table (names, emails,
      // reasons) to anyone holding the public anon key. Refetching through the
      // authenticated API keeps the same freshness — the server filters
      // visibility, and the inFlight guards dedupe concurrent calls.
      eventsRef.current = supabase
        .channel('item_events_inserts')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'inventory_events' },
          payload => {
            const { status } = payload.new ?? {};
            fetchCheckouts();
            // Refetch items whenever catalog availability may have changed
            // (pending covers brand-new requests flagging hasActiveRequest)
            if (['pending', 'allocated', 'returned', 'cancelled'].includes(status)) {
              fetchItems();
            }
          }
        )
        .subscribe();
    }

    return () => {
      if (eventsRef.current) supabase?.removeChannel(eventsRef.current);
      clearTimeout(pollRef.current);
    };
  }, [fetchItems, fetchCheckouts, scheduleNext]);

  // ── Checkout actions ──────────────────────────────────────────────────────

  const submitCartCheckouts = useCallback((cartItems, { reason, raisedBy, raisedByEmail, approverEmail = '', approverName = '' }) => {
    const orderId = crypto.randomUUID();
    const promises = cartItems.map(cartItem => {
      const id = genCheckoutId();
      const itemDays = cartItem.days ?? 1;
      const optimistic = {
        id, itemId: cartItem.item.id, itemName: cartItem.item.name,
        itemType: cartItem.item.itemType, requestedBy: raisedBy,
        requestedByEmail: raisedByEmail, raisedBy, department: cartItem.item.department,
        days: itemDays, reason, status: 'pending', createdAt: new Date().toISOString(),
        checkoutPhotoUrl: cartItem.photoUrl || null, orderId,
      };
      setCheckouts(prev => [optimistic, ...prev]);
      // asset_value is informational (audit log capture) — the API ignores it
      const itemValue = Number(cartItem.item.assetValue ?? items.find(i => i.id === cartItem.item.id)?.assetValue) || 0;
      return api.createItemCheckout({
        id, item_id: cartItem.item.id, item_name: cartItem.item.name,
        item_type: cartItem.item.itemType, requested_by: raisedBy,
        requested_by_email: raisedByEmail, raised_by: raisedBy,
        department: cartItem.item.department, days: itemDays, reason,
        asset_value: itemValue,
        checkout_photo_url: cartItem.photoUrl || '',
        checkout_photo_name: cartItem.photoName || '',
        order_id: orderId,
        approver_email: approverEmail, approver_name: approverName,
      }).then(saved => {
        setCheckouts(prev => prev.map(c => c.id === id ? saved : c));
        // mark item as pending in local state
        setItems(prev => prev.map(i => i.id === cartItem.item.id ? { ...i, _pendingCheckout: true } : i));
        return saved;
      }).catch(err => {
        setCheckouts(prev => prev.filter(c => c.id !== id));
        throw err;
      });
    });
    return Promise.allSettled(promises);
  }, [items]); // items: asset_value lookup for the audit trail

  // Named approveRequest for backward compat with NotificationBell + ManagerDashboard
  const approveRequest = useCallback((id, managerName, allocatorEmail, allocatorName) => {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? {
        ...c, status: 'approved',
        resolvedAt: new Date().toISOString(), resolvedBy: managerName,
        assignedAllocatorEmail: allocatorEmail, assignedAllocatorName: allocatorName,
      } : c
    ));
    return api.updateItemCheckout(id, {
      status: 'approved', resolved_by: managerName,
      assigned_allocator_email: allocatorEmail, assigned_allocator_name: allocatorName,
    })
      .then(saved => { fetchCheckouts(); return saved; })
      .catch(err => { fetchCheckouts(); throw err; });
  }, [fetchCheckouts]);

  const rejectRequest = useCallback((id, managerName, reason) => {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? { ...c, status: 'rejected', resolvedAt: new Date().toISOString(), resolvedBy: managerName, rejectReason: reason } : c
    ));
    api.updateItemCheckout(id, { status: 'rejected', resolved_by: managerName, reject_reason: reason })
      .then(() => fetchCheckouts())
      .catch(() => fetchCheckouts());
  }, [fetchCheckouts]);

  const cancelRequest = useCallback((id, requesterName) => {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? { ...c, status: 'cancelled', resolvedAt: new Date().toISOString(), resolvedBy: requesterName } : c
    ));
    return api.updateItemCheckout(id, { status: 'cancelled', resolved_by: requesterName })
      .then(saved => { fetchCheckouts(); return saved; })
      .catch(err => { fetchCheckouts(); throw err; });
  }, [fetchCheckouts]);

  const allocateItem = useCallback((id, supervisorName, checkoutPhotoUrl = '', checkoutPhotoName = '', { handoverPhotoBy = 'allocator', handoverBatch = false } = {}) => {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? { ...c, status: 'allocated', allocatedAt: new Date().toISOString(), allocatedBy: supervisorName, checkoutPhotoUrl: checkoutPhotoUrl || c.checkoutPhotoUrl } : c
    ));
    return api.updateItemCheckout(id, {
      status: 'allocated', allocated_by: supervisorName,
      checkout_photo_url: checkoutPhotoUrl, checkout_photo_name: checkoutPhotoName,
      handover_photo_by: handoverPhotoBy, handover_batch: handoverBatch,
    })
      .then(saved => { fetchCheckouts(); fetchItems(); return saved; })
      .catch(err => { fetchCheckouts(); throw err; });
  }, [fetchCheckouts, fetchItems]);

  // Supervisor initiates handover and employee will confirm receipt with photo
  const initiateHandover = useCallback((id, supervisorName) => {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? { ...c, status: 'pending_receipt', handedOverAt: new Date().toISOString(), handoverPhotoBy: 'employee' } : c
    ));
    return api.updateItemCheckout(id, { status: 'pending_receipt', allocated_by: supervisorName, handover_photo_by: 'employee' })
      .then(saved => { fetchCheckouts(); return saved; })
      .catch(err => { fetchCheckouts(); throw err; });
  }, [fetchCheckouts]);

  // Employee confirms receipt and uploads their own photo
  const confirmReceipt = useCallback((id, recipientName, receiptPhotoUrl = '', receiptPhotoName = '') => {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? { ...c, status: 'allocated', allocatedAt: new Date().toISOString(), receiptPhotoUrl } : c
    ));
    return api.updateItemCheckout(id, {
      status: 'allocated', allocated_by: recipientName,
      receipt_photo_url: receiptPhotoUrl, receipt_photo_name: receiptPhotoName,
    })
      .then(saved => { fetchCheckouts(); fetchItems(); return saved; })
      .catch(err => { fetchCheckouts(); throw err; });
  }, [fetchCheckouts, fetchItems]);

  const returnItem = useCallback(async (id, { file, photoName, conditionNote }) => {
    const now = new Date().toISOString();
    let permanentUrl = '';
    let photoUploadError = null;

    if (file && supabase) {
      const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      const MAX_BYTES = 10 * 1024 * 1024;
      if (!ALLOWED_TYPES.includes(file.type)) throw new Error('Only image files are allowed (JPEG, PNG, GIF, WebP)');
      if (file.size > MAX_BYTES) throw new Error('Photo must be under 10 MB');
      const ext  = file.type.split('/')[1] || 'jpg';
      const path = `${id}/${Date.now()}.${ext}`;
      const { data: uploaded, error } = await supabase.storage
        .from('return-photos')
        .upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
      if (!error && uploaded) {
        const { data: urlData } = supabase.storage.from('return-photos').getPublicUrl(uploaded.path);
        permanentUrl = urlData.publicUrl;
      } else if (error) {
        photoUploadError = error.message || 'Photo upload failed';
      }
    }

    setCheckouts(prev => prev.map(c =>
      c.id !== id ? c : {
        ...c, status: 'returned', returnedAt: now,
        returnPhotoUrl: permanentUrl || null, returnPhotoName: photoName || null,
        conditionNote: conditionNote || null,
      }
    ));

    return api.updateItemCheckout(id, {
      status: 'returned',
      return_photo_name: photoName || '',
      return_photo_url:  permanentUrl || '',
      condition_note:    conditionNote || '',
    }).then(saved => {
      fetchCheckouts();
      fetchItems();
      return { ...saved, photoUploadError };
    }).catch(err => {
      fetchCheckouts();
      throw err;
    });
  }, [fetchCheckouts, fetchItems]);

  const value = useMemo(() => ({
    // New items system
    items, itemsLoading, itemsError,
    checkouts, checkoutsLoading, checkoutsError,
    pendingCount: checkouts.filter(c => c.status === 'pending').length,
    submitCartCheckouts, approveRequest, rejectRequest,
    allocateItem, initiateHandover, confirmReceipt, returnItem, cancelRequest,
    refreshItems: fetchItems, refreshCheckouts: fetchCheckouts,
    // Backward compat aliases for NotificationBell + ManagerDashboard
    requests: checkouts,
    requestsLoading: checkoutsLoading,
    requestsError: checkoutsError,
    refreshRequests: fetchCheckouts,
  }), [
    items, itemsLoading, itemsError, checkouts, checkoutsLoading, checkoutsError,
    submitCartCheckouts, approveRequest, rejectRequest, allocateItem,
    initiateHandover, confirmReceipt, returnItem, cancelRequest, fetchItems, fetchCheckouts,
  ]);

  return (
    <InventoryContext.Provider value={value}>
      {children}
    </InventoryContext.Provider>
  );
}

export function useInventory() { return useContext(InventoryContext); }
