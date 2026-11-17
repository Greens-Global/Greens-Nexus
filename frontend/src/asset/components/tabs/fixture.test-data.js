// A small portfolio for the tab tests. Today is fixed at 11/17/2026 by each test.
export const TODAY = new Date(2026, 10, 17, 9, 0, 0);

export const ASSETS = [
  {
    id: 'mur', kind: 'property', name: 'Greens Storage, Murrieta', city: 'Murrieta', state: 'CA', devStage: 'Stabilized',
    manager: 'Neil Kadakia', taxDue: '12/10/2026', insExpiration: '2026-08-04',
  },
  {
    id: 'tem', kind: 'property', name: 'Greens Storage, Temecula', city: 'Temecula', state: 'CA', devStage: 'Stabilized - Renovation',
    manager: '', taxDue: '12/10/2026, 11/01/2026',
    timeline: [{ phase: 'Entitlement', permit: 'CUP', agency: 'City', status: 'Complete' }, { phase: 'Permits', permit: 'Grading', agency: 'County', status: 'In Progress' }, { phase: 'X', permit: 'Y', status: 'N/A' }],
    permits: [
      { 'Permit / Approval Type': 'Grading', 'Permit Status': 'Under Review', 'Ball in whose Court': 'Our team', 'Jurisdiction / Agency': 'County', 'Permit Expiration Date': '' },
      { 'Permit / Approval Type': 'Building', 'Permit Status': 'Issued', 'Ball in whose Court': '', 'Permit Expiration Date': '01/15/2027' },
      { 'Permit / Approval Type': 'Fire', 'Permit Status': 'Expired', 'Ball in whose Court': '' },
    ],
    reviewFlags: [{ g: 'Insurance', f: 'Carrier', user: 'Ana Ruiz', reason: 'Looks wrong' }],
  },
  {
    id: 'esc', kind: 'property', name: 'Greens Storage, Escondido (North)', siteName: 'Greens Storage, Escondido', city: 'Escondido', state: 'CA',
    devStage: 'Entitlement', manager: 'neil  kadakia', taxDue: '12/32/3232',
  },
  { id: 'v1', kind: 'vehicle', name: 'Ford Expedition Tremor', make: 'Ford', model: 'Expedition', color: 'White', devStage: 'In Service', manager: 'Archana Kadakia', regExpiration: '2026-12-14', plate: '9ABC123' },
  { id: 'e1', kind: 'equipment', name: 'Scissor Lift', make: 'JLG', model: '1930ES', devStage: 'In Repair', hours: '120', insExpiration: '01/02/2026' },
];

export const STORE = {
  properties: ASSETS,
  warranties: [{ id: 'w1', propertyId: 'mur', expiration: '2027-03-01', scope: 'Roof' }],
  inspections: [], vendors: [], ahj: [], maintenance: [], vdocs: [], documents: [], utilities: [],
  vservice: [{ id: 's1', propertyId: 'v1', date: '2026-07-04', type: 'Oil Change', mileage: '12000' }],
  odometer: [{ id: 'o1', propertyId: 'v1', mileage: '12478', date: '2026-10-01' }],
  logs: [
    { id: 'l1', ts: '2026-11-16T18:00:00.000Z', user: 'Pranshu Pandey', action: 'edited', section: 'Property', property: 'Greens Storage, Murrieta', propertyId: 'mur', item: 'Greens Storage, Murrieta', changes: [{ field: 'Egnyte Folder', from: '', to: '/Shared/Murrieta' }] },
    { id: 'l2', ts: '2026-11-10T18:00:00.000Z', user: 'Neil Kadakia', action: 'added', section: 'Warranties', property: 'Greens Storage, Murrieta', propertyId: 'mur', item: 'Roof' },
    { id: 'l3', ts: '2026-11-01T18:00:00.000Z', user: 'Neil Kadakia', action: 'removed', section: 'Property', property: 'Ford Expedition Tremor', propertyId: 'v1', item: 'Ford Expedition Tremor' },
  ],
};

export const MAINT = {
  properties: [
    { propertyId: 'mur', propertyName: 'Greens Storage, Murrieta', open: 6, total: 9, lastCreatedAt: '2026-11-07T10:00:00Z', preventiveSchedules: 0, preventiveOverdue: 0 },
    { propertyId: 'tem', propertyName: 'Greens Storage, Temecula', open: 1, total: 1, lastCreatedAt: '2026-10-13T10:00:00Z', preventiveSchedules: 2, preventiveOverdue: 1 },
    { propertyId: 'esc', propertyName: 'Greens Storage, Escondido (North)', open: 0, total: 4, lastCreatedAt: '2026-11-05T10:00:00Z', preventiveSchedules: 0, preventiveOverdue: 0 },
  ],
  totals: { open: 7, total: 14, properties: 3, openProperties: 2, preventiveSchedules: 2, preventiveOverdue: 1 },
};
