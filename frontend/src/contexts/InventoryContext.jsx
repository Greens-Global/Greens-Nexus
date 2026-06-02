import { createContext, useContext, useState } from 'react';

const InventoryContext = createContext(null);

const INITIAL_ITEMS = [
  { id: 'INV-001', name: 'Power Drill',            category: 'Tools',            department: 'Construction', available: 3,  total: 5  },
  { id: 'INV-002', name: 'Angle Grinder',           category: 'Tools',            department: 'Construction', available: 2,  total: 4  },
  { id: 'INV-003', name: 'Safety Helmet',           category: 'Safety Equipment', department: 'Construction', available: 10, total: 20 },
  { id: 'INV-004', name: 'Hi-Vis Vest',             category: 'Safety Equipment', department: 'Construction', available: 8,  total: 15 },
  { id: 'INV-005', name: 'Tape Measure (5m)',       category: 'Tools',            department: 'Construction', available: 7,  total: 10 },
  { id: 'INV-006', name: 'Laptop (Dell)',            category: 'IT Supplies',      department: 'IT',           available: 2,  total: 6  },
  { id: 'INV-007', name: 'Network Switch 24-Port',  category: 'IT Supplies',      department: 'IT',           available: 1,  total: 3  },
  { id: 'INV-008', name: 'HDMI Cable (2m)',          category: 'IT Supplies',      department: 'IT',           available: 6,  total: 10 },
  { id: 'INV-009', name: 'Extension Lead (5m)',     category: 'Electrical',       department: 'IT',           available: 4,  total: 7  },
  { id: 'INV-010', name: 'Office Chair',            category: 'Furniture',        department: 'Operations',   available: 3,  total: 8  },
  { id: 'INV-011', name: 'Standing Desk',           category: 'Furniture',        department: 'Operations',   available: 1,  total: 4  },
  { id: 'INV-012', name: 'Printer Paper (Ream)',    category: 'Office Supplies',  department: 'Accounting',   available: 20, total: 50 },
  { id: 'INV-013', name: 'Stapler',                 category: 'Office Supplies',  department: 'Accounting',   available: 5,  total: 8  },
  { id: 'INV-014', name: 'First Aid Kit',           category: 'Safety Equipment', department: 'Operations',   available: 4,  total: 6  },
  { id: 'INV-015', name: 'Projector',               category: 'IT Supplies',      department: 'Marketing',    available: 1,  total: 2  },
];

let reqCounter = 1;
function genId() { return `IREQ-${String(reqCounter++).padStart(3, '0')}`; }

export function InventoryProvider({ children }) {
  const [items] = useState(INITIAL_ITEMS);
  const [requests, setRequests] = useState([]);

  function raiseRequest({ itemId, itemName, requestedBy, department, quantity, reason }) {
    const req = {
      id: genId(),
      itemId, itemName, requestedBy, department, quantity, reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      rejectReason: null,
    };
    setRequests(prev => [req, ...prev]);
  }

  function approveRequest(id, managerName) {
    setRequests(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'approved', resolvedAt: new Date().toISOString(), resolvedBy: managerName } : r
    ));
  }

  function rejectRequest(id, managerName, reason) {
    setRequests(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'rejected', resolvedAt: new Date().toISOString(), resolvedBy: managerName, rejectReason: reason } : r
    ));
  }

  function returnItem(id, { photoUrl, photoName, conditionNote }) {
    setRequests(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'returned', returnedAt: new Date().toISOString(), returnPhotoUrl: photoUrl, returnPhotoName: photoName, conditionNote } : r
    ));
  }

  const pendingCount = requests.filter(r => r.status === 'pending').length;

  return (
    <InventoryContext.Provider value={{ items, requests, pendingCount, raiseRequest, approveRequest, rejectRequest, returnItem }}>
      {children}
    </InventoryContext.Provider>
  );
}

export function useInventory() {
  return useContext(InventoryContext);
}
