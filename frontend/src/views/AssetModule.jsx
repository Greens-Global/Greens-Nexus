// Asset Management — faithful port of Neil's Nexus-AssetManagement.html template.
// Same tabs, same fields, same click behaviour, same design. Seeded from the real
// 14-property portfolio (mapped into the template's flat data model) and persisted
// to localStorage. Navy accent uses var(--pine) so it stays correct in dark mode.
import { useState, useEffect, useRef } from 'react';
import { Plus, X, ArrowLeft, Link2, FileDown, Search, Download, Building2 } from 'lucide-react';

import georgetown from '../data/assets/greens-georgetown.json';
import austin from '../data/assets/greens-austin.json';
import lakeside from '../data/assets/greens-lakeside.json';
import rainbow from '../data/assets/greens-rainbow.json';
import escondidoNorth from '../data/assets/greens-escondido-north.json';
import escondidoSouth from '../data/assets/greens-escondido-south.json';
import sachse from '../data/assets/greens-sachse.json';
import valleyCenterNorth from '../data/assets/greens-valley-center-north.json';
import valleyCenterEast from '../data/assets/valley-center-east.json';
import valleyCenterSouth from '../data/assets/greens-valley-center-south.json';
import greensFamily918 from '../data/assets/greens-family-918-el-camino.json';
import gurudevFamily910 from '../data/assets/gurudev-family-910-el-camino.json';
import rjkResidence from '../data/assets/rjk-residence.json';
import greensFairfield from '../data/assets/greens-fairfield.json';
import { msalInstance } from '../msalInstance';

const RAW = [georgetown, austin, lakeside, rainbow, escondidoNorth, escondidoSouth, sachse,
  valleyCenterNorth, valleyCenterEast, valleyCenterSouth, greensFamily918, gurudevFamily910, rjkResidence, greensFairfield];

