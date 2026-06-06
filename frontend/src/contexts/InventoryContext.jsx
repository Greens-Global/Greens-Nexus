/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { api } from '../api';
import { supabase } from '../lib/supabase';

const InventoryContext = createContext(null);

const INITIAL_ITEMS = [
  // ── IT ─────────────────────────────────────────────────────────────────────
  { id: 'INV-001', name: 'Laptop (Dell XPS 15)',      category: 'IT Supplies',      department: 'IT',           available: 2,  total: 6  },
  { id: 'INV-002', name: 'Network Switch 24-Port',    category: 'IT Supplies',      department: 'IT',           available: 1,  total: 3  },
  { id: 'INV-003', name: 'HDMI Cable (2m)',            category: 'IT Supplies',      department: 'IT',           available: 6,  total: 10 },
  { id: 'INV-004', name: 'Extension Lead (5m)',        category: 'Electrical',       department: 'IT',           available: 4,  total: 7  },
  { id: 'INV-005', name: 'USB-C Docking Station',     category: 'IT Supplies',      department: 'IT',           available: 3,  total: 5  },
  { id: 'INV-006', name: 'Wireless Mouse & Keyboard', category: 'IT Supplies',      department: 'IT',           available: 8,  total: 12 },
  { id: 'INV-007', name: 'External Monitor 27"',      category: 'IT Supplies',      department: 'IT',           available: 1,  total: 4  },
  { id: 'INV-008', name: 'UPS Battery Backup',        category: 'Electrical',       department: 'IT',           available: 2,  total: 3  },
  { id: 'INV-009', name: 'Ethernet Cable Box (30m)',  category: 'IT Supplies',      department: 'IT',           available: 5,  total: 8  },
  { id: 'INV-010', name: 'Webcam HD 1080p',           category: 'IT Supplies',      department: 'IT',           available: 0,  total: 4  },

  // ── Construction ───────────────────────────────────────────────────────────
  { id: 'INV-011', name: 'Power Drill (Cordless)',    category: 'Tools',            department: 'Construction', available: 3,  total: 5  },
  { id: 'INV-012', name: 'Angle Grinder',             category: 'Tools',            department: 'Construction', available: 2,  total: 4  },
  { id: 'INV-013', name: 'Safety Helmet',             category: 'Safety Equipment', department: 'Construction', available: 10, total: 20 },
  { id: 'INV-014', name: 'Hi-Vis Vest',               category: 'Safety Equipment', department: 'Construction', available: 8,  total: 15 },
  { id: 'INV-015', name: 'Tape Measure (5m)',         category: 'Tools',            department: 'Construction', available: 7,  total: 10 },
  { id: 'INV-016', name: 'Circular Saw',              category: 'Tools',            department: 'Construction', available: 1,  total: 3  },
  { id: 'INV-017', name: 'Safety Goggles',            category: 'Safety Equipment', department: 'Construction', available: 12, total: 20 },
  { id: 'INV-018', name: 'Ear Protection (Pair)',     category: 'Safety Equipment', department: 'Construction', available: 15, total: 25 },
  { id: 'INV-019', name: 'Spirit Level (600mm)',      category: 'Tools',            department: 'Construction', available: 4,  total: 6  },
  { id: 'INV-020', name: 'Cable Reel (25m)',          category: 'Electrical',       department: 'Construction', available: 0,  total: 4  },

  // ── Operations ─────────────────────────────────────────────────────────────
  { id: 'INV-021', name: 'Office Chair (Ergonomic)', category: 'Furniture',        department: 'Operations',   available: 3,  total: 8  },
  { id: 'INV-022', name: 'Standing Desk',            category: 'Furniture',        department: 'Operations',   available: 1,  total: 4  },
  { id: 'INV-023', name: 'First Aid Kit',            category: 'Safety Equipment', department: 'Operations',   available: 4,  total: 6  },
  { id: 'INV-024', name: 'Walkie Talkie (Set of 2)', category: 'Tools',            department: 'Operations',   available: 5,  total: 8  },
  { id: 'INV-025', name: 'Floor Cleaning Machine',  category: 'Tools',            department: 'Operations',   available: 0,  total: 2  },
  { id: 'INV-026', name: 'Storage Cabinet',         category: 'Furniture',        department: 'Operations',   available: 2,  total: 3  },
  { id: 'INV-027', name: 'Handheld Vacuum',         category: 'Tools',            department: 'Operations',   available: 3,  total: 4  },

  // ── Accounting ─────────────────────────────────────────────────────────────
  { id: 'INV-028', name: 'Printer Paper (Ream)',     category: 'Office Supplies',  department: 'Accounting',   available: 20, total: 50 },
  { id: 'INV-029', name: 'Stapler',                  category: 'Office Supplies',  department: 'Accounting',   available: 5,  total: 8  },
  { id: 'INV-030', name: 'File Folders (Box of 50)', category: 'Office Supplies',  department: 'Accounting',   available: 10, total: 20 },
  { id: 'INV-031', name: 'Financial Calculator',     category: 'Office Supplies',  department: 'Accounting',   available: 3,  total: 6  },
  { id: 'INV-032', name: 'Document Shredder',        category: 'Office Supplies',  department: 'Accounting',   available: 1,  total: 2  },
  { id: 'INV-033', name: 'Binding Machine',          category: 'Office Supplies',  department: 'Accounting',   available: 0,  total: 1  },
  { id: 'INV-034', name: 'Whiteboard + Markers Kit', category: 'Office Supplies',  department: 'Accounting',   available: 2,  total: 4  },
];

