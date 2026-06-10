/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { api } from '../api';
import { supabase } from '../lib/supabase';

export const DEPT_SUPERVISORS = {
  'Operations':    'Robert Kim',
  'Accounting':    'Sarah Johnson',
  'IT Support':    'David Kim',
  'Real Estate':   'Jessica Taylor',
  'Marketing':     'Marcus Vance',
  'Admin':         'Emily Rodriguez',
  'Construction':  'Michael Chen',
};

const INIT_HW_ASSETS = [
  { id: 'A001', name: 'Dell XPS 15 Laptop',          category: 'Laptop',     serialNumber: 'SN-XPS15-001',  assignedTo: 'Visesh Lodha',      dept: 'IT',          location: 'Main Office',  status: 'Checked Out', purchased: '2024-03-10', warrantyEnd: '2027-03-10' },
  { id: 'A002', name: 'MacBook Pro 14" M3',           category: 'Laptop',     serialNumber: 'SN-MBP14-002',  assignedTo: 'Sarah Johnson',     dept: 'Accounting',  location: 'Main Office',  status: 'Checked Out', purchased: '2024-06-01', warrantyEnd: '2027-06-01' },
  { id: 'A003', name: 'Dell UltraSharp 27" Monitor',  category: 'Monitor',    serialNumber: 'SN-DEL27-003',  assignedTo: 'Michael Chen',      dept: 'Development', location: 'Dev Floor',    status: 'Checked Out', purchased: '2023-11-15', warrantyEnd: '2026-11-15' },
  { id: 'A004', name: 'HP ProDesk 600 G9 Desktop',    category: 'Desktop',    serialNumber: 'SN-HPD600-004', assignedTo: 'Reception Desk',    dept: 'Admin',       location: 'Front Lobby',  status: 'Checked Out', purchased: '2023-08-20', warrantyEnd: '2026-08-20' },
  { id: 'A005', name: 'Cisco Catalyst 2960 Switch',   category: 'Network',    serialNumber: 'SN-CC2960-005', assignedTo: 'IT Rack',           dept: 'IT',          location: 'Server Room',  status: 'Checked Out', purchased: '2022-05-01', warrantyEnd: '2025-05-01' },
  { id: 'A006', name: 'Synology DS1823xs+ NAS',       category: 'Server',     serialNumber: 'SN-SYN-006',    assignedTo: 'IT Infrastructure', dept: 'IT',          location: 'Server Room',  status: 'Checked Out', purchased: '2023-02-14', warrantyEnd: '2026-02-14' },
  { id: 'A007', name: 'iPhone 15 Pro',                category: 'Phone',      serialNumber: 'SN-IP15P-007',  assignedTo: 'Robert Kim',        dept: 'OPS',         location: 'Field',        status: 'Checked Out', purchased: '2024-01-08', warrantyEnd: '2025-01-08' },
  { id: 'A008', name: 'iPad Pro 12.9" Gen 6',         category: 'Tablet',     serialNumber: 'SN-IPAD-008',   assignedTo: 'Marcus Vance',      dept: 'OPS',         location: 'Field',        status: 'Checked Out', purchased: '2023-09-22', warrantyEnd: '2024-09-22' },
  { id: 'A009', name: 'Logitech MX Keys Keyboard',    category: 'Peripheral', serialNumber: 'SN-LGT-009',    assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2024-02-28', warrantyEnd: '2026-02-28' },
  { id: 'A010', name: 'APC Smart-UPS 1500VA',         category: 'Power',      serialNumber: 'SN-APC-010',    assignedTo: 'IT Rack',           dept: 'IT',          location: 'Server Room',  status: 'Checked Out', purchased: '2022-11-01', warrantyEnd: '2025-11-01' },
  { id: 'A011', name: 'Dell Latitude 5540 Laptop',    category: 'Laptop',     serialNumber: 'SN-LAT54-011',  assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2025-01-15', warrantyEnd: '2028-01-15' },
  { id: 'A012', name: 'HP EliteBook 840 G11',         category: 'Laptop',     serialNumber: 'SN-HPE840-012', assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2025-03-10', warrantyEnd: '2028-03-10' },
  { id: 'A013', name: 'Samsung Galaxy Tab S9',        category: 'Tablet',     serialNumber: 'SN-SGT-013',    assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2025-02-20', warrantyEnd: '2028-02-20' },
  { id: 'A014', name: 'Dell 24" Monitor P2423D',      category: 'Monitor',    serialNumber: 'SN-DEL24-014',  assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2025-04-01', warrantyEnd: '2028-04-01' },
];

// ── Mappers: API (snake_case) ↔ frontend (camelCase) ─────────────────────────

function reqFromApi(r) {
  return {
    id:                   r.id,
    employeeName:         r.employee_name,
    employeeDept:         r.employee_dept,
    item:                 r.item,
    quantity:             r.quantity,
    reason:               r.reason,
    status:               r.status,
    supervisorName:       r.supervisor_name,
    managerName:          r.manager_name || null,
    managerApprovalDate:  r.manager_approval_date || null,
    rejectionReason:      r.rejection_reason || null,
    assetId:              r.asset_id || null,
    assetName:            r.asset_name || null,
    assetCategory:        r.asset_category || null,
    assetSerial:          r.asset_serial || null,
    assetAllocatedDate:   r.asset_allocated_date || null,
    expectedReturnDate:   r.expected_return_date || null,
    allocatedBy:          r.allocated_by || null,
    actualReturnDate:     r.actual_return_date || null,
    returnConfirmedBy:    r.return_confirmed_by || null,
    returnAssetCondition: r.return_asset_condition || null,
    returnPhotoName:      r.return_photo_name || null,
    returnPhotoUrl:       r.return_photo_url  || null,
    history:              r.history || [],
    createdAt:            r.created_at,
    updatedAt:            r.updated_at,
  };
}

function assetFromApi(a) {
  return {
    id:             a.id,
    name:           a.name,
    category:       a.category,
    serialNumber:   a.serial_number,
    assignedTo:     a.assigned_to,
    dept:           a.dept,
    location:       a.location,
    status:         a.status,
    assignedReqId:  a.assigned_req_id || null,
    purchased:      a.purchased,
    warrantyEnd:    a.warranty_end,
    lastUpdated:    a.last_updated,
  };
}

function assetToApi(a) {
  return {
    id:             a.id,
    name:           a.name,
    category:       a.category,
    serial_number:  a.serialNumber || '',
    assigned_to:    a.assignedTo || 'Unassigned',
    dept:           a.dept || '',
    location:       a.location || '',
    status:         a.status || 'Available',
    purchased:      a.purchased || '',
    warranty_end:   a.warrantyEnd || '',
  };
}

// ── Context ───────────────────────────────────────────────────────────────────

const Ctx = createContext(null);

export function RequisitionProvider({ children }) {
  const { accounts } = useMsal();
  const myEmail = (accounts[0]?.username ?? '').toLowerCase();

  const [requisitions, setRequisitions] = useState([]);
  const [hwAssets,     setHwAssets]     = useState([]);

  const ts    = () => new Date().toISOString();
  const today = () => new Date().toISOString().split('T')[0];

  // ── Fetch helpers ──────────────────────────────────────────────────────────

  const refreshRequisitions = () =>
    api.getRequisitions().then(rows => setRequisitions(rows.map(reqFromApi))).catch(() => {});

  const refreshAssets = () =>
    api.getHardwareAssets().then(rows => setHwAssets(rows.map(assetFromApi))).catch(() => {});

  // ── Initial load + one-time localStorage migration ─────────────────────────

  useEffect(() => {
    Promise.all([api.getRequisitions(), api.getHardwareAssets()])
      .then(async ([reqs, assets]) => {
        // Migrate hw_assets from localStorage if DB is empty
        if (assets.length === 0) {
          let seed;
          try { seed = JSON.parse(localStorage.getItem('gn_hw_assets')) || INIT_HW_ASSETS; }
          catch { seed = INIT_HW_ASSETS; }
          await Promise.allSettled(seed.map(a => api.createHardwareAsset(assetToApi(a))));
          localStorage.removeItem('gn_hw_assets');
          const fresh = await api.getHardwareAssets();
          setHwAssets(fresh.map(assetFromApi));
        } else {
          setHwAssets(assets.map(assetFromApi));
        }

        // Migrate requisitions from localStorage if DB is empty
        if (reqs.length === 0) {
          let seed;
          try { seed = JSON.parse(localStorage.getItem('gn_reqs')) || []; }
          catch { seed = []; }
          if (seed.length > 0) {
            await Promise.allSettled(seed.map(r => api.createRequisition({
              id:              r.id,
              employee_name:   r.employeeName,
              employee_dept:   r.employeeDept,
              item:            r.item,
              quantity:        r.quantity,
              reason:          r.reason || '',
              status:          r.status,
              supervisor_name: r.supervisorName || '',
            })));
            localStorage.removeItem('gn_reqs');
          }
          const fresh = await api.getRequisitions();
          setRequisitions(fresh.map(reqFromApi));
        } else {
          setRequisitions(reqs.map(reqFromApi));
        }
      })
      .catch(() => {
        // API unreachable — fall back to localStorage so app still works
        try { setRequisitions(JSON.parse(localStorage.getItem('gn_reqs')) || []); } catch { setRequisitions([]); }
        try { setHwAssets(JSON.parse(localStorage.getItem('gn_hw_assets')) || INIT_HW_ASSETS); } catch { setHwAssets(INIT_HW_ASSETS); }
      });
  }, []);

  // ── Poll every 30s through the authenticated API ──────────────────────────
  // Realtime is intentionally not used here: requisitions and hardware_assets
  // are protected by Supabase RLS (anon key has no SELECT access), so change
  // events would never arrive. Polling via the backend keeps data fresh while
  // keeping all access behind the Azure AD token.

  useEffect(() => {
    const iv = setInterval(() => {
      refreshRequisitions();
      refreshAssets();
    }, 30000);
    return () => clearInterval(iv);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mutations ──────────────────────────────────────────────────────────────

  const submitRequisition = ({ employeeName, employeeDept, item, quantity, reason, employeeEmail, approverEmail }) => {
    const id  = `REQ-${Date.now().toString().slice(-6)}`;
    const now = ts();
    // On-behalf requests are tagged to the BENEFICIARY's email so the
    // requisition shows in their log, not the submitter's.
    const ownerEmail = (employeeEmail || myEmail).toLowerCase();
    const newReq = {
      id, employeeName, employeeDept, item,
      quantity: Number(quantity), reason,
      employeeEmail: ownerEmail,
      status: 'pending_manager',
      supervisorName: DEPT_SUPERVISORS[employeeDept] || 'TBD',
      managerName: null, managerApprovalDate: null, rejectionReason: null,
      assetId: null, assetName: null, assetCategory: null, assetSerial: null,
      assetAllocatedDate: null, expectedReturnDate: null, allocatedBy: null,
      actualReturnDate: null, returnConfirmedBy: null, returnAssetCondition: null,
      history: [{ action: 'Submitted', by: employeeName, role: 'Employee', date: now }],
      createdAt: now, updatedAt: now,
    };
    setRequisitions(prev => [newReq, ...prev]);
    api.createRequisition({
      id, employee_name: employeeName, employee_email: ownerEmail,
      employee_dept: employeeDept, item, quantity: Number(quantity),
      reason: reason || '', status: 'pending_manager',
      supervisor_name: DEPT_SUPERVISORS[employeeDept] || 'TBD',
      approver_email: (approverEmail || '').toLowerCase(),  // backend notifies only this manager
    }).catch(() => setRequisitions(prev => prev.filter(r => r.id !== id)));
    return newReq;
  };

  const approveRequisition = (id, managerName) => {
    setRequisitions(prev => prev.map(r => r.id !== id ? r : {
      ...r, status: 'manager_approved', managerName,
      managerApprovalDate: ts(), updatedAt: ts(),
      history: [...r.history, { action: 'Approved by Manager', by: managerName, role: 'Manager', date: ts() }],
    }));
    api.approveRequisition(id, { manager_name: managerName })
      .then(updated => setRequisitions(prev => prev.map(r => r.id !== id ? r : { ...reqFromApi(updated), history: reqFromApi(updated).history })))
      .catch(refreshRequisitions);
  };

  const rejectRequisition = (id, managerName, reason) => {
    setRequisitions(prev => prev.map(r => r.id !== id ? r : {
      ...r, status: 'rejected', managerName, rejectionReason: reason, updatedAt: ts(),
      history: [...r.history, { action: 'Rejected by Manager', by: managerName, role: 'Manager', comment: reason, date: ts() }],
    }));
    api.rejectRequisition(id, { manager_name: managerName, rejection_reason: reason })
      .catch(refreshRequisitions);
  };

  const allocateAsset = (reqId, assetId, supervisorName, expectedReturnDate) => {
    const asset = hwAssets.find(a => a.id === assetId);
    const req   = requisitions.find(r => r.id === reqId);
    if (!asset || asset.status !== 'Available' || !req) return false;

    setHwAssets(prev => prev.map(a => a.id !== assetId ? a : {
      ...a, status: 'Checked Out', assignedTo: req.employeeName,
      assignedReqId: reqId, lastUpdated: today(),
    }));
    setRequisitions(prev => prev.map(r => r.id !== reqId ? r : {
      ...r, status: 'asset_allocated',
      assetId, assetName: asset.name, assetCategory: asset.category,
      assetSerial: asset.serialNumber || asset.id,
      assetAllocatedDate: ts(), expectedReturnDate, allocatedBy: supervisorName,
      updatedAt: ts(),
      history: [...r.history, { action: 'Asset Allocated', by: supervisorName, role: 'Supervisor', comment: `${asset.name} (${assetId})`, date: ts() }],
    }));
    api.allocateRequisitionAsset(reqId, {
      asset_id: assetId, supervisor_name: supervisorName,
      expected_return_date: expectedReturnDate || '',
    }).catch(() => { refreshRequisitions(); refreshAssets(); });
    return true;
  };

  const initiateReturn = (reqId, initiatedBy) => {
    const req = requisitions.find(r => r.id === reqId);
    if (!req?.assetId) return false;

    setHwAssets(prev => prev.map(a => a.id !== req.assetId ? a : { ...a, status: 'Return Pending', lastUpdated: today() }));
    setRequisitions(prev => prev.map(r => r.id !== reqId ? r : {
      ...r, status: 'return_initiated', updatedAt: ts(),
      history: [...r.history, { action: 'Return Initiated', by: initiatedBy, role: 'Employee/Supervisor', date: ts() }],
    }));
    api.initiateRequisitionReturn(reqId, { initiated_by: initiatedBy })
      .catch(() => { refreshRequisitions(); refreshAssets(); });
    return true;
  };

  const confirmReturn = async (reqId, supervisorName, condition, photoFile) => {
    const req = requisitions.find(r => r.id === reqId);
    if (!req?.assetId) return false;

    const condMap = { Available: 'Available', Damaged: 'Damaged', 'Under Repair': 'Under Repair', Retired: 'Retired' };
    const newStatus = condMap[condition] || 'Available';

    let permanentUrl = '';
    let photoName = '';
    if (photoFile && supabase) {
      const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (ALLOWED_TYPES.includes(photoFile.type) && photoFile.size <= 10 * 1024 * 1024) {
        const ext  = photoFile.type.split('/')[1] || 'jpg';
        const path = `${reqId}/${Date.now()}.${ext}`;
        photoName  = photoFile.name || path;
        const { data: uploaded, error } = await supabase.storage
          .from('return-photos')
          .upload(path, photoFile, { contentType: photoFile.type, upsert: false });
        if (!error && uploaded) {
          const { data: urlData } = supabase.storage.from('return-photos').getPublicUrl(uploaded.path);
          permanentUrl = urlData.publicUrl;
        }
      }
    }

    setHwAssets(prev => prev.map(a => a.id !== req.assetId ? a : {
      ...a, status: newStatus,
      assignedTo: newStatus === 'Available' ? 'Unassigned' : a.assignedTo,
      assignedReqId: null, lastUpdated: today(),
    }));
    setRequisitions(prev => prev.map(r => r.id !== reqId ? r : {
      ...r, status: 'returned', actualReturnDate: ts(),
      returnConfirmedBy: supervisorName, returnAssetCondition: condition,
      returnPhotoName: photoName || null, returnPhotoUrl: permanentUrl || null,
      updatedAt: ts(),
      history: [...r.history, { action: 'Return Confirmed', by: supervisorName, role: 'Supervisor', comment: `Condition: ${condition}`, date: ts() }],
    }));
    api.confirmRequisitionReturn(reqId, {
      supervisor_name: supervisorName,
      condition,
      return_photo_name: photoName,
      return_photo_url:  permanentUrl,
    }).catch(() => { refreshRequisitions(); refreshAssets(); });
    return true;
  };

  const markAssetLost = (reqId, supervisorName, notes) => {
    const req = requisitions.find(r => r.id === reqId);
    if (!req?.assetId) return false;

    setHwAssets(prev => prev.map(a => a.id !== req.assetId ? a : { ...a, status: 'Lost', lastUpdated: today() }));
    setRequisitions(prev => prev.map(r => r.id !== reqId ? r : {
      ...r, status: 'asset_lost', updatedAt: ts(),
      history: [...r.history, { action: 'Asset Marked Lost', by: supervisorName, role: 'Supervisor', comment: notes, date: ts() }],
    }));
    api.markRequisitionLost(reqId, { supervisor_name: supervisorName, notes: notes || '' })
      .catch(() => { refreshRequisitions(); refreshAssets(); });
    return true;
  };

  const addHwAsset = (data) => {
    const id    = `A${Date.now().toString().slice(-6)}`;
    const asset = { id, ...data, assignedReqId: null, lastUpdated: today() };
    setHwAssets(prev => [asset, ...prev]);
    api.createHardwareAsset(assetToApi(asset))
      .then(saved => setHwAssets(prev => prev.map(a => a.id !== id ? a : assetFromApi(saved))))
      .catch(() => setHwAssets(prev => prev.filter(a => a.id !== id)));
    return asset;
  };

  const exportToCsv = () => {
    const headers = [
      'Requisition ID','Employee Name','Employee Department','Manager Name',
      'Department Supervisor','Item Requested','Quantity','Reason','Request Date',
      'Manager Approval Status','Manager Approval Date','Manager Rejection Reason',
      'Asset Allocation Status','Asset Name','Asset Category','Asset Serial / ID',
      'Asset Assigned Date','Expected Return Date','Actual Return Date',
      'Return Confirmed By','Return Asset Condition','Final Status','Notes',
    ];
    const statusLabel = {
      pending_manager: 'Pending Manager Approval',
      rejected: 'Rejected by Manager',
      manager_approved: 'Manager Approved',
      asset_allocated: 'Asset Allocated',
      return_initiated: 'Return Initiated',
      returned: 'Returned & Closed',
      asset_lost: 'Asset Lost',
    };
    const rows = requisitions.map(r => [
      r.id, r.employeeName, r.employeeDept, r.managerName || '',
      r.supervisorName || '', r.item, r.quantity, r.reason,
      r.createdAt ? r.createdAt.split('T')[0] : '',
      r.managerName ? (r.status === 'rejected' ? 'Rejected' : 'Approved') : 'Pending',
      r.managerApprovalDate ? r.managerApprovalDate.split('T')[0] : '',
      r.rejectionReason || '',
      ['asset_allocated','return_initiated','returned','asset_lost'].includes(r.status) ? 'Allocated' : '',
      r.assetName || '', r.assetCategory || '', r.assetSerial || '',
      r.assetAllocatedDate ? r.assetAllocatedDate.split('T')[0] : '',
      r.expectedReturnDate || '',
      r.actualReturnDate ? r.actualReturnDate.split('T')[0] : '',
      r.returnConfirmedBy || '', r.returnAssetCondition || '',
      statusLabel[r.status] || r.status,
      r.history ? r.history.map(h => `${h.action} by ${h.by}`).join('; ') : '',
    ]);
    const csvContent = [headers, ...rows]
      .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `requisitions_${today()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const pendingManagerCount    = requisitions.filter(r => r.status === 'pending_manager').length;
  const pendingAllocationCount = requisitions.filter(r => r.status === 'manager_approved').length;

  return (
    <Ctx.Provider value={{
      requisitions, hwAssets,
      pendingManagerCount, pendingAllocationCount,
      submitRequisition, approveRequisition, rejectRequisition,
      allocateAsset, initiateReturn, confirmReturn, markAssetLost,
      addHwAsset, exportToCsv,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useRequisitions() {
  return useContext(Ctx);
}
