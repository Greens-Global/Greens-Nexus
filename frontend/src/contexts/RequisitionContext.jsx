/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState } from 'react';

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
  { id: 'A001', name: 'Dell XPS 15 Laptop',          category: 'Laptop',    serialNumber: 'SN-XPS15-001',  assignedTo: 'Visesh Lodha',      dept: 'IT',          location: 'Main Office',  status: 'Checked Out', purchased: '2024-03-10', warrantyEnd: '2027-03-10', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A002', name: 'MacBook Pro 14" M3',           category: 'Laptop',    serialNumber: 'SN-MBP14-002',  assignedTo: 'Sarah Johnson',     dept: 'Accounting',  location: 'Main Office',  status: 'Checked Out', purchased: '2024-06-01', warrantyEnd: '2027-06-01', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A003', name: 'Dell UltraSharp 27" Monitor',  category: 'Monitor',   serialNumber: 'SN-DEL27-003',  assignedTo: 'Michael Chen',      dept: 'Development', location: 'Dev Floor',    status: 'Checked Out', purchased: '2023-11-15', warrantyEnd: '2026-11-15', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A004', name: 'HP ProDesk 600 G9 Desktop',    category: 'Desktop',   serialNumber: 'SN-HPD600-004', assignedTo: 'Reception Desk',    dept: 'Admin',       location: 'Front Lobby',  status: 'Checked Out', purchased: '2023-08-20', warrantyEnd: '2026-08-20', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A005', name: 'Cisco Catalyst 2960 Switch',   category: 'Network',   serialNumber: 'SN-CC2960-005', assignedTo: 'IT Rack',           dept: 'IT',          location: 'Server Room',  status: 'Checked Out', purchased: '2022-05-01', warrantyEnd: '2025-05-01', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A006', name: 'Synology DS1823xs+ NAS',       category: 'Server',    serialNumber: 'SN-SYN-006',    assignedTo: 'IT Infrastructure', dept: 'IT',          location: 'Server Room',  status: 'Checked Out', purchased: '2023-02-14', warrantyEnd: '2026-02-14', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A007', name: 'iPhone 15 Pro',                category: 'Phone',     serialNumber: 'SN-IP15P-007',  assignedTo: 'Robert Kim',        dept: 'OPS',         location: 'Field',        status: 'Checked Out', purchased: '2024-01-08', warrantyEnd: '2025-01-08', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A008', name: 'iPad Pro 12.9" Gen 6',         category: 'Tablet',    serialNumber: 'SN-IPAD-008',   assignedTo: 'Marcus Vance',      dept: 'OPS',         location: 'Field',        status: 'Checked Out', purchased: '2023-09-22', warrantyEnd: '2024-09-22', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A009', name: 'Logitech MX Keys Keyboard',    category: 'Peripheral',serialNumber: 'SN-LGT-009',    assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2024-02-28', warrantyEnd: '2026-02-28', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A010', name: 'APC Smart-UPS 1500VA',         category: 'Power',     serialNumber: 'SN-APC-010',    assignedTo: 'IT Rack',           dept: 'IT',          location: 'Server Room',  status: 'Checked Out', purchased: '2022-11-01', warrantyEnd: '2025-11-01', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A011', name: 'Dell Latitude 5540 Laptop',    category: 'Laptop',    serialNumber: 'SN-LAT54-011',  assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2025-01-15', warrantyEnd: '2028-01-15', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A012', name: 'HP EliteBook 840 G11',         category: 'Laptop',    serialNumber: 'SN-HPE840-012', assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2025-03-10', warrantyEnd: '2028-03-10', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A013', name: 'Samsung Galaxy Tab S9',        category: 'Tablet',    serialNumber: 'SN-SGT-013',    assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2025-02-20', warrantyEnd: '2028-02-20', assignedReqId: null, lastUpdated: '2026-05-28' },
  { id: 'A014', name: 'Dell 24" Monitor P2423D',      category: 'Monitor',   serialNumber: 'SN-DEL24-014',  assignedTo: 'Unassigned',        dept: 'IT',          location: 'IT Storage',   status: 'Available',   purchased: '2025-04-01', warrantyEnd: '2028-04-01', assignedReqId: null, lastUpdated: '2026-05-28' },
];

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

const Ctx = createContext(null);