function genId() { return `IREQ-${Date.now().toString(36).toUpperCase()}`; }

export function InventoryProvider({ children }) {
  const { accounts } = useMsal();
  const myEmail = (accounts[0]?.username ?? '').toLowerCase();

  const [items]    = useState(INITIAL_ITEMS);
  const [requests, setRequests] = useState([]);
  const channelRef  = useRef(null);  // postgres_changes on inventory_requests
  const eventsRef   = useRef(null);  // postgres_changes on inventory_events
  const pollRef     = useRef(null);
  // Always-current snapshot of requests for use inside subscription callbacks.
  // Avoids stale closure: subscriptions are set up once but need fresh state.
  const requestsRef = useRef([]);

  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);

  const fetchRequests = useCallback(() => {
    api.getInventoryRequests()
      .then(rows => setRequests(rows))
      .catch(() => {});
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
      allocatedAt:      r.allocated_at  || null,
      allocatedBy:      r.allocated_by  || null,
      returnedAt:       r.returned_at   || null,
      returnPhotoName:  r.return_photo_name || null,
      returnPhotoUrl:   r.return_photo_url  || null,
      conditionNote:    r.condition_note    || null,
    };
  }

  useEffect(() => {
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
      eventsRef.current = supabase
        .channel('inventory_events_inserts')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'inventory_events' },
          payload => {
            const { affected_email, request_id } = payload.new ?? {};
            const isMyRequest = affected_email && myEmail &&
              affected_email.toLowerCase() === myEmail;
            const iAmInvolved = isMyRequest ||
              requestsRef.current.some(r => r.id === request_id);
            if (iAmInvolved) fetchRequests();
          }
        )
        .subscribe();

      // 30s fallback poll — catches anything missed if WebSocket drops
      pollRef.current = setInterval(fetchRequests, 30000);
    } else {
      pollRef.current = setInterval(fetchRequests, 30000);
    }

    return () => {
      if (channelRef.current) supabase?.removeChannel(channelRef.current);
      if (eventsRef.current)  supabase?.removeChannel(eventsRef.current);
      clearInterval(pollRef.current);
    };
  }, [fetchRequests, myEmail]);

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
    api.createInventoryRequest({
      id,
      item_id:             itemId,
      item_name:           itemName,
      requested_by:        requestedBy,
      requested_by_email:  resolvedEmail,
      raised_by:           req.raisedBy,
      department, quantity, days, reason,
    }).then(saved => {
      setRequests(prev => prev.map(r => r.id === id ? saved : r));
    }).catch(() => {});
    return req;
  }

  function approveRequest(id, managerName) {
    setRequests(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'approved', resolvedAt: new Date().toISOString(), resolvedBy: managerName } : r
    ));
    api.updateInventoryRequest(id, { status: 'approved', resolved_by: managerName })
      .then(() => fetchRequests())
      .catch(() => fetchRequests());
  }

  function allocateItem(id, supervisorName) {
    setRequests(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'allocated', allocatedAt: new Date().toISOString(), allocatedBy: supervisorName } : r
    ));
    api.updateInventoryRequest(id, { status: 'allocated', allocated_by: supervisorName })
      .then(() => fetchRequests())
      .catch(() => fetchRequests());
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

    api.updateInventoryRequest(id, {
      status:            'returned',
      return_photo_name: photoName     || '',
      return_photo_url:  permanentUrl  || '',
      condition_note:    conditionNote || '',
    }).then(() => fetchRequests()).catch(() => {});
  }

  const pendingCount = requests.filter(r => r.status === 'pending').length;

  return (
    <InventoryContext.Provider value={{
      items, requests, pendingCount,
      raiseRequest, approveRequest, rejectRequest, allocateItem, returnItem,
      refreshRequests: fetchRequests,
    }}>
      {children}
    </InventoryContext.Provider>
  );
}

export function useInventory() { return useContext(InventoryContext); }
