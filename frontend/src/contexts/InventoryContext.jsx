/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { api } from '../api';
import { supabase } from '../lib/supabase';

const InventoryContext = createContext(null);

function genId() { return `IREQ-${Date.now().toString(36).toUpperCase()}`; }

export function InventoryProvider({ children }) {
  const { accounts } = useMsal();
  const myEmail = (accounts[0]?.username ?? '').toLowerCase();

  // Stock levels now live server-side (inventory_items table) and are the
  // single source of truth — decremented on allocation, restored on return.
  // No more locally-held mock data that drifts from reality.
  const [items,         setItems]         = useState([]);
  const [itemsLoading,  setItemsLoading]   = useState(true);
  const [itemsError,    setItemsError]     = useState(null);
  const [requests,      setRequests]       = useState([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError]  = useState(null);
  const channelRef  = useRef(null);  // postgres_changes on inventory_requests
  const eventsRef   = useRef(null);  // postgres_changes on inventory_events
  const pollRef     = useRef(null);
  // Always-current snapshot of requests for use inside subscription callbacks.
  // Avoids stale closure: subscriptions are set up once but need fresh state.
  const requestsRef = useRef([]);

  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);

  const fetchItems = useCallback(() => {
    return api.getInventoryItems()
      .then(rows => { setItems(rows); setItemsError(null); })
      .catch(err => setItemsError(err?.message || 'Failed to load inventory items'))
      .finally(() => setItemsLoading(false));
  }, []);

  const fetchRequests = useCallback(() => {
    return api.getInventoryRequests()
      .then(rows => { setRequests(rows); setRequestsError(null); })
      .catch(err => setRequestsError(err?.message || 'Failed to load requests'))
      .finally(() => setRequestsLoading(false));
  }, []);

  // Convert raw Supabase Realtime row (snake_case) → camelCase to match API shape
  function rowToRequest(r) {
    return {
      id:               r.id,
      itemId:           r.item_id,
      itemName:         r.item_name,
      requestedBy:      r.requested_by,
      requestedByEmail: r.requested_by_email,
      raisedBy:         r.raised_by,
      department:       r.department,
      quantity:         r.quantity,
      days:             r.days,
      reason:           r.reason,
      status:           r.status,
      createdAt:        r.created_at,
      resolvedAt:       r.resolved_at   || null,
      resolvedBy:       r.resolved_by   || null,
      rejectReason:     r.reject_reason || null,
      assignedAllocatorEmail: r.assigned_allocator_email || null,
      assignedAllocatorName:  r.assigned_allocator_name  || null,
      allocatedAt:      r.allocated_at  || null,
      allocatedBy:      r.allocated_by  || null,
      returnedAt:       r.returned_at   || null,
      returnPhotoName:  r.return_photo_name || null,
      returnPhotoUrl:   r.return_photo_url  || null,
      conditionNote:    r.condition_note    || null,
    };
  }

  useEffect(() => {
    fetchItems();
    fetchRequests();

    if (supabase) {
      // INSERT on inventory_requests: new request submitted — add directly to state
      // UPDATE on inventory_requests: kept as backup in case inventory_events misses
      channelRef.current = supabase
        .channel('inventory_requests_changes')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'inventory_requests' },
          payload => {
            const incoming = rowToRequest(payload.new);
            setRequests(prev => {
              if (prev.some(r => r.id === incoming.id)) return prev;
              return [incoming, ...prev];
            });
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'inventory_requests' },
          () => fetchRequests()
        )
        .subscribe();

      // INSERT on inventory_events: backend-pushed signal after every status change.
      // Only the affected user and users who already have the request refetch —
      // keeps API load minimal regardless of how many users are connected.
      // Stock only moves on allocation/return, both of which always fire one of
      // these events — so re-fetching items here keeps "available" counts live
      // for everyone without subscribing to a second realtime channel.
      eventsRef.current = supabase
        .channel('inventory_events_inserts')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'inventory_events' },
          payload => {
            const { affected_email, request_id, status } = payload.new ?? {};
            const isMyRequest = affected_email && myEmail &&
              affected_email.toLowerCase() === myEmail;
            const iAmInvolved = isMyRequest ||
              requestsRef.current.some(r => r.id === request_id);
            if (iAmInvolved) fetchRequests();
            if (status === 'allocated' || status === 'returned') fetchItems();
          }
        )
        .subscribe();

      // 30s fallback poll — catches anything missed if WebSocket drops
      pollRef.current = setInterval(() => { fetchItems(); fetchRequests(); }, 30000);
    } else {
      pollRef.current = setInterval(() => { fetchItems(); fetchRequests(); }, 30000);
    }

    return () => {
      if (channelRef.current) supabase?.removeChannel(channelRef.current);
      if (eventsRef.current)  supabase?.removeChannel(eventsRef.current);
      clearInterval(pollRef.current);
    };
  }, [fetchItems, fetchRequests, myEmail]);

  function raiseRequest({ itemId, itemName, requestedBy, requestedByEmail, raisedBy, department, quantity, days, reason }) {
    const id = genId();
    const resolvedEmail = requestedByEmail || myEmail;
    const req = {
      id, itemId, itemName,
      requestedBy,
      requestedByEmail: resolvedEmail,
      raisedBy: raisedBy || requestedBy,
      department, quantity, days, reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null, resolvedBy: null, rejectReason: null,
    };
    setRequests(prev => [req, ...prev]);
    // Returns the persistence promise (not just the optimistic local object) so
    // the caller can show real success/failure feedback and roll back on error —
    // silently swallowing this used to mean a failed save looked identical to a
    // successful one from the user's point of view.
    return api.createInventoryRequest({
      id,
      item_id:             itemId,
      item_name:           itemName,
      requested_by:        requestedBy,
      requested_by_email:  resolvedEmail,
      raised_by:           req.raisedBy,
      department, quantity, days, reason,
    }).then(saved => {
      setRequests(prev => prev.map(r => r.id === id ? saved : r));
      return saved;
    }).catch(err => {
      setRequests(prev => prev.filter(r => r.id !== id));
      throw err;
    });
  }

  function approveRequest(id, managerName, allocatorEmail, allocatorName) {
    setRequests(prev => prev.map(r =>
      r.id === id ? {
        ...r, status: 'approved',
        resolvedAt: new Date().toISOString(), resolvedBy: managerName,
        assignedAllocatorEmail: allocatorEmail, assignedAllocatorName: allocatorName,
      } : r
    ));
    return api.updateInventoryRequest(id, {
      status: 'approved', resolved_by: managerName,
      assigned_allocator_email: allocatorEmail, assigned_allocator_name: allocatorName,
    })
      .then(saved => { fetchRequests(); return saved; })
      .catch(err => { fetchRequests(); throw err; });
  }

  function cancelRequest(id, requesterName) {
    setRequests(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'cancelled', resolvedAt: new Date().toISOString(), resolvedBy: requesterName } : r
    ));
    return api.updateInventoryRequest(id, { status: 'cancelled', resolved_by: requesterName })
      .then(saved => { fetchRequests(); return saved; })
      .catch(err => { fetchRequests(); throw err; });
  }

  function allocateItem(id, supervisorName) {
    setRequests(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'allocated', allocatedAt: new Date().toISOString(), allocatedBy: supervisorName } : r
    ));
    // Allocation can now legitimately fail server-side (409 — not enough stock,
    // caught by the atomic _reserve_stock guard). Propagate that to the caller
    // so the manager sees *why* their optimistic "allocated" reverted, instead
    // of it silently flipping back to "approved" with no explanation.
    return api.updateInventoryRequest(id, { status: 'allocated', allocated_by: supervisorName })
      .then(saved => {
        fetchRequests();
        fetchItems();
        return saved;
      })
      .catch(err => {
        fetchRequests();
        throw err;
      });
  }

  function rejectRequest(id, managerName, reason) {
    setRequests(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'rejected', resolvedAt: new Date().toISOString(), resolvedBy: managerName, rejectReason: reason } : r
    ));
    api.updateInventoryRequest(id, { status: 'rejected', resolved_by: managerName, reject_reason: reason })
      .then(() => fetchRequests())
      .catch(() => fetchRequests());
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
        const { data: urlData } = supabase.storage
          .from('return-photos')
          .getPublicUrl(uploaded.path);
        permanentUrl = urlData.publicUrl;
      } else if (error) {
        // Don't let a storage hiccup (missing bucket, RLS, network) block the
        // return itself — the item still needs to go back into circulation.
        // But it WAS silently dropping the photo with no feedback at all, so
        // the requester thought it worked and the supervisor never saw it.
        // Surface it after the fact instead — see handleReturnSubmit's toast.
        photoUploadError = error.message || 'Photo upload failed';
      }
    }

    setRequests(prev => prev.map(r =>
      r.id !== id ? r : {
        ...r, status: 'returned',
        returnedAt:     now,
        returnPhotoUrl:  permanentUrl || null,
        returnPhotoName: photoName    || null,
        conditionNote:   conditionNote || null,
      }
    ));

    return api.updateInventoryRequest(id, {
      status:            'returned',
      return_photo_name: photoName     || '',
      return_photo_url:  permanentUrl  || '',
      condition_note:    conditionNote || '',
    }).then(saved => {
      fetchRequests();
      fetchItems();
      return { ...saved, photoUploadError };
    }).catch(err => {
      fetchRequests();
      throw err;
    });
  }

  const pendingCount = requests.filter(r => r.status === 'pending').length;

  return (
    <InventoryContext.Provider value={{
      items, itemsLoading, itemsError,
      requests, requestsLoading, requestsError,
      pendingCount,
      raiseRequest, approveRequest, rejectRequest, allocateItem, returnItem, cancelRequest,
      refreshRequests: fetchRequests,
      refreshItems: fetchItems,
    }}>
      {children}
    </InventoryContext.Provider>
  );
}

export function useInventory() { return useContext(InventoryContext); }