/* ---------- helpers ---------- */
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
const num0 = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n; };
const fmtNum = (n) => num0(n) ? num0(n).toLocaleString() : '—';
const fmtMoney = (n) => num0(n) ? '$' + num0(n).toLocaleString() : '—';
const fmtDate = (d) => { if (!d) return '—'; const t = new Date(String(d).slice(0, 10)); return isNaN(t) ? String(d) : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
const dleft = (d) => { if (!d) return null; const t = new Date(String(d).slice(0, 10)); return isNaN(t) ? null : Math.ceil((t - new Date()) / 86400000); };
const currentUser = () => { try { return msalInstance.getAllAccounts()[0]?.username || 'You'; } catch { return 'You'; } };
const uidGen = () => 'x' + Math.random().toString(36).slice(2, 9);
// Read an uploaded image, downscale it and return a compact JPEG data URL (so it
// persists with the property record without bloating storage).
function fileToScaledDataUrl(file, maxDim = 1000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('bad image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- adapt real data -> template model ---------- */
function adapt() {
  const list = [...new Map(RAW.map(p => [p.id, p])).values()];
  const sv = (p, group, prefix) => { for (const g of (p.snapshot || [])) { if (g.group === group) { for (const f of (g.fields || [])) { if ((f.label || '').toLowerCase().startsWith(prefix.toLowerCase())) return f.value || ''; } } } return ''; };
  const groupPrimary = {};
  list.forEach(p => { if (p.group && !groupPrimary[p.group]) groupPrimary[p.group] = p.id; });
  const properties = list.map(p => ({
    id: p.id, name: p.name,
    siteName: p.group || '',
    parentId: (p.group && groupPrimary[p.group] !== p.id) ? groupPrimary[p.group] : '',
    parcelRole: sv(p, 'Project Details', 'Current Use') || p.type || '',
    entity: sv(p, 'Ownership + Core Team', 'Ownership Entity'),
    builder: sv(p, 'Ownership + Core Team', 'GC / CM'),
    manager: p.assetManager || sv(p, 'Ownership + Core Team', 'PM / Asset Manager'),
    address: p.address || sv(p, 'Project Details', 'Property Address'),
    city: sv(p, 'Project Details', 'City'), state: sv(p, 'Project Details', 'State'),
    zip: sv(p, 'Project Details', 'Zip'), county: sv(p, 'Project Details', 'County'),
    apn: sv(p, 'Project Details', 'APN'),
    legalDesc: sv(p, 'Project Details', 'Legal Description'),
    yearBuilt: p.yearBuilt || sv(p, 'Existing Improvements', 'Year Built'),
    constructionType: '', stories: '',
    nrsf: num0(p.buildingSf), gsf: 0,
    acreage: num0(sv(p, 'Site Data', 'Lot Size')),
    zoning: sv(p, 'Zoning + Land Use', 'Zoning'),
    floodZone: sv(p, 'Site Data', 'Flood Zone'),
    sprinklered: sv(p, 'Existing Improvements', 'Sprinklered'),
    alarmMonitored: sv(p, 'Existing Improvements', 'Alarm Monitored'),
    devStage: sv(p, 'Project Details', 'Development Stage'),
    placedInService: '', coNumber: '', coDate: '',
    unitsNonClimate: num0(sv(p, 'Unit Mix', 'Non-Climate')), unitsClimate: num0(sv(p, 'Unit Mix', 'Climate')),
    unitsRV: num0(sv(p, 'Unit Mix', 'RV')), unitsTotal: num0(sv(p, 'Unit Mix', 'Total')),
    insCarrier: sv(p, 'Insurance', 'Insurance Carrier'), insPolicy: sv(p, 'Insurance', 'Policy Number'),
    insExpiration: sv(p, 'Insurance', 'Policy Expiration'), insAgent: sv(p, 'Insurance', 'Insurance Agent'), insPhone: '',
    taxId: sv(p, 'Property Tax', 'Tax Account'), taxAnnual: num0(sv(p, 'Property Tax', 'Annual Tax')), taxDue: sv(p, 'Property Tax', 'Tax Due'),
    notes: '',
    // Full source data so every sheet is viewable in the module (read).
    snapshot: p.snapshot || [], timeline: p.permitsTimeline || [], permits: p.permitMatrix || [],
  }));
  const warranties = [], inspections = [], documents = [], ahj = [], utilities = [], vendors = [];
  list.forEach(p => {
    (p.utilities || []).forEach(u => {
      const uf = (pre) => { const f = (u.fields || []).find(x => (x.label || '').toLowerCase().startsWith(pre.toLowerCase())); return f ? f.value : ''; };
      utilities.push({ id: uidGen(), propertyId: p.id, service: u.name || 'Utility', provider: uf('Authority'), accountNumber: uf('Application'), meterNumber: '', serviceAddress: '', autopay: '', avgMonthly: 0, contactPhone: uf('Phone'), portal: '', notes: uf('Notes') });
    });
    (p.warranties || []).forEach(w => warranties.push({ id: uidGen(), propertyId: p.id, kind: w['Type'], scope: w['Scope / item covered'], party: w['Contractor / manufacturer'], contactName: w['Contact'], phone: w['Phone'], email: w['Email'], startDate: w['Start date'], termMonths: w['Term (months)'], expiration: w['Expiration'], docRef: w['Document location'], coverage: w['Coverage summary'], notes: w['Notes'] }));
    (p.inspections || []).forEach(r => inspections.push({ id: uidGen(), propertyId: p.id, type: r['Inspection type'], frequency: r['Frequency'], ahjRequired: '', vendor: r['Vendor'], vendorPhone: r['Vendor phone'], lastCompleted: r['Last completed'], nextDue: r['Next due'], cost: r['Cost'], notes: r['Notes'] }));
    (p.documents || []).forEach(d => documents.push({ id: uidGen(), propertyId: p.id, category: d.category, title: d.title, dateOf: d.date, version: d.version, location: d.location, notes: d.notes }));
    (p.ahj || []).forEach(a => { const af = (pre) => { const f = (a.fields || []).find(x => (x.label || '').toLowerCase().startsWith(pre.toLowerCase())); return f ? f.value : ''; }; ahj.push({ id: uidGen(), propertyId: p.id, authority: a.name, jurisdiction: af('Authority'), contactName: af('Contact Name'), title: '', phone: af('Phone'), email: af('Email'), portal: '', accountOrPermit: af('Application'), renewalDate: '', notes: af('Notes') }); });
  });
  return { properties, warranties, inspections, documents, ahj, utilities, vendors };
}

const LS_KEY = 'nexus_asset_neil_v2';

// A fully-populated demo property (temp data) so every metric/health-chip/log can be
// seen working. Dates are chosen so warranties/inspections/COI land in each status band.
const DEMO_PROP = {
  id: 'demo-greens-storage', name: 'DEMO — Greens Storage (Sample)', siteName: '', parentId: '',
  parcelRole: 'Primary facility — storage building', entity: 'Oversite Management, Inc.', builder: 'MCD Service Inc.', manager: 'Demo Asset Manager',
  address: '500 Demo Parkway', city: 'Houston', state: 'TX', zip: '77002', county: 'Harris',
  apn: '044-123-000-0099', legalDesc: 'Lot 1, Block A, Demo Subdivision',
  yearBuilt: '2022', constructionType: 'Masonry / structural steel, Type II-B', stories: '3',
  nrsf: 78500, gsf: 91200, acreage: 3.8, zoning: 'Commercial — unzoned (Harris County)',
  floodZone: 'X', sprinklered: 'Yes', alarmMonitored: 'Yes', devStage: 'Active',
  placedInService: '2022-06-15', coNumber: 'CO-2022-04412', coDate: '2022-06-10',
  unitsNonClimate: 420, unitsClimate: 260, unitsRV: 40, unitsTotal: 720,
  insCarrier: 'Liberty Mutual', insPolicy: 'CPP-2299-DEMO', insExpiration: '2027-03-01', insAgent: 'Marsh McLennan — Houston', insPhone: '(713) 555-0162',
  taxId: 'HCAD 0441230000099', taxAnnual: 198000, taxDue: 'Jan 31 (Harris County)',
  notes: 'Sample demo property — temporary data for testing.', image: '',
};
const DEMO_DATA = {
  warranties: [
    { id: 'demo-w1', propertyId: 'demo-greens-storage', kind: 'Manufacturer', scope: 'Roof membrane (TPO)', party: 'Carlisle SynTec', contactName: 'Warranty Dept', phone: '(800) 555-0101', email: 'warranty@carlisle.com', startDate: '2022-06-15', termMonths: '240', expiration: '2042-06-15', docRef: '/Demo/Closeout/Roof-Warranty.pdf', coverage: '20-year NDL membrane warranty.', notes: '' },
    { id: 'demo-w2', propertyId: 'demo-greens-storage', kind: 'Subcontractor', scope: 'Gate operator & access control', party: 'LiftMaster', contactName: 'Service', phone: '(800) 555-0102', email: 'svc@liftmaster.com', startDate: '2024-08-01', termMonths: '24', expiration: '2026-08-01', docRef: '', coverage: '2-year operator warranty.', notes: '' },
    { id: 'demo-w3', propertyId: 'demo-greens-storage', kind: 'Subcontractor', scope: 'Site paving & flatwork', party: 'Lone Star Paving', contactName: 'Office', phone: '(832) 555-0124', email: 'office@lonestar.com', startDate: '2022-06-15', termMonths: '24', expiration: '2024-06-15', docRef: '', coverage: '2-year pavement warranty.', notes: '' },
  ],
  inspections: [
    { id: 'demo-i1', propertyId: 'demo-greens-storage', type: 'Fire alarm — annual test & inspection', frequency: 'Annual', ahjRequired: 'Yes', vendor: 'Allied Fire Protection', vendorPhone: '(281) 555-0190', lastCompleted: '2025-05-01', nextDue: '2026-05-01', cost: '1450', notes: 'NFPA 72.' },
    { id: 'demo-i2', propertyId: 'demo-greens-storage', type: 'Backflow preventer — annual certification', frequency: 'Annual', ahjRequired: 'Yes', vendor: 'Bayou City Backflow', vendorPhone: '(832) 555-0136', lastCompleted: '2025-06-25', nextDue: '2026-06-25', cost: '325', notes: '' },
    { id: 'demo-i3', propertyId: 'demo-greens-storage', type: 'Elevator — annual inspection', frequency: 'Annual', ahjRequired: 'Yes', vendor: 'Texas Elevator Inspections', vendorPhone: '(713) 555-0188', lastCompleted: '2025-12-01', nextDue: '2026-12-01', cost: '600', notes: '' },
  ],
  utilities: [
    { id: 'demo-u1', propertyId: 'demo-greens-storage', service: 'Electric', provider: 'CenterPoint Energy', accountNumber: '12-3456789-0', meterNumber: 'ESI 10443720', serviceAddress: '500 Demo Parkway', autopay: 'Yes — Ramp card', avgMonthly: '2400', contactPhone: '(713) 555-0200', portal: '', notes: '' },
    { id: 'demo-u2', propertyId: 'demo-greens-storage', service: 'Water / Sewer', provider: 'City of Houston', accountNumber: 'WS-998877', meterNumber: 'M-55421', serviceAddress: '500 Demo Parkway', autopay: 'Yes — ACH', avgMonthly: '650', contactPhone: '(713) 555-0201', portal: '', notes: '' },
    { id: 'demo-u3', propertyId: 'demo-greens-storage', service: 'Internet / Phone', provider: 'Comcast Business', accountNumber: 'CB-445566', meterNumber: '', serviceAddress: '500 Demo Parkway', autopay: 'Yes — Ramp card', avgMonthly: '180', contactPhone: '(800) 555-0202', portal: '', notes: '' },
  ],
  vendors: [
    { id: 'demo-v1', propertyId: 'demo-greens-storage', category: 'Fire & Life Safety', company: 'Allied Fire Protection', contactName: 'Service Desk', phone: '(281) 555-0190', email: 'svc@allied.com', contractStart: '2024-01-01', contractEnd: '2026-12-31', coiExpiration: '2026-07-15', monthlyCost: '350', notes: '' },
    { id: 'demo-v2', propertyId: 'demo-greens-storage', category: 'Landscaping', company: 'GreenScape Texas', contactName: 'Crew Lead', phone: '(281) 555-0177', email: 'info@greenscape.com', contractStart: '2025-03-01', contractEnd: '2026-02-28', coiExpiration: '2027-03-01', monthlyCost: '900', notes: '' },
  ],
  documents: [
    { id: 'demo-d1', propertyId: 'demo-greens-storage', category: 'Certificate of Occupancy', title: 'CO — Greens Storage Demo', dateOf: '2022-06-10', version: 'Final', location: '/Demo/CO/CO-2022-04412.pdf', notes: '' },
    { id: 'demo-d2', propertyId: 'demo-greens-storage', category: 'Survey', title: 'ALTA/NSPS Survey', dateOf: '2021-11-15', version: 'Rev 2', location: '/Demo/Survey/ALTA.pdf', notes: '' },
    { id: 'demo-d3', propertyId: 'demo-greens-storage', category: 'As-Built — MEP', title: 'MEP As-Builts', dateOf: '2022-06-01', version: 'Set C', location: '/Demo/AsBuilt/MEP.pdf', notes: '' },
  ],
  ahj: [
    { id: 'demo-a1', propertyId: 'demo-greens-storage', authority: 'Fire Marshal', jurisdiction: 'Harris County Fire Marshal', contactName: 'Inspections', title: '', phone: '(713) 555-0300', email: 'fire@hctx.net', portal: '', accountOrPermit: 'FM-2022-1188', renewalDate: '2026-08-15', notes: '' },
    { id: 'demo-a2', propertyId: 'demo-greens-storage', authority: 'Building Department', jurisdiction: 'Harris County Permits', contactName: 'Permit Desk', title: '', phone: '(713) 555-0301', email: 'permits@hctx.net', portal: '', accountOrPermit: 'BP-2022-0042', renewalDate: '', notes: '' },
  ],
};
// Inject the demo property + its records if missing (keeps any existing data intact).
const withDemo = (d) => {
  if (d.properties.some(p => p.id === DEMO_PROP.id)) return d;
  return {
    ...d,
    properties: [DEMO_PROP, ...d.properties],
    warranties: [...DEMO_DATA.warranties, ...(d.warranties || [])],
    inspections: [...DEMO_DATA.inspections, ...(d.inspections || [])],
    utilities: [...DEMO_DATA.utilities, ...(d.utilities || [])],
    vendors: [...DEMO_DATA.vendors, ...(d.vendors || [])],
    documents: [...DEMO_DATA.documents, ...(d.documents || [])],
    ahj: [...DEMO_DATA.ahj, ...(d.ahj || [])],
    logs: d.logs || [],
  };
};
// Attach the full source sheets (snapshot / timeline / permits) onto each property from
// its original JSON by id — so existing localStorage data gets them without a re-seed.
const RAW_BY_ID = Object.fromEntries(RAW.map(p => [p.id, p]));
const enrichSource = (p) => {
  if (p.snapshot && p.snapshot.length) return p;
  const src = RAW_BY_ID[p.id];
  return src
    ? { ...p, snapshot: src.snapshot || [], timeline: src.permitsTimeline || [], permits: src.permitMatrix || [] }
    : { ...p, snapshot: p.snapshot || [], timeline: p.timeline || [], permits: p.permits || [] };
};
const loadData = () => {
  let d; try { const s = localStorage.getItem(LS_KEY); d = s ? JSON.parse(s) : adapt(); } catch { d = adapt(); }
  d = withDemo(d);
  // Enrich with full source sheets; Development Stage must be one of the 5 standard values.
  return { ...d, properties: d.properties.map(p => { const e = enrichSource(p); return DEV_STAGES.includes(e.devStage) ? e : { ...e, devStage: '' }; }) };
};

/* ---------- collections config (Neil's exact fields + columns) ---------- */
const COLLECTIONS = {
  warranties: {
    title: 'Warranty', plural: 'Warranties', empty: 'No warranties on file. Add subcontractor and equipment warranties from the closeout package.',
    fields: [
      { k: 'kind', label: 'Type', type: 'select', options: ['Subcontractor', 'Manufacturer', 'Equipment'] },
      { k: 'scope', label: 'Scope / item covered', req: true },
      { k: 'party', label: 'Contractor / manufacturer', req: true },
      { k: 'contactName', label: 'Contact' }, { k: 'phone', label: 'Phone' }, { k: 'email', label: 'Email' },
      { k: 'startDate', label: 'Start date', type: 'date' }, { k: 'termMonths', label: 'Term (months)', type: 'number' },
      { k: 'expiration', label: 'Expiration', type: 'date' },
      { k: 'docRef', label: 'Document location (Egnyte path)', full: true },
      { k: 'coverage', label: 'Coverage summary', type: 'textarea', full: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Scope', main: r => r.scope, sub: r => r.kind },
      { label: 'Party', main: r => r.party, sub: r => [r.contactName, r.phone].filter(Boolean).join(' · ') },
      { label: 'Expires', mono: r => fmtDate(r.expiration) },
      { label: 'Status', chip: r => warrantyChip(dleft(r.expiration)) },
    ],
    sort: (a, b) => (a.expiration || '9999') < (b.expiration || '9999') ? -1 : 1,
    summary: rows => [['Active', rows.filter(r => dleft(r.expiration) > 90).length], ['Expiring ≤ 90d', rows.filter(r => { const d = dleft(r.expiration); return d != null && d >= 0 && d <= 90; }).length], ['Expired', rows.filter(r => dleft(r.expiration) != null && dleft(r.expiration) < 0).length]],
  },
  inspections: {
    title: 'Inspection', plural: 'Inspections', empty: 'No inspections scheduled. Add annual and periodic inspections — fire, elevator, backflow, roof PM, stormwater.',
    fields: [
      { k: 'type', label: 'Inspection type', req: true, full: true },
      { k: 'frequency', label: 'Frequency', type: 'select', options: ['Monthly', 'Quarterly', 'Semi-annual', 'Annual', 'Every 3 years', 'Every 5 years', 'One-time'] },
      { k: 'ahjRequired', label: 'AHJ required', type: 'select', options: ['Yes', 'No'] },
      { k: 'vendor', label: 'Vendor' }, { k: 'vendorPhone', label: 'Vendor phone' },
      { k: 'lastCompleted', label: 'Last completed', type: 'date' }, { k: 'nextDue', label: 'Next due', type: 'date', req: true },
      { k: 'cost', label: 'Cost ($)', type: 'number' }, { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Inspection', main: r => r.type, sub: r => r.frequency + (r.ahjRequired === 'Yes' ? ' · AHJ required' : '') },
      { label: 'Vendor', main: r => r.vendor || '—', sub: r => r.vendorPhone || '' },
      { label: 'Last', mono: r => fmtDate(r.lastCompleted) },
      { label: 'Next due', mono: r => fmtDate(r.nextDue) },
      { label: 'Status', chip: r => inspectionChip(dleft(r.nextDue)) },
    ],
    sort: (a, b) => (a.nextDue || '9999') < (b.nextDue || '9999') ? -1 : 1,
    summary: rows => [['Overdue', rows.filter(r => dleft(r.nextDue) != null && dleft(r.nextDue) < 0).length], ['Due ≤ 30d', rows.filter(r => { const d = dleft(r.nextDue); return d != null && d >= 0 && d <= 30; }).length], ['Current', rows.filter(r => dleft(r.nextDue) == null || dleft(r.nextDue) > 30).length]],
  },
  documents: {
    title: 'Document', plural: 'Plans & Documents', empty: 'No documents indexed. Register as-builts, CO, permits, surveys, and O&M manuals with their Egnyte locations.',
    fields: [
      { k: 'category', label: 'Category', type: 'select', options: ['As-Built — Civil', 'As-Built — Architectural', 'As-Built — Structural', 'As-Built — MEP', 'Certificate of Occupancy', 'Permit', 'Survey', 'Geotech', 'O&M Manual', 'Warranty Document', 'Other'] },
      { k: 'title', label: 'Title', req: true },
      { k: 'dateOf', label: 'Document date', type: 'date' }, { k: 'version', label: 'Version / set' },
      { k: 'location', label: 'Location (Egnyte path)', full: true }, { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Document', main: r => r.title, sub: r => r.category + (r.version ? ' · ' + r.version : '') },
      { label: 'Date', mono: r => fmtDate(r.dateOf) },
      { label: 'Location', mono: r => r.location || '—' },
    ],
    sort: (a, b) => (a.category || '') < (b.category || '') ? -1 : 1,
  },
  ahj: {
    title: 'Authority', plural: 'Authorities Having Jurisdiction', empty: 'No authorities on file. Add fire marshal, building department, elevator program, appraisal district, and district operators.',
    fields: [
      { k: 'authority', label: 'Authority type', req: true }, { k: 'jurisdiction', label: 'Jurisdiction / agency', req: true },
      { k: 'contactName', label: 'Contact' }, { k: 'title', label: 'Contact title' }, { k: 'phone', label: 'Phone' }, { k: 'email', label: 'Email' },
      { k: 'portal', label: 'Portal URL' }, { k: 'accountOrPermit', label: 'Account / permit #' },
      { k: 'renewalDate', label: 'Renewal date', type: 'date' }, { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Authority', main: r => r.authority, sub: r => r.jurisdiction },
      { label: 'Contact', main: r => r.contactName || '—', sub: r => [r.phone, r.email].filter(Boolean).join(' · ') },
      { label: 'Account / Permit', mono: r => r.accountOrPermit || '—' },
      { label: 'Renewal', chip: r => r.renewalDate ? renewalChip(dleft(r.renewalDate), fmtDate(r.renewalDate)) : <Chip c="mut">N/A</Chip> },
    ],
    sort: (a, b) => (a.authority || '') < (b.authority || '') ? -1 : 1,
  },
  utilities: {
    title: 'Utility', plural: 'Utilities', empty: 'No utility accounts on file. Add electric, water/sewer, internet, and trash with account and meter numbers.',
    fields: [
      { k: 'service', label: 'Service', req: true }, { k: 'provider', label: 'Provider', req: true },
      { k: 'accountNumber', label: 'Account number', req: true }, { k: 'meterNumber', label: 'Meter / ESI ID' },
      { k: 'serviceAddress', label: 'Service address', full: true },
      { k: 'autopay', label: 'Autopay', type: 'select', options: ['Yes — Ramp card', 'Yes — ACH', 'No'] },
      { k: 'avgMonthly', label: 'Avg monthly ($)', type: 'number' }, { k: 'contactPhone', label: 'Provider phone' },
      { k: 'portal', label: 'Portal URL' }, { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Service', main: r => r.service, sub: r => r.provider },
      { label: 'Account #', mono: r => r.accountNumber || '—' },
      { label: 'Meter / ESI', mono: r => r.meterNumber || '—' },
      { label: 'Autopay', plain: r => r.autopay || '—' },
      { label: 'Avg / mo', mono: r => fmtMoney(r.avgMonthly) },
    ],
    sort: (a, b) => (a.service || '') < (b.service || '') ? -1 : 1,
  },
  vendors: {
    title: 'Vendor', plural: 'Vendors', empty: 'No vendors on file. Add landscaping, pest, fire/life safety, elevator service, and gate/door vendors with contract and COI dates.',
    fields: [
      { k: 'category', label: 'Category', type: 'select', options: ['Fire & Life Safety', 'Elevator Service', 'Landscaping', 'Pest Control', 'Gate & Door Service', 'Access Control / Cameras', 'Janitorial / Porter', 'HVAC Service', 'Roofing', 'Other'] },
      { k: 'company', label: 'Company', req: true }, { k: 'contactName', label: 'Contact' }, { k: 'phone', label: 'Phone' }, { k: 'email', label: 'Email' },
      { k: 'contractStart', label: 'Contract start', type: 'date' }, { k: 'contractEnd', label: 'Contract end', type: 'date' },
      { k: 'coiExpiration', label: 'COI expiration', type: 'date' }, { k: 'monthlyCost', label: 'Monthly cost ($)', type: 'number' },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Vendor', main: r => r.company, sub: r => r.category },
      { label: 'Contact', main: r => r.contactName || '—', sub: r => [r.phone, r.email].filter(Boolean).join(' · ') },
      { label: 'Contract', mono: r => fmtDate(r.contractStart) + ' → ' + fmtDate(r.contractEnd) },
      { label: 'COI', chip: r => r.coiExpiration ? renewalChip(dleft(r.coiExpiration), fmtDate(r.coiExpiration)) : <Chip c="red">Missing</Chip> },
      { label: '$ / mo', mono: r => fmtMoney(r.monthlyCost) },
    ],
    sort: (a, b) => (a.company || '') < (b.company || '') ? -1 : 1,
  },
};

// Property edit form (Neil's PROPERTY_FIELDS).
// The ONLY allowed Development Stage values (standard — do not add others).
const DEV_STAGES = ['Entitlement', 'Construction Drawing', 'Construction', 'Active', 'On Hold'];
const PROPERTY_FIELDS = [
  { sec: 'Identity & ownership' },
  { k: 'name', label: 'Property / parcel name', req: true },
  { k: 'parentId', label: 'Link to (primary parcel) — blank = standalone', type: 'select', dynamic: 'primaries' },
  { k: 'parcelRole', label: 'Parcel role (e.g. RV yard, detention, outparcel)' },
  { k: 'entity', label: 'Operating entity' }, { k: 'builder', label: 'Builder (GC)' }, { k: 'manager', label: 'PM / Asset Manager' },
  { k: 'address', label: 'Street address', req: true },
  { k: 'city', label: 'City' }, { k: 'state', label: 'State' }, { k: 'zip', label: 'ZIP' },
  { k: 'county', label: 'County' }, { k: 'apn', label: 'Parcel / APN' },
  { k: 'legalDesc', label: 'Legal description', full: true },
  { sec: 'Building & site' },
  { k: 'devStage', label: 'Development Stage', type: 'select', options: DEV_STAGES },
  { k: 'yearBuilt', label: 'Year built' }, { k: 'constructionType', label: 'Construction type' }, { k: 'stories', label: 'Stories', type: 'number' },
  { k: 'nrsf', label: 'NRSF', type: 'number' }, { k: 'gsf', label: 'GSF', type: 'number' }, { k: 'acreage', label: 'Acreage', type: 'number' },
  { k: 'zoning', label: 'Zoning / land use' }, { k: 'floodZone', label: 'Flood zone' },
  { k: 'sprinklered', label: 'Sprinklered' }, { k: 'alarmMonitored', label: 'Alarm monitored' },
  { sec: 'Placed in service' },
  { k: 'placedInService', label: 'Placed-in-service date', type: 'date' }, { k: 'coNumber', label: 'CO number' }, { k: 'coDate', label: 'CO date', type: 'date' },
  { sec: 'Unit mix' },
  { k: 'unitsNonClimate', label: 'Non-climate units', type: 'number' }, { k: 'unitsClimate', label: 'Climate units', type: 'number' },
  { k: 'unitsRV', label: 'RV / boat spaces', type: 'number' }, { k: 'unitsTotal', label: 'Total units', type: 'number' },
  { sec: 'Insurance' },
  { k: 'insCarrier', label: 'Carrier' }, { k: 'insPolicy', label: 'Policy #' }, { k: 'insExpiration', label: 'Policy expiration', type: 'date' },
  { k: 'insAgent', label: 'Agent / broker' }, { k: 'insPhone', label: 'Agent phone' },
  { sec: 'Property tax' },
  { k: 'taxId', label: 'Tax account #' }, { k: 'taxAnnual', label: 'Annual tax ($)', type: 'number' }, { k: 'taxDue', label: 'Due dates' },
  { sec: 'Notes' },
  { k: 'notes', label: 'Notes', type: 'textarea', full: true },
];

const TABS = [['portfolio', 'Portfolio'], ['property', 'Property'], ['warranties', 'Warranties'], ['inspections', 'Inspections'], ['documents', 'Plans & Docs'], ['ahj', 'AHJ'], ['utilsvendors', 'Utilities & Vendors'], ['timeline', 'Timeline'], ['permit', 'Permit'], ['logs', 'Logs']];
const LOGS_SEEN_KEY = 'nexus_asset_logs_seen';
// Build one activity-log entry (who/when + the change details).
const mkLog = (e) => ({ id: uidGen(), ts: new Date().toISOString(), user: currentUser(), ...e });
// Human title for a collection row (the first column's main value).
const rowTitle = (coll, r) => { const c = COLLECTIONS[coll].cols[0]; return (c.main ? c.main(r) : c.mono ? c.mono(r) : '') || COLLECTIONS[coll].title; };
// Field-level diff between old and new values for a set of {k,label} fields.
const fieldDiff = (fields, oldObj, newObj) => fields.filter(f => !f.sec)
  .map(f => ({ field: f.label, from: oldObj ? (oldObj[f.k] ?? '') : '', to: newObj[f.k] ?? '' }))
  .filter(c => String(c.from) !== String(c.to));

/* ---------- small UI atoms ---------- */
const CC = { green: 'var(--color-green)', orange: 'var(--color-orange)', red: 'var(--color-red)', blue: 'var(--color-blue)' };
function Chip({ c, children }) {
  if (c === 'mut') return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.72rem', fontWeight: 600, padding: '3px 9px', borderRadius: 999, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)' }}>{children}</span>;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.72rem', fontWeight: 600, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', color: `hsl(${CC[c]})`, backgroundColor: `hsla(${CC[c]}, 0.12)` }}><span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: `hsl(${CC[c]})` }} />{children}</span>;
}
const warrantyChip = (d) => d == null ? <Chip c="mut">No date</Chip> : d < 0 ? <Chip c="mut">Expired</Chip> : d <= 90 ? <Chip c="orange">{`Expires in ${d}d`}</Chip> : <Chip c="green">Active</Chip>;
const inspectionChip = (d) => d == null ? <Chip c="mut">No date</Chip> : d < 0 ? <Chip c="red">{`Overdue ${Math.abs(d)}d`}</Chip> : d <= 30 ? <Chip c="orange">{`Due in ${d}d`}</Chip> : d <= 90 ? <Chip c="orange">Due soon</Chip> : <Chip c="green">Current</Chip>;
const renewalChip = (d, label) => <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}><span style={{ fontFamily: MONO, fontSize: '0.78rem' }}>{label}</span>{d == null ? null : d < 0 ? <Chip c="red">{`Lapsed ${Math.abs(d)}d`}</Chip> : d <= 60 ? <Chip c="orange">{`Renews in ${d}d`}</Chip> : <Chip c="green">Current</Chip>}</span>;
const microLabel = { fontSize: '0.64rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' };

function Stat({ v, l, big }) {
  return <div><div style={{ fontFamily: MONO, fontWeight: big ? 700 : 600, fontSize: big ? '1rem' : '0.82rem', color: 'var(--text-primary)' }}>{v}</div><div style={{ ...microLabel, marginTop: 2 }}>{l}</div></div>;
}

/* ---------- main component ---------- */
export default function AssetModule() {
  const [data, setData] = useState(loadData);
  const [tab, setTab] = useState('portfolio');
  const [activeId, setActiveId] = useState(null);
  const [filters, setFilters] = useState({});
  const [modal, setModal] = useState(null); // { type:'row', coll, id } | { type:'property', id }
  const [logsSeen, setLogsSeen] = useState(() => { try { return localStorage.getItem(LOGS_SEEN_KEY) || ''; } catch { return ''; } });
  const [highlight, setHighlight] = useState(null); // { tab, field, item, n } — flashes a field after "Go to"
  const unseenLogs = (data.logs || []).filter(l => l.ts > logsSeen).length;
  const openTab = (k) => { setTab(k); if (k === 'logs') { const now = new Date().toISOString(); setLogsSeen(now); try { localStorage.setItem(LOGS_SEEN_KEY, now); } catch { /* ignore */ } } };
  // Jump from a log entry straight to the changed field's tab + flash it bright.
  const SECTION_TAB = { 'Property': 'property', 'Warranties': 'warranties', 'Inspections': 'inspections', 'Plans & Documents': 'documents', 'Authorities Having Jurisdiction': 'ahj', 'Utilities': 'utilsvendors', 'Vendors': 'utilsvendors', 'Linking': 'property' };
  const goToChange = (log) => {
    const t = SECTION_TAB[log.section] || 'property';
    if (log.propertyId) setActiveId(log.propertyId);
    setTab(t);
    setHighlight({ tab: t, section: log.section, field: log.changes?.[0]?.field || '', item: log.item || '', n: Date.now() });
  };

  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch { /* ignore */ } }, [data]);
  // While viewing the Logs tab, keep them marked as seen so the badge stays clear.
  useEffect(() => { if (tab === 'logs') { const now = new Date().toISOString(); setLogsSeen(now); try { localStorage.setItem(LOGS_SEEN_KEY, now); } catch { /* ignore */ } } }, [tab, data.logs]);
  // Auto-clear the field highlight a few seconds after a "Go to".
  useEffect(() => { if (highlight) { const id = setTimeout(() => setHighlight(null), 4000); return () => clearTimeout(id); } }, [highlight]);

  const props = data.properties;
  const byId = (id) => props.find(p => p.id === id);
  const isPrimary = (p) => !p.parentId;
  const childrenOf = (id) => props.filter(p => p.parentId === id);
  const familyOf = (p) => { const root = p.parentId ? byId(p.parentId) || p : p; return [root, ...childrenOf(root.id)]; };
  const active = activeId ? byId(activeId) : null;
  const rowsFor = (coll) => (data[coll] || []).filter(r => r.propertyId === activeId);

  const openProperty = (id) => { setActiveId(id); setTab('property'); };
  const assetAgg = (fam) => ({
    nrsf: fam.reduce((s, p) => s + num0(p.nrsf), 0), units: fam.reduce((s, p) => s + num0(p.unitsTotal), 0),
    rv: fam.reduce((s, p) => s + num0(p.unitsRV), 0), acres: fam.reduce((s, p) => s + num0(p.acreage), 0).toFixed(2),
  });
  const parcelHealth = (pid) => {
    const over = data.inspections.filter(r => r.propertyId === pid && dleft(r.nextDue) != null && dleft(r.nextDue) < 0).length;
    const due = data.inspections.filter(r => r.propertyId === pid && dleft(r.nextDue) != null && dleft(r.nextDue) >= 0 && dleft(r.nextDue) <= 30).length;
    const expW = data.warranties.filter(r => r.propertyId === pid && dleft(r.expiration) != null && dleft(r.expiration) >= 0 && dleft(r.expiration) <= 90).length;
    return { over, due, expW };
  };
  const assetHealth = (fam) => fam.reduce((a, p) => { const h = parcelHealth(p.id); a.over += h.over; a.due += h.due; a.expW += h.expW; return a; }, { over: 0, due: 0, expW: 0 });

  /* ----- mutations (each records an activity-log entry) ----- */
  const pushLog = (d, entry) => ({ ...d, logs: [mkLog(entry), ...(d.logs || [])] });
  const saveRow = (coll, id, values) => {
    setData(d => {
      const arr = [...d[coll]];
      const prop = d.properties.find(p => p.id === activeId);
      const base = { section: COLLECTIONS[coll].plural, property: prop?.name || '', propertyId: activeId };
      let entry;
      if (id) {
        const i = arr.findIndex(r => r.id === id);
        if (i >= 0) { const old = arr[i]; const changes = fieldDiff(COLLECTIONS[coll].fields, old, values); arr[i] = { ...old, ...values }; if (changes.length) entry = { ...base, action: 'edited', item: rowTitle(coll, arr[i]), changes }; }
      } else { const nr = { id: uidGen(), propertyId: activeId, ...values }; arr.push(nr); entry = { ...base, action: 'added', item: rowTitle(coll, nr), changes: [] }; }
      const nd = { ...d, [coll]: arr };
      return entry ? pushLog(nd, entry) : nd;
    });
    setModal(null);
  };
  const deleteRow = (coll, id) => {
    setData(d => {
      const row = d[coll].find(r => r.id === id); const prop = d.properties.find(p => p.id === activeId);
      const nd = { ...d, [coll]: d[coll].filter(r => r.id !== id) };
      return row ? pushLog(nd, { section: COLLECTIONS[coll].plural, property: prop?.name || '', propertyId: activeId, action: 'removed', item: rowTitle(coll, row), changes: [] }) : nd;
    });
    setModal(null);
  };
  const saveProperty = (id, values, reason) => {
    setData(d => {
      const arr = [...d.properties]; let entry;
      if (id) {
        const i = arr.findIndex(p => p.id === id);
        if (i >= 0) { const old = arr[i]; const changes = fieldDiff(PROPERTY_FIELDS, old, values); arr[i] = { ...old, ...values }; if (changes.length) entry = { section: 'Property', property: arr[i].name, propertyId: id, action: 'edited', item: arr[i].name, changes, reason: reason || '' }; }
      } else { const np = { id: uidGen(), parentId: '', siteName: '', ...values }; arr.push(np); setTimeout(() => setActiveId(np.id), 0); entry = { section: 'Property', property: np.name, propertyId: np.id, action: 'added', item: np.name, changes: [] }; }
      const nd = { ...d, properties: arr };
      return entry ? pushLog(nd, entry) : nd;
    });
    setModal(null);
  };
  // Delete a property; any ancillary parcels linked to it become standalone (not orphaned).
  const deleteProperty = (id) => {
    setData(d => {
      const p = d.properties.find(x => x.id === id);
      const nd = { ...d, properties: d.properties.filter(x => x.id !== id).map(x => x.parentId === id ? { ...x, parentId: '' } : x) };
      return p ? pushLog(nd, { section: 'Property', property: p.name, propertyId: id, action: 'removed', item: p.name, changes: [] }) : nd;
    });
    if (activeId === id) { setActiveId(null); setTab('portfolio'); }
    setModal(null);
  };
  // Link the ticked properties into a named site. First ticked = primary parcel; the rest
  // link under it. Properties dropped from this site become standalone again.
  const linkProperties = (siteName, memberIds) => {
    const name = (siteName || '').trim();
    const primary = memberIds[0];
    setData(d => {
      const names = d.properties.filter(p => memberIds.includes(p.id)).map(p => p.name);
      const nd = { ...d, properties: d.properties.map(p => {
        if (memberIds.includes(p.id)) return { ...p, siteName: name, parentId: p.id === primary ? '' : primary };
        if (name && p.siteName === name) return { ...p, siteName: '', parentId: '' };
        return p;
      }) };
      return pushLog(nd, { section: 'Linking', property: name, propertyId: primary, action: 'linked', item: name, changes: [{ field: 'Parcels', from: '', to: names.join(', ') }] });
    });
    setModal(null);
  };

  /* ----- render ----- */
  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* brandbar with KPI stats (Neil's statbar) */}
      {(() => {
        const st = headerStats(data);
        const cells = [['Assets', st.assets, false], ['Parcels', st.parcels, false], ['Active warranties', st.warr, false], ['Inspections ≤ 60d', st.insp, st.insp > 0], ['Expiring ≤ 90d', st.exp, st.exp > 0]];
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', padding: '14px 18px', marginBottom: 16, borderRadius: 14, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)' }}>
            <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Asset Management</strong>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {cells.map(([l, v, warn]) => (
                <div key={l}><div style={{ fontFamily: MONO, fontWeight: 700, fontSize: '1.2rem', color: warn ? 'hsl(var(--color-orange))' : 'var(--text-primary)' }}>{v}</div><div style={microLabel}>{l}</div></div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <button className="secondary-btn" onClick={() => exportAllJSON(data)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={14} /> Export</button>
              <button className="secondary-btn" onClick={() => setModal({ type: 'link' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Link2 size={14} /> Link Properties</button>
              <button className="primary-btn" onClick={() => setModal({ type: 'property', id: null })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add property</button>
            </div>
          </div>
        );
      })()}

      {/* Per-property tabs — only when a property is selected (Portfolio is the landing) */}
      {active && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', overflowX: 'auto', alignItems: 'center' }}>
            <button onClick={() => { setActiveId(null); setTab('portfolio'); }} title="Back to portfolio"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', borderRadius: 999, border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <ArrowLeft size={14} /> Portfolio
            </button>
            {TABS.filter(([k]) => k !== 'portfolio').map(([k, label]) => {
              const on = tab === k;
              return (
                <button key={k} onClick={() => openTab(k)}
                  style={{ position: 'relative', padding: '8px 16px', borderRadius: 999, border: '1px solid', borderColor: on ? 'var(--pine)' : 'var(--border-color)', background: on ? 'var(--pine)' : 'var(--bg-card)', color: on ? '#fff' : 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  {label}
                  {k === 'logs' && unseenLogs > 0 && <span style={{ position: 'absolute', top: -5, right: -4, minWidth: 17, height: 17, padding: '0 4px', borderRadius: 999, fontSize: '0.62rem', fontWeight: 700, color: '#fff', backgroundColor: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--bg-primary)' }}>{unseenLogs}</span>}
                </button>
              );
            })}
          </div>
          {tab !== 'logs' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 'auto' }}>
              <span style={microLabel}>Parcel</span>
              <select value={activeId} onChange={e => setActiveId(e.target.value)} className="form-input" style={{ width: 'auto', padding: '6px 10px', fontSize: '0.82rem' }}>
                {props.filter(isPrimary).map(pr => {
                  const fam = familyOf(pr);
                  return fam.length > 1
                    ? <optgroup key={pr.id} label={pr.name}>{fam.map(x => <option key={x.id} value={x.id}>{isPrimary(x) ? `${x.name} (primary)` : `↳ ${x.name}`}</option>)}</optgroup>
                    : <option key={pr.id} value={pr.id}>{pr.name}</option>;
                })}
              </select>
            </div>
          )}
        </div>
      )}

      {tab === 'portfolio' && !active && <Portfolio {...{ props, isPrimary, familyOf, assetAgg, assetHealth, parcelHealth, openProperty, onEdit: (id) => setModal({ type: 'property', id }) }} />}
      {tab === 'property' && active && <PropertyDetail {...{ p: active, familyOf, isPrimary, childrenOf, assetAgg, openProperty, onEdit: () => setModal({ type: 'property', id: active.id }), onExport: () => exportReport(active, data), highlight: highlight?.tab === 'property' ? highlight : null }} />}
      {tab === 'warranties' && active && <Collection coll="warranties" rows={rowsFor('warranties')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'warranties' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'warranties', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'warranties', id })} />}
      {tab === 'inspections' && active && <Collection coll="inspections" rows={rowsFor('inspections')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'inspections' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'inspections', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'inspections', id })} />}
      {tab === 'documents' && active && <Collection coll="documents" rows={rowsFor('documents')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'documents' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'documents', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'documents', id })} />}
      {tab === 'ahj' && active && <Collection coll="ahj" rows={rowsFor('ahj')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'ahj' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'ahj', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'ahj', id })} />}
      {tab === 'utilsvendors' && active && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Collection coll="utilities" rows={rowsFor('utilities')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.section === 'Utilities' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'utilities', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'utilities', id })} />
          <Collection coll="vendors" rows={rowsFor('vendors')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.section === 'Vendors' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'vendors', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'vendors', id })} />
        </div>
      )}
      {tab === 'timeline' && active && <ReadTable title="Development Timeline" subtitle={active.name} rows={active.timeline} cols={[['phase', 'Phase'], ['permit', 'Permit / Approval'], ['agency', 'Issuing Agency'], ['whenRequired', 'When Required'], ['submittals', 'Key Submittals'], ['reviewTime', 'Review Time'], ['notes', 'Notes']]} />}
      {tab === 'permit' && active && <ReadTable title="Permit Matrix" subtitle={active.name} rows={active.permits} />}
      {tab === 'logs' && <LogsTab logs={data.logs || []} onOpenProperty={openProperty} activeId={activeId} activeName={active ? (active.siteName || active.name) : ''} onGoTo={goToChange} />}

      {modal?.type === 'row' && <RowModal coll={modal.coll} row={modal.id ? data[modal.coll].find(r => r.id === modal.id) : null} onSave={(v) => saveRow(modal.coll, modal.id, v)} onDelete={() => deleteRow(modal.coll, modal.id)} onClose={() => setModal(null)} />}
      {modal?.type === 'property' && <PropertyModal row={modal.id ? byId(modal.id) : null} properties={props} onSave={(v, reason) => saveProperty(modal.id, v, reason)} onDelete={() => deleteProperty(modal.id)} onClose={() => setModal(null)} />}
      {modal?.type === 'link' && <LinkModal properties={props} onSave={linkProperties} onClose={() => setModal(null)} />}
    </div>
  );
}