export function RequisitionProvider({ children }) {
  const [requisitions, setRequisitions] = useState(() => load('gn_reqs', []));
  const [hwAssets, setHwAssets]         = useState(() => load('gn_hw_assets', INIT_HW_ASSETS));

  const persist = (r, a) => {
    localStorage.setItem('gn_reqs',      JSON.stringify(r));
    localStorage.setItem('gn_hw_assets', JSON.stringify(a));
  };

  const ts    = () => new Date().toISOString();
  const today = () => new Date().toISOString().split('T')[0];

  const submitRequisition = ({ employeeName, employeeDept, item, quantity, reason }) => {
    const id = `REQ-${Date.now().toString().slice(-6)}`;
    const newReq = {
      id, employeeName, employeeDept, item,
      quantity: Number(quantity), reason,
      status: 'pending_manager',
      supervisorName: DEPT_SUPERVISORS[employeeDept] || 'TBD',
      managerName: null, managerApprovalDate: null, rejectionReason: null,
      assetId: null, assetName: null, assetCategory: null, assetSerial: null,
      assetAllocatedDate: null, expectedReturnDate: null, allocatedBy: null,
      actualReturnDate: null, returnConfirmedBy: null, returnAssetCondition: null,
      history: [{ action: 'Submitted', by: employeeName, role: 'Employee', date: ts() }],
      createdAt: ts(), updatedAt: ts(),
    };
    const r = [newReq, ...requisitions];
    setRequisitions(r);
    persist(r, hwAssets);
    return newReq;
  };

  const approveRequisition = (id, managerName) => {
    const r = requisitions.map(req => req.id !== id ? req : {
      ...req, status: 'manager_approved', managerName,
      managerApprovalDate: ts(), updatedAt: ts(),
      history: [...req.history, { action: 'Approved by Manager', by: managerName, role: 'Manager', date: ts() }],
    });
    setRequisitions(r);
    persist(r, hwAssets);
  };

  const rejectRequisition = (id, managerName, reason) => {
    const r = requisitions.map(req => req.id !== id ? req : {
      ...req, status: 'rejected', managerName,
      rejectionReason: reason, updatedAt: ts(),
      history: [...req.history, { action: 'Rejected by Manager', by: managerName, role: 'Manager', comment: reason, date: ts() }],
    });
    setRequisitions(r);
    persist(r, hwAssets);
  };

  const allocateAsset = (reqId, assetId, supervisorName, expectedReturnDate) => {
    const asset = hwAssets.find(a => a.id === assetId);
    const req   = requisitions.find(r => r.id === reqId);
    if (!asset || asset.status !== 'Available' || !req) return false;

    const a = hwAssets.map(x => x.id !== assetId ? x : {
      ...x, status: 'Checked Out', assignedTo: req.employeeName,
      assignedReqId: reqId, lastUpdated: today(),
    });
    const r = requisitions.map(x => x.id !== reqId ? x : {
      ...x, status: 'asset_allocated',
      assetId, assetName: asset.name, assetCategory: asset.category,
      assetSerial: asset.serialNumber || asset.id,
      assetAllocatedDate: ts(), expectedReturnDate, allocatedBy: supervisorName,
      updatedAt: ts(),
      history: [...x.history, { action: 'Asset Allocated', by: supervisorName, role: 'Supervisor', comment: `${asset.name} (${assetId})`, date: ts() }],
    });
    setHwAssets(a); setRequisitions(r); persist(r, a);
    return true;
  };

  const initiateReturn = (reqId, initiatedBy) => {
    const req = requisitions.find(r => r.id === reqId);
    if (!req?.assetId) return false;

    const a = hwAssets.map(x => x.id !== req.assetId ? x : { ...x, status: 'Return Pending', lastUpdated: today() });
    const r = requisitions.map(x => x.id !== reqId ? x : {
      ...x, status: 'return_initiated', updatedAt: ts(),
      history: [...x.history, { action: 'Return Initiated', by: initiatedBy, role: 'Employee/Supervisor', date: ts() }],
    });
    setHwAssets(a); setRequisitions(r); persist(r, a);
    return true;
  };

  const confirmReturn = (reqId, supervisorName, condition) => {
    const req = requisitions.find(r => r.id === reqId);
    if (!req?.assetId) return false;

    const condMap = { Available: 'Available', Damaged: 'Damaged', 'Under Repair': 'Under Repair', Retired: 'Retired' };
    const newStatus = condMap[condition] || 'Available';

    const a = hwAssets.map(x => x.id !== req.assetId ? x : {
      ...x, status: newStatus,
      assignedTo: newStatus === 'Available' ? 'Unassigned' : x.assignedTo,
      assignedReqId: null, lastUpdated: today(),
    });
    const r = requisitions.map(x => x.id !== reqId ? x : {
      ...x, status: 'returned', actualReturnDate: ts(),
      returnConfirmedBy: supervisorName, returnAssetCondition: condition,
      updatedAt: ts(),
      history: [...x.history, { action: 'Return Confirmed', by: supervisorName, role: 'Supervisor', comment: `Condition: ${condition}`, date: ts() }],
    });
    setHwAssets(a); setRequisitions(r); persist(r, a);
    return true;
  };

  const markAssetLost = (reqId, supervisorName, notes) => {
    const req = requisitions.find(r => r.id === reqId);
    if (!req?.assetId) return false;

    const a = hwAssets.map(x => x.id !== req.assetId ? x : { ...x, status: 'Lost', lastUpdated: today() });
    const r = requisitions.map(x => x.id !== reqId ? x : {
      ...x, status: 'asset_lost', updatedAt: ts(),
      history: [...x.history, { action: 'Asset Marked Lost', by: supervisorName, role: 'Supervisor', comment: notes, date: ts() }],
    });
    setHwAssets(a); setRequisitions(r); persist(r, a);
    return true;
  };

  const addHwAsset = (data) => {
    const nextNum = hwAssets.length + 1;
    const id = `A${String(nextNum).padStart(3, '0')}`;
    const asset = { id, ...data, assignedReqId: null, lastUpdated: today() };
    const a = [asset, ...hwAssets];
    setHwAssets(a);
    persist(requisitions, a);
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
