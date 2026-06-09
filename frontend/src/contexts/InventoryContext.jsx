/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { cleanName } from '../lib/utils';

const InventoryContext = createContext(null);

function genCheckoutId() {
  return `ICHK-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().replace(/-/g,'').slice(0,8).toUpperCase()}`;
}

export function InventoryProvider({ children }) {
  const { accounts } = useMsal();
  const myEmail = (accounts[0]?.username ?? '').toLowerCase();

  const [items,            setItems]            = useState([]);
  const [itemsLoading,     setItemsLoading]     = useState(true);
  const [itemsError,       setItemsError]       = useState(null);
  const [checkouts,        setCheckouts]        = useState([]);
  const [checkoutsLoading, setCheckoutsLoading] = useState(true);
  const [checkoutsError,   setCheckoutsError]   = useState(null);

  const channelRef  = useRef(null);
  const eventsRef   = useRef(null);
  const pollRef     = useRef(null);
  const checkoutsRef = useRef([]);

  useEffect(() => { checkoutsRef.current = checkouts; }, [checkouts]);

  // Retry helper — the api layer already handles transient 5xx/network errors,
  // but if even that exhausts (truly down), we do one more quiet 3s wait here
  // before surfacing an error banner so a single click still works post-cold-start.
  async function withQuietRetry(fn) {
    try { return await fn(); }
    catch {
      await new Promise(r => setTimeout(r, 3000));
      return fn(); // let this one throw if it also fails
    }
  }

  const fetchItems = useCallback(() =>
    withQuietRetry(() => api.getItems())
      .then(rows => { setItems(rows); setItemsError(null); })
      .catch(err => setItemsError(err?.message || 'Failed to load items'))
      .finally(() => setItemsLoading(false))
  , []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchCheckouts = useCallback(() =>
    withQuietRetry(() => api.getItemCheckouts())
      .then(rows => { setCheckouts(rows); setCheckoutsError(null); })
      .catch(err => setCheckoutsError(err?.message || 'Failed to load checkouts'))
      .finally(() => setCheckoutsLoading(false))
  , []); // eslint-disable-line react-hooks/exhaustive-deps

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
    };
  }

  useEffect(() => {
    fetchItems();
    fetchCheckouts();

    if (supabase) {
      eventsRef.current = supabase
        .channel('item_events_inserts')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'inventory_events' },
          payload => {
            const { affected_email, request_id, status } = payload.new ?? {};
            const isMe = affected_email && myEmail && affected_email.toLowerCase() === myEmail;
            const involved = isMe || checkoutsRef.current.some(c => c.id === request_id);
            if (involved) fetchCheckouts();
            if (status === 'allocated' || status === 'returned') fetchItems();
          }
        )
        .subscribe();

      pollRef.current = setInterval(() => { fetchItems(); fetchCheckouts(); }, 30000);
    } else {
      pollRef.current = setInterval(() => { fetchItems(); fetchCheckouts(); }, 30000);
    }

    return () => {
      if (eventsRef.current) supabase?.removeChannel(eventsRef.current);
      clearInterval(pollRef.current);
    };
  }, [fetchItems, fetchCheckouts, myEmail]);

  // ── Checkout actions ──────────────────────────────────────────────────────

  function submitCartCheckouts(cartItems, { reason, raisedBy, raisedByEmail }) {
    const promises = cartItems.map(cartItem => {
      const id = genCheckoutId();
      const itemDays = cartItem.days ?? 1;
      const optimistic = {
        id, itemId: cartItem.item.id, itemName: cartItem.item.name,
        itemType: cartItem.item.itemType, requestedBy: raisedBy,
        requestedByEmail: raisedByEmail, raisedBy, department: cartItem.item.department,
        days: itemDays, reason, status: 'pending', createdAt: new Date().toISOString(),
        checkoutPhotoUrl: cartItem.photoUrl || null,
      };
      setCheckouts(prev => [optimistic, ...prev]);
      return api.createItemCheckout({
        id, item_id: cartItem.item.id, item_name: cartItem.item.name,
        item_type: cartItem.item.itemType, requested_by: raisedBy,
        requested_by_email: raisedByEmail, raised_by: raisedBy,
        department: cartItem.item.department, days: itemDays, reason,
        checkout_photo_url: cartItem.photoUrl || '',
        checkout_photo_name: cartItem.photoName || '',
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
  }

  // Named approveRequest for backward compat with NotificationBell + ManagerDashboard
  function approveRequest(id, managerName, allocatorEmail, allocatorName) {
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
  }

  function rejectRequest(id, managerName, reason) {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? { ...c, status: 'rejected', resolvedAt: new Date().toISOString(), resolvedBy: managerName, rejectReason: reason } : c
    ));
    api.updateItemCheckout(id, { status: 'rejected', resolved_by: managerName, reject_reason: reason })
      .then(() => fetchCheckouts())
      .catch(() => fetchCheckouts());
  }

  function cancelRequest(id, requesterName) {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? { ...c, status: 'cancelled', resolvedAt: new Date().toISOString(), resolvedBy: requesterName } : c
    ));
    return api.updateItemCheckout(id, { status: 'cancelled', resolved_by: requesterName })
      .then(saved => { fetchCheckouts(); return saved; })
      .catch(err => { fetchCheckouts(); throw err; });
  }

  function allocateItem(id, supervisorName, checkoutPhotoUrl = '') {
    setCheckouts(prev => prev.map(c =>
      c.id === id ? { ...c, status: 'allocated', allocatedAt: new Date().toISOString(), allocatedBy: supervisorName, checkoutPhotoUrl: checkoutPhotoUrl || c.checkoutPhotoUrl } : c
    ));
    return api.updateItemCheckout(id, { status: 'allocated', allocated_by: supervisorName, checkout_photo_url: checkoutPhotoUrl })
      .then(saved => { fetchCheckouts(); fetchItems(); return saved; })
      .catch(err => { fetchCheckouts(); throw err; });
  }

  async function returnItem(id, { file, photoName, conditionNote }) {
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
        .upload(path, file, { contentType: file.type, upsert: false });
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
  }

  const pendingCount = checkouts.filter(c => c.status === 'pending').length;

  return (
    <InventoryContext.Provider value={{
      // New items system
      items, itemsLoading, itemsError,
      checkouts, checkoutsLoading, checkoutsError,
      pendingCount,
      submitCartCheckouts, approveRequest, rejectRequest,
      allocateItem, returnItem, cancelRequest,
      refreshItems: fetchItems, refreshCheckouts: fetchCheckouts,
      // Backward compat aliases for NotificationBell + ManagerDashboard
      requests: checkouts,
      requestsLoading: checkoutsLoading,
      requestsError: checkoutsError,
      refreshRequests: fetchCheckouts,
    }}>
      {children}
    </InventoryContext.Provider>
  );
}

export function useInventory() { return useContext(InventoryContext); }