/* ---------- portfolio ---------- */
// Colour for a Development Stage chip.
const stageColor = (s) => {
  const v = (s || '').toLowerCase();
  if (v.includes('hold')) return 'red';
  if (v.includes('active') || v.includes('built') || v.includes('in-use') || v.includes('in use') || v.includes('open') || v.includes('operat') || v.includes('developed')) return 'green';
  if (v.includes('construction')) return 'orange';
  if (v.includes('entitle')) return 'blue';
  return 'gold';
};
function Portfolio({ props, isPrimary, familyOf, assetAgg, assetHealth, parcelHealth, openProperty, onEdit }) {
  const primaries = props.filter(isPrimary);
  if (!primaries.length) return <Empty>No properties yet. Use “Add property” to register the first asset.</Empty>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 18 }}>
      {primaries.map(pr => {
        const fam = familyOf(pr); const agg = assetAgg(fam); const h = assetHealth(fam);
        const chips = [];
        if (pr.devStage) chips.push(<Chip key="stage" c={stageColor(pr.devStage)}>{pr.devStage}</Chip>);
        if (h.over) chips.push(<Chip key="o" c="red">{h.over} inspection{h.over > 1 ? 's' : ''} overdue</Chip>);
        if (h.due) chips.push(<Chip key="d" c="orange">{h.due} due ≤ 30d</Chip>);
        if (h.expW) chips.push(<Chip key="w" c="orange">{h.expW} warrant{h.expW > 1 ? 'ies' : 'y'} expiring</Chip>);
        return (
          <div key={pr.id} onClick={() => openProperty(pr.id)} title="Open asset"
            style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: 22, display: 'flex', flexDirection: 'column', gap: 16, cursor: 'pointer', transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-hover)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; e.currentTarget.style.transform = ''; }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
                <span style={{ flexShrink: 0, width: 40, height: 40, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pine)', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}><Building2 size={20} /></span>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontSize: '1.08rem', fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)', marginBottom: 4, lineHeight: 1.25 }}>{pr.siteName || pr.name}</h3>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{[pr.address, pr.city, pr.state].filter(Boolean).join(', ') || '—'}</div>
                  {pr.entity && <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{pr.entity}</div>}
                </div>
              </div>
              <span style={{ flexShrink: 0, fontSize: '0.72rem', fontWeight: 600, padding: '4px 11px', borderRadius: 999, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>{fam.length} parcel{fam.length > 1 ? 's' : ''}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {fam.map((c, i) => <ParcelRow key={c.id} p={c} primary={i === 0} health={parcelHealth(c.id)} onOpen={openProperty} />)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px 8px', borderTop: '1px solid var(--border-color)', paddingTop: 15 }}>
              <Stat big v={fmtNum(agg.nrsf)} l="Asset NRSF" /><Stat big v={fmtNum(agg.units)} l="Total units" />
              <Stat big v={agg.rv ? fmtNum(agg.rv) : '—'} l="RV / Boat" /><Stat big v={agg.acres} l="Acres" />
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{chips}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
              <button className="primary-btn" onClick={(e) => { e.stopPropagation(); openProperty(pr.id); }} style={{ padding: '8px 16px', fontSize: '0.8rem' }}>Open asset</button>
              <button className="secondary-btn" onClick={(e) => { e.stopPropagation(); onEdit(pr.id); }} style={{ padding: '8px 16px', fontSize: '0.8rem' }}>Edit</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
function ParcelRow({ p, primary, health, onOpen }) {
  const dot = health.over ? <Chip c="red">{health.over}</Chip> : (health.due + health.expW ? <Chip c="orange">{health.due + health.expW}</Chip> : null);
  return (
    <div onClick={(e) => { e.stopPropagation(); onOpen(p.id); }} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 10, cursor: 'pointer', border: '1px solid var(--border-color)', borderLeft: primary ? '3px solid var(--pine)' : '1px solid var(--border-color)', backgroundColor: primary ? 'var(--bg-secondary)' : 'var(--bg-card)', marginLeft: primary ? 0 : 22 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          {primary && <span style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 5, color: '#fff', backgroundColor: 'var(--pine)' }}>Primary</span>}
          <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{p.name}</strong>
          {!primary && p.parcelRole && <span style={{ fontSize: '0.66rem', fontWeight: 600, padding: '2px 7px', borderRadius: 5, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)' }}>{p.parcelRole}</span>}
        </div>
        <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2, fontFamily: MONO }}>APN {p.apn || '—'}{p.acreage ? ` · ${p.acreage} ac` : ''}</div>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', whiteSpace: 'nowrap' }}>
        {num0(p.nrsf) > 0 && <Stat v={fmtNum(p.nrsf)} l="NRSF" />}
        {num0(p.unitsTotal) > 0 ? <Stat v={fmtNum(p.unitsTotal)} l="Units" /> : num0(p.unitsRV) > 0 ? <Stat v={fmtNum(p.unitsRV)} l="RV / Boat" /> : null}
        {dot}
      </div>
    </div>
  );
}

/* ---------- property detail ---------- */
function PropertyDetail({ p, familyOf, isPrimary, childrenOf, assetAgg, openProperty, onEdit, onExport, highlight }) {
  const hlField = (highlight?.field || '').toLowerCase();
  const fam = familyOf(p);
  // Show the FULL property snapshot (every group + field from the Excel). For properties
  // without a snapshot (demo / manually added) fall back to the flat fields.
  const has = (...vals) => vals.some(v => v !== '' && v != null && v !== 0);
  let sections = (p.snapshot && p.snapshot.length)
    ? p.snapshot.map((g, i) => ({ n: i + 1, title: g.group, fields: (g.fields || []).map(f => [f.label, f.value]) }))
    : [
      { n: 1, title: 'Identity & ownership', fields: [['Parcel role', p.parcelRole], ['Operating entity', p.entity], ['Builder (GC)', p.builder], ['Asset manager', p.manager], ['Street address', p.address], ['City', p.city], ['State', p.state], ['County', p.county], ['ZIP', p.zip], ['APN', p.apn], ['Legal description', p.legalDesc]] },
      { n: 2, title: 'Building & site', fields: [['Year built', p.yearBuilt], ['Construction', p.constructionType], ['Stories', p.stories], ['NRSF', p.nrsf ? fmtNum(p.nrsf) : ''], ['GSF', p.gsf ? fmtNum(p.gsf) : ''], ['Acreage', p.acreage], ['Zoning / land use', p.zoning], ['Flood zone', p.floodZone], ['Sprinklered', p.sprinklered], ['Alarm monitored', p.alarmMonitored], ['Development stage', p.devStage]] },
    ];
  if (has(p.unitsNonClimate, p.unitsClimate, p.unitsRV, p.unitsTotal)) sections.push({ n: null, title: 'Unit mix', fields: [['Non-climate', p.unitsNonClimate || ''], ['Climate-controlled', p.unitsClimate || ''], ['RV / boat', p.unitsRV || ''], ['Total units', p.unitsTotal || '']] });
  if (has(p.insCarrier, p.insPolicy, p.insExpiration, p.insAgent)) sections.push({ n: null, title: 'Insurance', fields: [['Carrier', p.insCarrier], ['Policy #', p.insPolicy], ['Policy expiration', fmtDateBlank(p.insExpiration)], ['Agent / broker', [p.insAgent, p.insPhone].filter(Boolean).join(' · ')]] });
  if (has(p.taxId, p.taxAnnual, p.taxDue)) sections.push({ n: null, title: 'Property tax', fields: [['Tax account', p.taxId], ['Annual tax', p.taxAnnual ? fmtMoney(p.taxAnnual) : ''], ['Due dates', p.taxDue]] });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {fam.length > 1 && (
        <Panel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Link2 size={15} style={{ color: 'hsl(var(--color-purple))' }} />
            <strong style={{ fontSize: '0.85rem' }}>Linked parcels — {fam[0].siteName || fam[0].name}</strong>
            <span style={{ ...microLabel, marginLeft: 'auto' }}>{fam.length} parcels · {fmtNum(assetAgg(fam).nrsf)} NRSF · {fmtNum(assetAgg(fam).units)} units · {assetAgg(fam).acres} ac</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {fam.map(x => { const cur = x.id === p.id; return (
              <button key={x.id} onClick={() => openProperty(x.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 13px', borderRadius: 999, cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, color: cur ? 'var(--text-primary)' : 'var(--text-secondary)', backgroundColor: 'var(--bg-card)', border: '1px solid', borderColor: cur ? 'var(--pine)' : 'var(--border-color)', boxShadow: cur ? '0 0 0 1px var(--pine)' : 'none' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: isPrimary(x) ? 'var(--pine)' : 'var(--border-hover)' }} />{x.name}{isPrimary(x) ? ' · Primary' : ''}
              </button>
            ); })}
          </div>
        </Panel>
      )}
      <Panel>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '-0.01em' }}>{p.name}</h2>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: 2 }}>{[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}{p.county ? ` · ${p.county} County` : ''} · APN {p.apn || '—'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="secondary-btn" onClick={onExport} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileDown size={14} /> Export PDF</button>
            <button className="primary-btn" onClick={onEdit} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>Edit property</button>
          </div>
        </div>
        {p.image && <img src={p.image} alt={p.name} loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} style={{ width: 260, height: 160, objectFit: 'cover', borderRadius: 10, marginTop: 14, border: '1px solid var(--border-color)', display: 'block' }} />}
      </Panel>
      {sections.map((s, i) => (
        <Panel key={i}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--border-color)' }}>
            {s.n != null && <span style={{ width: 22, height: 22, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: '0.72rem', fontWeight: 700, color: '#fff', backgroundColor: 'var(--pine)' }}>{s.n}</span>}
            <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{s.title}</strong>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(185px, 1fr))', gap: '14px 22px' }}>
            {s.fields.map(([label, value], j) => {
              const hl = hlField && label.toLowerCase() === hlField;
              return (
                <div key={j} ref={hl ? (el => el && el.scrollIntoView({ behavior: 'smooth', block: 'center' })) : null}
                  style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: hl ? '6px 9px' : 0, margin: hl ? '-6px -9px' : 0, borderRadius: 8, transition: 'background-color 0.3s', backgroundColor: hl ? 'hsla(var(--color-gold), 0.22)' : 'transparent', boxShadow: hl ? '0 0 0 2px hsl(var(--color-gold))' : 'none' }}>
                  <span style={microLabel}>{label}</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word', fontFamily: looksNumeric(value) ? MONO : undefined }}>{(value ?? '') === '' ? '—' : value}</span>
                </div>
              );
            })}
          </div>
        </Panel>
      ))}
    </div>
  );
}

/* ---------- generic collection ---------- */
function Collection({ coll, rows, active, filters, setFilters, onAdd, onEdit, highlightItem }) {
  const cfg = COLLECTIONS[coll];
  const q = (filters[coll] || '').toLowerCase();
  let list = rows.slice().sort(cfg.sort);
  if (q) list = list.filter(r => JSON.stringify(r).toLowerCase().includes(q));
  const sum = cfg.summary ? cfg.summary(rows) : null;
  return (
    <Panel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{cfg.plural}</strong>
        <span style={microLabel}>{active.name}</span>
        <button className="primary-btn" onClick={onAdd} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: '0.8rem' }}><Plus size={14} /> Add {cfg.title.toLowerCase()}</button>
      </div>
      {sum && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {sum.map(([l, v]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
              <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>{v}</span><span style={microLabel}>{l}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ position: 'relative', marginBottom: 12, maxWidth: 320 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
        <input className="form-input" placeholder="Filter…" value={filters[coll] || ''} onChange={e => setFilters(f => ({ ...f, [coll]: e.target.value }))} style={{ paddingLeft: 32, fontSize: '0.82rem' }} />
      </div>
      {list.length ? (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead><tr>{cfg.cols.map(c => <th key={c.label} style={{ ...microLabel, textAlign: 'left', padding: '10px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>{c.label}</th>)}<th style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }} /></tr></thead>
            <tbody>
              {list.map(r => {
                const hl = highlightItem && rowTitle(coll, r) === highlightItem;
                return (
                <tr key={r.id} onClick={() => onEdit(r.id)} ref={hl ? (el => el && el.scrollIntoView({ behavior: 'smooth', block: 'center' })) : null}
                  style={{ cursor: 'pointer', transition: 'background-color 0.3s', background: hl ? 'hsla(var(--color-gold), 0.2)' : '', boxShadow: hl ? 'inset 3px 0 0 hsl(var(--color-gold))' : 'none' }}
                  onMouseEnter={e => { if (!hl) e.currentTarget.style.background = 'var(--bg-secondary)'; }} onMouseLeave={e => { if (!hl) e.currentTarget.style.background = ''; }}>
                  {cfg.cols.map((c, i) => (
                    <td key={i} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                      {c.main ? <><div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{c.main(r) || '—'}</div>{c.sub && c.sub(r) ? <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 1 }}>{c.sub(r)}</div> : null}</>
                        : c.mono ? <span style={{ fontFamily: MONO, fontSize: '0.78rem' }}>{c.mono(r)}</span>
                          : c.chip ? c.chip(r) : <span>{c.plain(r)}</span>}
                    </td>
                  ))}
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-color)', textAlign: 'right' }}><button className="secondary-btn" onClick={e => { e.stopPropagation(); onEdit(r.id); }} style={{ padding: '4px 10px', fontSize: '0.74rem' }}>Edit</button></td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <Empty>{cfg.empty}</Empty>}
    </Panel>
  );
}

/* ---------- modals ---------- */
function FormField({ f, value, onChange }) {
  const common = { className: 'form-input', value: value ?? '', onChange: e => onChange(f.k, e.target.value), style: { fontSize: '0.85rem' } };
  let input;
  if (f.type === 'select') {
    const opts = (f.options || []).map(o => (typeof o === 'string' ? { v: o, l: o } : o));
    input = <select {...common}>{!opts.some(o => o.v === '') && <option value="">Select…</option>}{opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>;
  }
  else if (f.type === 'textarea') input = <textarea {...common} rows={2} />;
  else if (f.type === 'date') input = <input type="date" {...common} />;
  else if (f.type === 'number') input = <input type="text" inputMode="decimal" {...common} />;
  else input = <input type="text" {...common} />;
  return <div className={f.full ? 'form-group form-group-full' : 'form-group'}><label>{f.label}{f.req ? <span style={{ color: 'hsl(var(--color-red))' }}> *</span> : ''}</label>{input}</div>;
}
function useForm(fields, row) {
  const init = {}; fields.forEach(f => { if (!f.sec) init[f.k] = row ? (row[f.k] ?? '') : ''; });
  return useState(init);
}
function RowModal({ coll, row, onSave, onDelete, onClose }) {
  const cfg = COLLECTIONS[coll];
  const [vals, setVals] = useForm(cfg.fields, row);
  const set = (k, v) => setVals(s => ({ ...s, [k]: v }));
  const submit = () => { for (const f of cfg.fields) if (f.req && !String(vals[f.k] || '').trim()) { alert('Please fill: ' + f.label); return; } onSave(vals); };
  return (
    <Modal title={(row ? 'Edit ' : 'Add ') + cfg.title.toLowerCase()} onClose={onClose}
      footer={<>
        {row && <button className="secondary-btn" onClick={onDelete} style={{ marginRight: 'auto', color: 'hsl(var(--color-red))' }}>Delete</button>}
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={submit}>Save</button>
      </>}>
      <div className="form-grid">{cfg.fields.map(f => <FormField key={f.k} f={f} value={vals[f.k]} onChange={set} />)}</div>
    </Modal>
  );
}
// Address fields that need a reason when an EXISTING property is edited.
const ADDRESS_FIELDS = [['address', 'Street address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['county', 'County']];
function PropertyModal({ row, properties, onSave, onDelete, onClose }) {
  const flat = PROPERTY_FIELDS.filter(f => !f.sec);
  const [vals, setVals] = useState(() => { const init = { image: row?.image || '' }; flat.forEach(f => { init[f.k] = row ? (row[f.k] ?? '') : ''; }); return init; });
  const [reason, setReason] = useState('');
  const fileRef = useRef(null);
  const set = (k, v) => setVals(s => ({ ...s, [k]: v }));
  const onPickImage = async (e) => { const f = e.target.files?.[0]; if (f && f.type.startsWith('image/')) { try { set('image', await fileToScaledDataUrl(f)); } catch { /* ignore */ } } e.target.value = ''; };
  // Which address fields changed (only matters when editing an existing property).
  const changedAddr = row ? ADDRESS_FIELDS.filter(([k]) => String(row[k] ?? '') !== String(vals[k] ?? '')) : [];
  const needReason = changedAddr.length > 0;
  const submit = () => {
    for (const f of flat) if (f.req && !String(vals[f.k] || '').trim()) { alert('Please fill: ' + f.label); return; }
    if (needReason && !reason.trim()) { alert('Please give a reason for the address change.'); return; }
    onSave(vals, needReason ? reason.trim() : undefined);
  };
  const remove = () => { if (window.confirm(`Delete "${row.name}"? This removes the property; any linked parcels become standalone.`)) onDelete(); };
  const primaryOpts = [{ v: '', l: '— Standalone / primary parcel —' },
    ...(properties || []).filter(x => !x.parentId && (!row || x.id !== row.id)).map(x => ({ v: x.id, l: x.name }))];
  const resolve = (f) => (f.dynamic === 'primaries' ? { ...f, options: primaryOpts } : f);
  return (
    <Modal title={row ? 'Edit property' : 'Add property'} wide onClose={onClose}
      footer={<>
        {row && onDelete && <button className="secondary-btn" onClick={remove} style={{ marginRight: 'auto', color: 'hsl(var(--color-red))' }}>Delete</button>}
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={submit}>Save property</button>
      </>}>
      {needReason && (
        <div style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 10, border: '1px solid hsla(var(--color-gold), 0.5)', backgroundColor: 'hsla(var(--color-gold), 0.1)' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'hsl(var(--color-gold))', marginBottom: 6 }}>⚠ You changed the address — reason required</div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 8 }}>Changing: <strong style={{ color: 'var(--text-primary)' }}>{changedAddr.map(([, l]) => l).join(', ')}</strong>. A reason is recorded in the activity log.</div>
          <input className="form-input" autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is the address being changed? (required)" style={{ fontSize: '0.85rem' }} />
        </div>
      )}
      <div className="form-grid">
        {PROPERTY_FIELDS.map((f, i) => f.sec
          ? <div key={i} style={{ ...microLabel, gridColumn: '1 / -1', marginTop: i ? 8 : 0, color: 'var(--pine)', fontSize: '0.7rem' }}>{f.sec}</div>
          : <FormField key={f.k} f={resolve(f)} value={vals[f.k]} onChange={set} />)}
      </div>
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-color)' }}>
        <div style={{ ...microLabel, color: 'var(--pine)', fontSize: '0.7rem', marginBottom: 10 }}>Property image</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {vals.image
            ? <img src={vals.image} alt="" style={{ width: 120, height: 78, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border-color)', flexShrink: 0 }} />
            : <div style={{ width: 120, height: 78, borderRadius: 8, border: '1px dashed var(--border-color)', backgroundColor: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.72rem', flexShrink: 0 }}>No image</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <button className="secondary-btn" onClick={() => fileRef.current?.click()} style={{ fontSize: '0.78rem', padding: '7px 14px' }}>{vals.image ? 'Change image' : 'Upload image'}</button>
            {vals.image && <button className="secondary-btn" onClick={() => set('image', '')} style={{ fontSize: '0.78rem', padding: '7px 14px', color: 'hsl(var(--color-red))' }}>Remove</button>}
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>Only shown inside the property detail.</span>
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickImage} style={{ display: 'none' }} />
        </div>
      </div>
    </Modal>
  );
}

// Dedicated "Link Properties" modal: TYPE a site name, then tick the properties that
// belong to it. They group together under that name (first ticked = Primary parcel).
function LinkModal({ properties, onSave, onClose }) {
  const existingSites = [...new Set(properties.map(p => p.siteName).filter(Boolean))];
  const [name, setName] = useState('');
  const [checked, setChecked] = useState(() => new Set());
  // Typing a name auto-ticks the parcels already in that site (so you can edit a site).
  const onName = (val) => { setName(val); const m = properties.filter(p => p.siteName && p.siteName.toLowerCase() === val.trim().toLowerCase()); if (m.length) setChecked(new Set(m.map(p => p.id))); };
  const toggle = (id) => setChecked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const canSave = name.trim() && checked.size >= 1;
  return (
    <Modal title="Link Properties" onClose={onClose}
      footer={<>
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={!canSave} onClick={() => onSave(name, [...checked])}>Save site</button>
      </>}>
      <div className="form-group">
        <label>Site name<span style={{ color: 'hsl(var(--color-red))' }}> *</span></label>
        <input className="form-input" list="sitelist" value={name} onChange={e => onName(e.target.value)} placeholder="e.g. Greens Escondido" autoFocus />
        <datalist id="sitelist">{existingSites.map(s => <option key={s} value={s} />)}</datalist>
        {existingSites.length > 0 && <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 4 }}>Existing sites: {existingSites.join(' · ')} (type one to edit it)</div>}
      </div>
      <div style={{ ...microLabel, marginTop: 14, marginBottom: 6 }}>Tick the properties that belong to this site (first ticked = primary)</div>
      <div style={{ maxHeight: '44vh', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 10 }}>
        {properties.map(p => {
          const otherSite = p.siteName && p.siteName.toLowerCase() !== name.trim().toLowerCase();
          return (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 13px', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}>
              <input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} style={{ width: 16, height: 16, flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{p.name}</strong>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', fontFamily: MONO }}>APN {p.apn || '—'}{p.acreage ? ` · ${p.acreage} ac` : ''}</div>
              </div>
              {otherSite && <span style={{ fontSize: '0.66rem', fontWeight: 600, padding: '2px 7px', borderRadius: 5, color: 'hsl(var(--color-orange))', backgroundColor: 'hsla(var(--color-orange), 0.12)' }}>in “{p.siteName}”</span>}
            </label>
          );
        })}
      </div>
      <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 8 }}>Unticking a property removes it from this site (becomes standalone).</div>
    </Modal>
  );
}

// Activity Log tab — full audit history: who changed what field, in which tab, on which
// property, and when. Newest first, grouped by day.
function LogsTab({ logs, onOpenProperty, activeId, activeName, onGoTo }) {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [scope, setScope] = useState(activeId ? 'this' : 'all');
  const thisOnly = scope === 'this' && activeId;
  const items = (logs || []).filter(l => {
    if (thisOnly && l.propertyId !== activeId) return false;
    const d = (l.ts || '').slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return !q || JSON.stringify(l).toLowerCase().includes(q.toLowerCase());
  });
  const dayKey = (ts) => (ts || '').slice(0, 10);
  const dayLabel = (ts) => {
    const today = new Date(); const y = new Date(today); y.setDate(today.getDate() - 1);
    const k = dayKey(ts);
    if (k === dayKey(today.toISOString())) return 'Today';
    if (k === dayKey(y.toISOString())) return 'Yesterday';
    try { return new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); } catch { return k; }
  };
  const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  const initials = (n) => (n || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase() || '?';
  const aColor = (a) => a === 'added' ? 'green' : a === 'removed' ? 'red' : a === 'linked' ? 'purple' : 'blue';
  const aLabel = (a) => a === 'added' ? 'Added' : a === 'removed' ? 'Removed' : a === 'linked' ? 'Linked' : 'Edited';
  const groups = [];
  items.forEach(l => { const k = dayKey(l.ts); let g = groups.find(x => x.k === k); if (!g) { g = { k, ts: l.ts, list: [] }; groups.push(g); } g.list.push(l); });
  const dinp = { padding: '6px 9px', width: 'auto', fontSize: '0.8rem' };
  return (
    <Panel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Activity Log</strong>
        <span style={microLabel}>{items.length} entr{items.length === 1 ? 'y' : 'ies'}</span>
        {activeId && (
          <div style={{ display: 'inline-flex', padding: 3, borderRadius: 999, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
            {[['this', activeName || 'This property'], ['all', 'All properties']].map(([s, lbl]) => (
              <button key={s} onClick={() => setScope(s)} style={{ padding: '5px 12px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 600, whiteSpace: 'nowrap', background: scope === s ? 'var(--pine)' : 'transparent', color: scope === s ? '#fff' : 'var(--text-secondary)' }}>{lbl}</button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input className="form-input" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} style={{ paddingLeft: 30, fontSize: '0.8rem', width: 180 }} />
          </div>
          <label style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 5 }}>From <input type="date" className="form-input" value={from} onChange={e => setFrom(e.target.value)} style={dinp} /></label>
          <label style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 5 }}>To <input type="date" className="form-input" value={to} onChange={e => setTo(e.target.value)} style={dinp} /></label>
          {(from || to || q) && <button className="secondary-btn" onClick={() => { setFrom(''); setTo(''); setQ(''); }} style={{ padding: '5px 11px', fontSize: '0.76rem' }}>Clear</button>}
        </div>
      </div>
      {items.length === 0
        ? <Empty>No activity yet — every add, edit, delete and link is recorded here with who, what and when.</Empty>
        : groups.map(g => (
          <div key={g.k} style={{ marginBottom: 14 }}>
            <div style={{ ...microLabel, padding: '4px 0 8px' }}>{dayLabel(g.ts)}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {g.list.map(l => {
                const c = aColor(l.action);
                return (
                  <div key={l.id} style={{ display: 'flex', gap: 11, padding: '12px 13px', borderRadius: 10, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                    <span style={{ flexShrink: 0, width: 9, height: 9, marginTop: 5, borderRadius: '50%', backgroundColor: `hsl(var(--color-${c}))`, boxShadow: `0 0 0 3px hsla(var(--color-${c}), 0.15)` }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: (l.changes && l.changes.length) ? 7 : 0 }}>
                        <span style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', padding: '2px 7px', borderRadius: 4, color: `hsl(var(--color-${c}))`, backgroundColor: `hsla(var(--color-${c}), 0.12)` }}>{aLabel(l.action)}</span>
                        {l.property && <span onClick={() => l.propertyId && onOpenProperty(l.propertyId)} title="Open property" style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', cursor: l.propertyId ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.property}</span>}
                        <span style={{ fontSize: '0.7rem', fontWeight: 600, padding: '2px 7px', borderRadius: 4, color: 'hsl(var(--color-blue))', backgroundColor: 'hsla(var(--color-blue), 0.1)' }}>{l.section}</span>
                        {l.item && l.item !== l.property && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {l.item}</span>}
                        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmtTime(l.ts)}</span>
                      </div>
                      {l.changes && l.changes.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 10px', borderRadius: 7, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)' }}>
                          {l.changes.map((ch, ci) => (
                            <div key={ci} style={{ fontSize: '0.78rem', color: 'var(--text-primary)', wordBreak: 'break-word', lineHeight: 1.5 }}>
                              <span style={{ ...microLabel }}>{ch.field}</span>{'  '}
                              <span style={{ color: 'var(--text-secondary)', textDecoration: 'line-through' }}>{(ch.from ?? '') === '' ? '∅' : String(ch.from)}</span>
                              {' → '}<span style={{ fontWeight: 600, fontFamily: looksNumeric(ch.to) ? MONO : undefined }}>{(ch.to ?? '') === '' ? '∅' : String(ch.to)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {l.reason && (
                        <div style={{ marginTop: 7, padding: '6px 10px', borderRadius: 7, fontSize: '0.76rem', color: 'hsl(var(--color-gold))', backgroundColor: 'hsla(var(--color-gold), 0.1)', border: '1px solid hsla(var(--color-gold), 0.3)', wordBreak: 'break-word' }}>
                          <strong>Reason:</strong> <span style={{ color: 'var(--text-primary)', fontStyle: 'italic' }}>{l.reason}</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                        <span title={l.user} style={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', fontWeight: 700, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.14)' }}>{initials(l.user)}</span>
                        <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.user}</span>
                        {l.propertyId && l.action !== 'removed' && onGoTo && (
                          <button onClick={() => onGoTo(l)} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 7, border: '1px solid var(--border-color)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600, color: 'hsl(var(--color-blue))', whiteSpace: 'nowrap' }}>Go to {l.changes && l.changes.length ? 'field' : l.section} →</button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
    </Panel>
  );
}

// Read-only table for Timeline (sheet 3) and Permit Matrix (sheet 4) source data.
// If `cols` is omitted, columns are derived from the data keys (handles varying headers).
function ReadTable({ title, subtitle, rows, cols }) {
  const data = rows || [];
  const columns = cols || (() => {
    const keys = [];
    data.forEach(r => Object.keys(r).forEach(k => { if (k !== 'id' && k !== 'propertyId' && !keys.includes(k)) keys.push(k); }));
    return keys.map(k => [k, k]);
  })();
  const list = data.filter(r => columns.some(c => String(r[c[0]] ?? '').trim()));
  return (
    <Panel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{title}</strong>
        {subtitle && <span style={microLabel}>{subtitle}</span>}
        <span style={{ ...microLabel, marginLeft: 'auto' }}>{list.length} row{list.length === 1 ? '' : 's'}</span>
      </div>
      {list.length ? (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead><tr>{columns.map(c => <th key={c[0]} style={{ ...microLabel, textAlign: 'left', padding: '10px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>{c[1]}</th>)}</tr></thead>
            <tbody>{list.map((r, i) => (
              <tr key={i}>{columns.map(c => <td key={c[0]} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top', color: 'var(--text-primary)', fontSize: '0.78rem' }}>{String(r[c[0]] ?? '').trim() || '—'}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>No {title.toLowerCase()} data on file.</Empty>}
    </Panel>
  );
}

/* ---------- shared bits ---------- */
function Panel({ children }) { return <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: 18 }}>{children}</div>; }
function Empty({ children }) {
  return <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.875rem', border: '1px dashed var(--border-color)', borderRadius: 12 }}>{children}</div>;
}
function Modal({ title, children, footer, wide, onClose }) {
  return (
    <div className="modal-overlay" style={{ display: 'flex' }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content" style={{ maxWidth: wide ? 760 : 560 }}>
        <div className="modal-header"><h3>{title}</h3><button className="close-btn" onClick={onClose}><X size={18} /></button></div>
        <div style={{ padding: '4px 24px 16px' }}>{children}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 24px 18px', borderTop: '1px solid var(--border-color)' }}>{footer}</div>
      </div>
    </div>
  );
}

const fmtDateBlank = (d) => d ? fmtDate(d) : '';
const looksNumeric = (v) => { const s = String(v ?? '').trim(); return s !== '' && /\d/.test(s) && /^[\d.,$%\s/:'"x×-]+(?:sf|SF|ac|AC|units?)?$/i.test(s); };

/* ---------- header KPIs + JSON export (Neil's brandbar) ---------- */
function headerStats(data) {
  const warr = data.warranties.filter(r => { const d = dleft(r.expiration); return d != null && d >= 0; }).length;
  const insp = data.inspections.filter(r => { const d = dleft(r.nextDue); return d != null && d <= 60; }).length;
  const exp = [
    ...data.warranties.map(r => dleft(r.expiration)),
    ...data.vendors.map(r => dleft(r.coiExpiration)),
    ...data.ahj.map(r => dleft(r.renewalDate)),
  ].filter(d => d != null && d >= 0 && d <= 90).length;
  return { assets: data.properties.filter(p => !p.parentId).length, parcels: data.properties.length, warr, insp, exp };
}
function exportAllJSON(data) {
  try {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), module: 'Nexus Asset Management', data }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'nexus-asset-management-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch { /* ignore */ }
}

/* ---------- PDF report ---------- */
function exportReport(p, data) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const v = (x) => { const s = (x ?? '') === '' ? '' : String(x); return s ? esc(s) : '—'; };
  const dt = (d) => d ? fmtDate(d) : '—';
  const collRows = (coll) => (data[coll] || []).filter(r => r.propertyId === p.id);

  // Family / aggregate (asset = primary + ancillary parcels).
  const root = p.parentId ? (data.properties.find(x => x.id === p.parentId) || p) : p;
  const fam = [root, ...data.properties.filter(x => x.parentId === root.id)];
  const agg = fam.reduce((a, x) => { a.nrsf += num0(x.nrsf); a.units += num0(x.unitsTotal); a.rv += num0(x.unitsRV); a.ac += num0(x.acreage); return a; }, { nrsf: 0, units: 0, rv: 0, ac: 0 });

  // Compliance status + alerts (the action items a manager needs).
  const alerts = [];
  const di = dleft(p.insExpiration);
  if (di != null && di < 0) alerts.push(['red', `Insurance policy expired ${Math.abs(di)}d ago (${esc(p.insCarrier || 'carrier')})`]);
  else if (di != null && di <= 90) alerts.push(['amber', `Insurance expires in ${di}d (${esc(p.insCarrier || 'carrier')})`]);
  collRows('inspections').forEach(r => { const d = dleft(r.nextDue); if (d != null && d < 0) alerts.push(['red', `Inspection overdue ${Math.abs(d)}d — ${esc(r.type)}`]); else if (d != null && d <= 30) alerts.push(['amber', `Inspection due in ${d}d — ${esc(r.type)}`]); });
  collRows('warranties').forEach(r => { const d = dleft(r.expiration); if (d != null && d >= 0 && d <= 90) alerts.push(['amber', `Warranty expires in ${d}d — ${esc(r.scope)}`]); });
  collRows('vendors').forEach(r => { if (!r.coiExpiration) alerts.push(['amber', `Vendor COI missing — ${esc(r.company)}`]); else { const d = dleft(r.coiExpiration); if (d != null && d < 0) alerts.push(['red', `Vendor COI lapsed ${Math.abs(d)}d — ${esc(r.company)}`]); } });
  const alertHtml = alerts.length
    ? `<div class="alerts">${alerts.slice(0, 10).map(([c, t]) => `<div class="alert ${c}">${t}</div>`).join('')}</div>`
    : `<div class="alerts"><div class="alert green">All current — no open compliance items.</div></div>`;

  const kv = (rows) => `<table class="kv"><tbody>${rows.map(([k, val, m]) => `<tr><td class="k">${esc(k)}</td><td class="v${m === false ? ' txt' : ''}">${v(val)}</td></tr>`).join('')}</tbody></table>`;
  const card = (n, title, body) => body ? `<section class="card"><div class="card-h">${n != null ? `<span class="num">${n}</span>` : ''}<span>${esc(title)}</span></div>${body}</section>` : '';
  const statusCell = (kind, d) => {
    if (d == null) return '<span class="chip mut">—</span>';
    if (kind === 'w') return d < 0 ? '<span class="chip mut">Expired</span>' : d <= 90 ? `<span class="chip amber">${d}d</span>` : '<span class="chip green">Active</span>';
    if (kind === 'i') return d < 0 ? `<span class="chip red">Overdue ${Math.abs(d)}d</span>` : d <= 30 ? `<span class="chip amber">${d}d</span>` : '<span class="chip green">Current</span>';
    return d < 0 ? `<span class="chip red">Lapsed</span>` : d <= 60 ? `<span class="chip amber">${d}d</span>` : '<span class="chip green">Current</span>';
  };
  const tbl = (coll, cols, dateKey, kind) => {
    const rows = collRows(coll); if (!rows.length) return '';
    return `<table class="data"><thead><tr>${cols.map(c => `<th>${esc(c[1])}</th>`).join('')}${kind ? '<th>Status</th>' : ''}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td${c[2] ? ' class="mono"' : ''}>${c[2] === 'date' ? dt(r[c[0]]) : v(r[c[0]])}</td>`).join('')}${kind ? `<td>${statusCell(kind, dleft(r[dateKey]))}</td>` : ''}</tr>`).join('')}</tbody></table>`;
  };
  const metric = (val, label) => `<div class="m"><div class="mv">${val}</div><div class="ml">${esc(label)}</div></div>`;
  const status = devStatusReport(p.devStage);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.name)} — Asset Report</title><style>
@page{size:A4;margin:14mm 13mm 16mm}
*{box-sizing:border-box}body{font-family:'Inter',system-ui,Arial,sans-serif;color:#0f172a;margin:0;font-size:11.5px;line-height:1.45}
.band{background:#0f172a;color:#fff;padding:16px 18px;border-radius:10px;display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px}
.band h1{margin:0;font-size:20px;letter-spacing:-.01em}.band .sub{color:#cbd5e1;font-size:11px;margin-top:3px}
.band .r{text-align:right;font-size:10px;color:#cbd5e1;line-height:1.6}.band .r b{color:#fff;letter-spacing:1px}
.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:14px}
.m{border:1px solid #e5e7eb;border-radius:8px;padding:9px 11px}.mv{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:15px}.ml{font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin-top:2px}
.alerts{margin-bottom:16px}.alert{padding:7px 11px;border-radius:7px;font-size:11px;font-weight:600;margin-bottom:5px;border-left:3px solid}
.alert.red{background:#fef2f2;color:#b91c1c;border-color:#dc2626}.alert.amber{background:#fffbeb;color:#b45309;border-color:#d97706}.alert.green{background:#f0fdf4;color:#15803d;border-color:#16a34a}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#0f172a;margin:18px 0 8px}
.card{border:1px solid #e5e7eb;border-radius:9px;padding:13px 15px;margin-bottom:11px;break-inside:avoid}
.card-h{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;margin-bottom:9px;padding-bottom:7px;border-bottom:1px solid #eef2f7}
.num{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:#0f172a;color:#fff;font-size:10px;font-family:ui-monospace,Menlo,monospace}
table{width:100%;border-collapse:collapse}
table.kv{display:grid;grid-template-columns:1fr 1fr;gap:0 22px}table.kv tbody{display:contents}table.kv tr{display:grid;grid-template-columns:46% 54%;padding:3px 0;border-bottom:1px solid #f4f6f9}
.kv .k{color:#64748b;font-size:9px;text-transform:uppercase;letter-spacing:.03em;align-self:center}.kv .v{font-weight:600;font-family:ui-monospace,Menlo,monospace;font-size:10.5px}.kv .v.txt{font-family:inherit;font-weight:500}
table.data{border:1px solid #e5e7eb;border-radius:8px;font-size:10px;margin-top:4px;overflow:hidden}
table.data th{background:#f8fafc;text-transform:uppercase;font-size:8.5px;letter-spacing:.03em;color:#64748b;text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb}
table.data td{padding:6px 8px;border-bottom:1px solid #f4f6f9;vertical-align:top}table.data td.mono{font-family:ui-monospace,Menlo,monospace}
.chip{display:inline-block;font-size:8.5px;font-weight:700;padding:2px 7px;border-radius:999px}
.chip.green{background:#dcfce7;color:#15803d}.chip.amber{background:#fef3c7;color:#b45309}.chip.red{background:#fee2e2;color:#b91c1c}.chip.mut{background:#f1f5f9;color:#64748b}
.foot{margin-top:18px;padding-top:9px;border-top:1px solid #e5e7eb;font-size:9px;color:#94a3b8;display:flex;justify-content:space-between}
section{break-inside:avoid}
</style></head><body>
<div class="band"><div><h1>${esc(p.name)}</h1><div class="sub">${esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '))}${p.county ? ` · ${esc(p.county)} County` : ''} · APN ${esc(p.apn || '—')}</div></div>
<div class="r"><b>GREENS</b><br>Asset Report<br>${esc(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}<br>by ${esc(currentUser())}</div></div>

<div class="metrics">
${metric(fmtNum(p.nrsf), 'NRSF')}${metric(num0(p.unitsTotal) ? fmtNum(p.unitsTotal) : '—', 'Units')}${metric(p.acreage ? p.acreage + ' ac' : '—', 'Acreage')}${metric(v(p.yearBuilt), 'Year built')}${metric(fam.length, fam.length > 1 ? 'Parcels' : 'Parcel')}${metric(status, 'Status')}
</div>

<h2>Status &amp; alerts</h2>
${alertHtml}

${card(1, 'Identity & ownership', kv([['Operating entity', p.entity, false], ['Parcel role', p.parcelRole, false], ['Builder (GC)', p.builder, false], ['Asset manager', p.manager, false], ['County', p.county, false], ['Legal description', p.legalDesc, false]]))}
${card(2, 'Building & site', kv([['Year built', p.yearBuilt], ['Construction', p.constructionType, false], ['Stories', p.stories], ['NRSF', p.nrsf ? fmtNum(p.nrsf) : ''], ['GSF', p.gsf ? fmtNum(p.gsf) : ''], ['Acreage', p.acreage], ['Zoning / land use', p.zoning, false], ['Flood zone', p.floodZone], ['Sprinklered', p.sprinklered, false], ['Alarm monitored', p.alarmMonitored, false], ['Development stage', p.devStage, false]]))}
${card(3, 'Placed in service', kv([['Placed-in-service', dt(p.placedInService)], ['CO number', p.coNumber], ['CO date', dt(p.coDate)]]))}
${card(4, 'Unit mix', kv([['Non-climate', p.unitsNonClimate ? fmtNum(p.unitsNonClimate) : ''], ['Climate-controlled', p.unitsClimate ? fmtNum(p.unitsClimate) : ''], ['RV / boat', p.unitsRV ? fmtNum(p.unitsRV) : ''], ['Total units', p.unitsTotal ? fmtNum(p.unitsTotal) : '']]))}
${card(5, 'Insurance', kv([['Carrier', p.insCarrier, false], ['Policy #', p.insPolicy], ['Expiration', dt(p.insExpiration)], ['Agent / broker', [p.insAgent, p.insPhone].filter(Boolean).join(' · '), false]]))}
${card(6, 'Property tax', kv([['Tax account', p.taxId], ['Annual tax', p.taxAnnual ? fmtMoney(p.taxAnnual) : ''], ['Due dates', p.taxDue, false]]))}
${fam.length > 1 ? `<section class="card"><div class="card-h"><span>Linked parcels — ${esc(root.siteName || root.name)}</span></div>
<table class="data"><thead><tr><th>Parcel</th><th>APN</th><th>NRSF</th><th>Units</th><th>Acres</th></tr></thead><tbody>
${fam.map(x => `<tr><td>${esc(x.name)}${x.id === root.id ? ' (primary)' : ''}</td><td class="mono">${v(x.apn)}</td><td class="mono">${fmtNum(x.nrsf)}</td><td class="mono">${num0(x.unitsTotal) ? fmtNum(x.unitsTotal) : '—'}</td><td class="mono">${x.acreage || '—'}</td></tr>`).join('')}
<tr style="font-weight:700;background:#f8fafc"><td>Combined</td><td>—</td><td class="mono">${fmtNum(agg.nrsf)}</td><td class="mono">${fmtNum(agg.units)}</td><td class="mono">${agg.ac.toFixed(2)}</td></tr>
</tbody></table></section>` : ''}

${(() => { const t = tbl('warranties', [['scope', 'Scope'], ['party', 'Party / contractor'], ['kind', 'Type'], ['expiration', 'Expires', 'date']], 'expiration', 'w'); return t ? `<h2>Warranties</h2>${t}` : ''; })()}
${(() => { const t = tbl('inspections', [['type', 'Inspection'], ['frequency', 'Frequency'], ['vendor', 'Vendor'], ['nextDue', 'Next due', 'date']], 'nextDue', 'i'); return t ? `<h2>Inspections</h2>${t}` : ''; })()}
${(() => { const t = tbl('documents', [['title', 'Document'], ['category', 'Category'], ['version', 'Version'], ['location', 'Egnyte location']]); return t ? `<h2>Plans &amp; Documents</h2>${t}` : ''; })()}
${(() => { const t = tbl('ahj', [['authority', 'Authority'], ['jurisdiction', 'Jurisdiction'], ['accountOrPermit', 'Account / permit'], ['renewalDate', 'Renewal', 'date']], 'renewalDate', 'r'); return t ? `<h2>Authorities Having Jurisdiction</h2>${t}` : ''; })()}
${(() => { const t = tbl('utilities', [['service', 'Service'], ['provider', 'Provider'], ['accountNumber', 'Account #'], ['meterNumber', 'Meter / ESI'], ['avgMonthly', 'Avg / mo']]); return t ? `<h2>Utilities</h2>${t}` : ''; })()}
${(() => { const t = tbl('vendors', [['company', 'Vendor'], ['category', 'Category'], ['contractEnd', 'Contract end', 'date'], ['coiExpiration', 'COI', 'date']], 'coiExpiration', 'r'); return t ? `<h2>Vendors</h2>${t}` : ''; })()}

<div class="foot"><span>Confidential — Greens Global · Asset Management</span><span>Generated ${esc(new Date().toLocaleString())} · ${esc(currentUser())}</span></div>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script></body></html>`;
  const w = window.open('', '_blank'); if (!w) { alert('Allow pop-ups to export the PDF report.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
const devStatusReport = (stage) => { const s = (stage || '').toLowerCase(); if (!s) return '—'; if (/(built|in[\s-]?use|open|developed|stabili|operat|complete|occupied|finaled)/.test(s)) return 'Active'; if (/(feasib|entitl|permit|construction|planning|grading|design)/.test(s)) return 'Under Dev'; return '—'; };
