// Asset Management — faithful port of Neil's Nexus-AssetManagement.html template.
// Same tabs, same fields, same click behaviour, same design. Seeded from the real
// 14-property portfolio (mapped into the template's flat data model) and persisted
// to localStorage. Navy accent uses var(--pine) so it stays correct in dark mode.
import { useState, useEffect, useRef, createElement } from 'react';
import { Plus, X, ArrowLeft, ArrowRight, Link2, FileDown, Search, Building2, ChevronDown, Upload, FileText, LayoutGrid, List, Settings, Warehouse, Truck, Store, Stethoscope, Home, Building, Trees, Pencil, Trash2, RotateCcw, Filter, Car, Wrench } from 'lucide-react';
import { useRole } from '../contexts/RoleContext';

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
import innopolis from '../data/assets/innopolis-genome-valley.json';
import heritageSquare from '../data/assets/greens-heritage-square.json';
import storageMenifee from '../data/assets/greens-storage-menifee.json';
import qualityInn from '../data/assets/quality-inn-washington-ut.json';
import chipotle from '../data/assets/chipotle-chicago.json';
import mattressFirm from '../data/assets/mattress-firm-chicago.json';
import ramkySelenium from '../data/assets/ramky-selenium-hyderabad.json';
import storageMurrieta from '../data/assets/greens-storage-murrieta.json';
import greensTowers from '../data/assets/greens-towers-hyderabad.json';
import wellsFargo from '../data/assets/wells-fargo-san-antonio.json';
import { msalInstance } from '../msalInstance';
import { api } from '../api';
import { supabase } from '../lib/supabase';
import { emailToName } from '../lib/utils';

const RAW = [georgetown, austin, lakeside, rainbow, escondidoNorth, escondidoSouth, sachse,
  valleyCenterNorth, valleyCenterEast, valleyCenterSouth, greensFamily918, gurudevFamily910, rjkResidence, greensFairfield,
  innopolis, heritageSquare, storageMenifee, qualityInn, chipotle, mattressFirm, ramkySelenium, storageMurrieta, greensTowers, wellsFargo];

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
// Whole months between two dates (for auto-calculating warranty term). '' if invalid.
function monthsBetween(start, end) {
  if (!start || !end) return '';
  const a = new Date(start), b = new Date(end);
  if (isNaN(a) || isNaN(b)) return '';
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  return m < 0 ? '' : String(m);
}
// Raw file → data URL (for document uploads — PDFs, scans, etc., no scaling).
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}
// data URL → Blob (so a scaled image can be uploaded to storage rather than stored inline).
async function dataUrlToBlob(dataUrl) { return (await fetch(dataUrl)).blob(); }
// Upload an asset image/document to Supabase storage and return its public URL. Reuses the
// existing public `item-photos` bucket (already cached immutably) under an `asset/` prefix, so no
// new bucket/policy is needed. Images are scaled first; documents upload as-is. Falls back to an
// inline data URL if storage is unavailable, so an upload never loses the user's file.
async function uploadAssetFile(file, scale = false) {
  try {
    let blob = file, ext = (file.name?.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (scale && (file.type || '').startsWith('image/')) { blob = await dataUrlToBlob(await fileToScaledDataUrl(file)); ext = 'jpg'; }
    if (!ext) ext = (blob.type || '').split('/')[1] || 'bin';
    const path = `asset/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await supabase.storage.from('item-photos').upload(path, blob, { contentType: blob.type || file.type || 'application/octet-stream', upsert: false, cacheControl: '31536000' });
    if (error) throw error;
    return supabase.storage.from('item-photos').getPublicUrl(data.path).data.publicUrl;
  } catch {
    // Storage unavailable — keep the file inline so nothing is lost (legacy behaviour).
    return scale ? fileToScaledDataUrl(file) : fileToDataUrl(file);
  }
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
    unitsRV: num0(sv(p, 'Unit Mix', 'RV')), unitsMailbox: num0(sv(p, 'Unit Mix', 'Mailbox')), unitsTotal: num0(sv(p, 'Unit Mix', 'Total')),
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
  return { properties: [...properties, ...VEHICLE_SEEDS], warranties, inspections, documents, ahj, utilities, vendors };
}

// The sample/demo property was removed. Strip it (and its records) from any saved data so it
// doesn't linger in browsers that seeded it earlier.
const DEMO_ID = 'demo-greens-storage';
const stripDemo = (d) => ({
  ...d,
  properties: (d.properties || []).filter(p => p.id !== DEMO_ID),
  warranties: (d.warranties || []).filter(r => r.propertyId !== DEMO_ID),
  inspections: (d.inspections || []).filter(r => r.propertyId !== DEMO_ID),
  utilities: (d.utilities || []).filter(r => r.propertyId !== DEMO_ID),
  vendors: (d.vendors || []).filter(r => r.propertyId !== DEMO_ID),
  documents: (d.documents || []).filter(r => r.propertyId !== DEMO_ID),
  ahj: (d.ahj || []).filter(r => r.propertyId !== DEMO_ID),
});
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
// The source timeline put the status word in the "Notes" column. Map it into the
// real Status field and clear notes — but leave genuine comments (non-status text) in place.
const statusFromNotes = (notes) => {
  const t = String(notes || '').trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith('complet')) return 'Complete';
  if (t === 'pending') return 'Pending';
  if (t === 'n/a' || t === 'na') return 'N/A';
  if (/in proc|in prog|progress|being updated|submitted|applied/.test(t)) return 'In Progress';
  return null; // a real comment — keep it in notes
};
const migrateTimelineRow = (r) => {
  if (r.status) return r;                 // already has an explicit status
  const s = statusFromNotes(r.notes);
  return s ? { ...r, status: s, notes: '' } : r;
};
// Hydrate a raw workspace blob (from the server, or freshly adapted from the seed JSON)
// into the shape the module renders: merge any newly-added seed properties, drop the
// retired demo card, migrate site groups into primary/secondary hierarchy, and attach the
// full source sheets + refreshed photos. Pure — no localStorage (data is server-backed now).
function hydrate(d) {
  if (!d || !Array.isArray(d.properties)) d = adapt();
  // Merge in any newly-seeded properties (new JSON files added since the workspace was last
  // saved) so they appear without a reset. Only adds ids not already present.
  try {
    const have = new Set((d.properties || []).map(p => p.id));
    const additions = adapt().properties.filter(p => !have.has(p.id));
    if (additions.length) d = { ...d, properties: [...(d.properties || []), ...additions] };
  } catch { /* ignore */ }
  d = stripDemo(d);
  // Migrate existing siteName groups into primary/secondary (parentId) hierarchy — only if no
  // hierarchy exists yet (so we never clobber explicit Role designations). First member = primary.
  if (!d.properties.some(p => p.parentId)) {
    const groups = {};
    d.properties.forEach(p => { if (p.siteName) (groups[p.siteName] = groups[p.siteName] || []).push(p); });
    Object.values(groups).forEach(members => { if (members.length > 1) members.forEach((m, i) => { if (i > 0) m.parentId = members[0].id; }); });
  }
  // Enrich with full source sheets; Development Stage must be one of the standard values;
  // migrate timeline status out of the Notes column.
  return { ...d, vservice: d.vservice || [], odometer: d.odometer || [], vdocs: d.vdocs || [], properties: d.properties.map(p => {
    const e = enrichSource(p);
    // Refresh the seeded image from the source JSON (so updated property photos show even if an
    // old path was saved). User-uploaded images (data URLs) are left untouched.
    const src = RAW_BY_ID[e.id];
    const image = (src && src.image && (!e.image || e.image.startsWith('/assets/properties/'))) ? src.image : e.image;
    // Development Stage is validated only for properties; vehicles/equipment use their own status enum.
    const isProp = inferAssetKind(e) === 'property';
    const e2 = (!isProp || DEV_STAGES.includes(e.devStage)) ? { ...e, image } : { ...e, image, devStage: '' };
    return { ...e2, timeline: (e2.timeline || []).map(migrateTimelineRow) };
  }) };
}
// Fresh workspace seeded from the bundled portfolio JSON — used the first time the server
// store is empty.
const seedData = () => hydrate(adapt());
// Empty workspace rendered while the server load is in flight.
const EMPTY_WS = { properties: [], warranties: [], inspections: [], documents: [], ahj: [], utilities: [], vendors: [], vservice: [], odometer: [], vdocs: [], logs: [] };

/* ---------- collections config (Neil's exact fields + columns) ---------- */
const COLLECTIONS = {
  warranties: {
    title: 'Warranty', plural: 'Warranties', empty: 'No warranties on file. Add subcontractor and equipment warranties from the closeout package.',
    fields: [
      { k: 'kind', label: 'Type', type: 'select', options: ['Contractor', 'Subcontractor', 'Manufacturer', 'Other'] },
      { k: 'scope', label: 'Scope / item covered', req: true },
      { k: 'party', label: 'Name', req: true },
      { k: 'contactName', label: 'Contact Name' }, { k: 'phone', label: 'Contact Phone' }, { k: 'email', label: 'Contact Email' },
      { k: 'startDate', label: 'Start date', type: 'date' },
      { k: 'expiration', label: 'Expiration', type: 'date', req: true },
      { k: 'termMonths', label: 'Term (months, auto)', type: 'number', readOnly: true },
      { k: 'docRef', label: 'Document location (Egnyte path)', full: true },
      { k: 'docFile', label: 'Warranty document (upload)', type: 'file', nameKey: 'docFileName', full: true },
      { k: 'coverage', label: 'Coverage summary', type: 'textarea', full: true, req: true },
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
  vdocs: {
    title: 'Document', plural: 'Documents', empty: 'No vehicle/equipment documents on file. Upload registration, title, insurance, loan, and warranty documents.',
    fields: [
      { k: 'category', label: 'Category', type: 'select', options: ['Registration', 'Title', 'Insurance', 'Loan / Finance', 'Warranty', 'Service Record', 'Manual', 'Other'] },
      { k: 'title', label: 'Title', req: true },
      { k: 'dateOf', label: 'Document date', type: 'date' },
      { k: 'docFile', label: 'Document (upload)', type: 'file', nameKey: 'docFileName', full: true },
      { k: 'egnyteDest', label: 'Egnyte destination folder', full: true },
      { k: 'location', label: 'Location (Egnyte path)', full: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Document', main: r => r.title, sub: r => r.category },
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
      { k: 'accountNumber', label: 'Account number', req: true }, { k: 'meterNumber', label: 'Meter' },
      { k: 'serviceAddress', label: 'Service address', full: true },
      { k: 'autopay', label: 'Autopay', type: 'select', options: ['Yes — Ramp card', 'Yes — ACH', 'No'] },
      { k: 'avgMonthly', label: 'Avg monthly ($)', type: 'number' }, { k: 'contactPhone', label: 'Provider phone' },
      { k: 'portal', label: 'Portal URL' }, { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Service', main: r => r.service, sub: r => r.provider },
      { label: 'Account #', mono: r => r.accountNumber || '—' },
      { label: 'Meter', mono: r => r.meterNumber || '—' },
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
  // Vehicle & equipment logs.
  vservice: {
    title: 'Service Record', plural: 'Service & Maintenance', empty: "No service records yet — log maintenance as it's performed, or upload an invoice.",
    fields: [
      { k: 'date', label: 'Service Date', type: 'date', req: true },
      { k: 'type', label: 'Service Type', type: 'select', options: ['Oil Change', 'Tire Rotation', 'Brakes', 'Battery', 'Fluids', 'Inspection', 'Scheduled Maintenance', 'Repair', 'Recall', 'Other'], req: true },
      { k: 'mileage', label: 'Odometer (mi)', type: 'number' },
      { k: 'vendor', label: 'Shop / Vendor' }, { k: 'cost', label: 'Cost' },
      { k: 'nextDue', label: 'Next Service Due', type: 'date' },
      { k: 'docFile', label: 'Invoice / Receipt (Upload)', type: 'file', nameKey: 'docFileName', full: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Date', mono: r => r.date ? fmtDate(r.date) : '—' },
      { label: 'Service', main: r => r.type || '—', sub: r => r.vendor },
      { label: 'Odometer', plain: r => num0(r.mileage) ? fmtNum(r.mileage) + ' mi' : '—' },
      { label: 'Cost', plain: r => r.cost || '—' },
      { label: 'Next Due', mono: r => r.nextDue ? fmtDate(r.nextDue) : '—' },
      { label: 'Doc', plain: r => r.docFileName || (r.docFile ? 'Attached' : '—') },
    ],
    sort: (a, b) => String(b.date || '').localeCompare(String(a.date || '')),
    summary: rows => { const ds = rows.map(r => r.date).filter(Boolean).sort(); const last = ds[ds.length - 1]; return [['Records', String(rows.length)], ['Last Service', last ? fmtDate(last) : '—']]; },
  },
  odometer: {
    title: 'Odometer Reading', plural: 'Odometer Log', empty: 'No odometer readings yet. A reading is required once a year per vehicle.',
    fields: [
      { k: 'date', label: 'Reading Date', type: 'date', req: true },
      { k: 'mileage', label: 'Odometer (mi)', type: 'number', req: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Date', mono: r => r.date ? fmtDate(r.date) : '—' },
      { label: 'Odometer', main: r => num0(r.mileage) ? fmtNum(r.mileage) + ' mi' : '—' },
      { label: 'Notes', plain: r => r.notes || '—' },
    ],
    sort: (a, b) => String(b.date || '').localeCompare(String(a.date || '')),
    summary: rows => { const ds = rows.map(r => r.date).filter(Boolean).sort(); const last = ds[ds.length - 1]; const dl = last ? dleft(last) : null; const days = dl == null ? null : -dl; const st = days == null ? 'No reading on file' : days > 365 ? `Overdue (${days}d)` : `Current (${days}d ago)`; return [['Readings', String(rows.length)], ['Last Reading', last ? fmtDate(last) : '—'], ['Annual Status', st]]; },
  },
};

// Property edit form (Neil's PROPERTY_FIELDS).
// The ONLY allowed Development Stage values (standard — do not add others).
const DEV_STAGES = ['Entitlement', 'Construction Drawing', 'Construction', 'Stabilized', 'Inactive'];
// Timeline item status options + columns (status shown last, after Notes; edited via the status button only).
const STATUS_OPTIONS = ['Complete', 'Pending', 'In Progress', 'N/A'];
const TIMELINE_COLS = [['phase', 'Phase'], ['permit', 'Permit / Approval'], ['agency', 'Issuing Agency'], ['whenRequired', 'When Required'], ['submittals', 'Key Submittals'], ['reviewTime', 'Review Time'], ['notes', 'Notes'], ['status', 'Status', STATUS_OPTIONS]];
// Asset-type categories for the portfolio filter (Storage vs Office vs etc.).
const ASSET_TYPES = ['Self-Storage', 'RV Storage', 'Retail', 'Office / Medical', 'Residential', 'Mixed-Use', 'Land', 'Vehicle', 'Heavy Equipment', 'Other'];
// Asset type: use the explicit field if set, else derive a category from the
// snapshot's Proposed/Current Use text so existing properties classify sensibly.
function deriveAssetType(p) {
  if (p.assetType) return p.assetType;
  const snapVal = (label) => { for (const g of (p.snapshot || [])) for (const f of (g.fields || [])) { if ((f.label || '').trim().toLowerCase() === label.toLowerCase()) return f.value || ''; } return ''; };
  const classify = (raw) => {
    const t = (raw || '').toLowerCase(); if (!t.trim()) return '';
    if (/office|medical/.test(t)) return 'Office / Medical';
    if (/retail|taco|drive/.test(t)) return 'Retail';
    if (/\brv\b/.test(t)) return 'RV Storage';
    if (/storage|mini storage/.test(t)) return 'Self-Storage';
    if (/residential|single family|dwelling/.test(t) && /commerc/.test(t)) return 'Mixed-Use';
    if (/residential|single family|dwelling/.test(t)) return 'Residential';
    if (/commerc/.test(t)) return 'Retail';
    if (/vacant|land|stock pil|parking/.test(t)) return 'Land';
    return 'Other';
  };
  return classify(snapVal('Proposed Use')) || classify(snapVal('Current Use')) || '';
}
// Broad asset CATEGORY — a separate, single-select filter (Neil) distinct from the detailed
// asset-type field above. Picking one hides everything in the other categories.
const ASSET_CATEGORIES = ['Commercial', 'Residential', 'Industrial', 'Fleet & Equipment'];
function deriveCategory(p) {
  if (inferAssetKind(p) !== 'property') return 'Fleet & Equipment';
  const snapVal = (label) => { for (const g of (p.snapshot || [])) for (const f of (g.fields || [])) { if ((f.label || '').trim().toLowerCase() === label.toLowerCase()) return f.value || ''; } return ''; };
  const t = `${p.type || ''} ${p.parcelRole || ''} ${snapVal('Proposed Use')} ${snapVal('Current Use')} ${p.name || ''}`.toLowerCase();
  if (/industrial|warehouse|distribution|manufactur/.test(t)) return 'Industrial';
  const residential = /residential|single family|dwelling|residence|\bhome\b|apartment|duplex|\bfamily\b/.test(t);
  // Storage / retail / office / hospitality / RV / "commercial" mark it as commercial; a property
  // that's both (mixed-use) leans Commercial. Only a purely residential one is Residential.
  const commercial = /commerc|commeric|retail|office|medical|storage|\brv\b|hospitality|hotel|motel|\binn\b|restaurant|mixed.?use|bank/.test(t);
  if (residential && !commercial) return 'Residential';
  return 'Commercial';
}
// Card metrics tailored to the asset TYPE — a self-storage facility and an office building don't
// share the same relevant numbers. Storage shows units/vehicle; office/retail/residential show
// RSF, stories, year built; land shows acreage/zoning/flood. Returns {v,l}[] (3–5 metrics).
function cardStats(pr) {
  const S = (v, l) => ({ v, l });
  const acres = num0(pr.acreage) ? num0(pr.acreage).toFixed(2) : '—';
  const nrsf = fmtNum(pr.nrsf);
  const stories = pr.stories ? String(pr.stories) : '—';
  const year = pr.yearBuilt ? String(pr.yearBuilt) : '—';
  const storage = num0(pr.unitsNonClimate) + num0(pr.unitsClimate);
  const units = storage ? fmtNum(storage) : '—';
  const rv = num0(pr.unitsRV) ? fmtNum(pr.unitsRV) : '—';
  const total = num0(pr.unitsTotal) ? fmtNum(pr.unitsTotal) : '—';
  const typeText = `${pr.type || ''} ${pr.parcelRole || ''} ${assetTypeLabel(pr)}`.toLowerCase();
  // Vehicles & equipment get fleet metrics, not real-estate ones.
  const kind = inferAssetKind(pr);
  const makeModel = [pr.make, pr.model, pr.trim].filter(Boolean).join(' ') || pr.makeModel || pr.parcelRole || '—';
  if (kind === 'vehicle') return [S(year, 'Year'), S(num0(pr.odometer) ? fmtNum(pr.odometer) + ' mi' : '—', 'Odometer'), S(makeModel, 'Make / Model'), S(pr.devStage || '—', 'Status')];
  if (kind === 'equipment') return [S(year, 'Year'), S(num0(pr.hours) ? fmtNum(pr.hours) + ' hrs' : '—', 'Hours'), S(makeModel, 'Make / Model'), S(pr.devStage || '—', 'Status')];
  const t = deriveAssetType(pr);
  if (t === 'Self-Storage' || /self.?storage|mini.?storage/.test(typeText)) return [S(acres, 'Acres'), S(nrsf, 'NRSF'), S(units, 'Units'), S(rv, 'Vehicle'), S(total, 'Total')];
  if (t === 'RV Storage' || /\brv\b|boat/.test(typeText)) return [S(acres, 'Acres'), S(nrsf, 'NRSF'), S(rv, 'Spaces'), S(total, 'Total')];
  if (/hotel|hospitality|motel|\binn\b/.test(typeText)) return [S(nrsf, 'RSF'), S(stories, 'Stories'), S(year, 'Built'), S(acres, 'Acres')];
  if (t === 'Office / Medical') return [S(nrsf, 'RSF'), S(stories, 'Stories'), S(year, 'Built'), S(acres, 'Acres')];
  if (t === 'Retail') return [S(nrsf, 'GLA'), S(acres, 'Acres'), S(stories, 'Stories'), S(year, 'Built')];
  if (t === 'Residential') return [S(nrsf, 'SF'), S(acres, 'Acres'), S(stories, 'Stories'), S(year, 'Built')];
  if (t === 'Mixed-Use') return [S(nrsf, 'NRSF'), S(total !== '—' ? total : units, 'Units'), S(acres, 'Acres'), S(stories, 'Stories')];
  if (t === 'Land' || /vacant|land/.test(typeText)) return [S(acres, 'Acres'), S(pr.zoning || '—', 'Zoning'), S(pr.floodZone || '—', 'Flood')];
  return [S(acres, 'Acres'), S(nrsf, 'NRSF'), S(stories, 'Stories'), S(year, 'Built')];
}
// Short, simple asset-type label shown on the card (Neil: "office building, storage facility,
// land" — not a full sentence). Empty types fall back to nothing.
const TYPE_LABEL = {
  'Self-Storage': 'Self-storage facility',
  'RV Storage': 'RV storage facility',
  'Retail': 'Retail building',
  'Office / Medical': 'Office building',
  'Residential': 'Residential',
  'Mixed-Use': 'Mixed-use',
  'Land': 'Land',
  'Vehicle': 'Vehicle',
  'Heavy Equipment': 'Heavy equipment',
  'Other': '',
};
// Card label — prefer the property's own descriptive type/use (e.g. "RV & Mini Storage Facility",
// "Retail (Taco Bell / Drive-Thru)"), falling back to the generic label when there's no data.
const assetTypeLabel = (pr) => {
  const snapVal = (label) => { for (const g of (pr.snapshot || [])) for (const f of (g.fields || [])) { if ((f.label || '').trim().toLowerCase() === label.toLowerCase()) return String(f.value || '').trim(); } return ''; };
  return (pr.type || snapVal('Proposed Use') || snapVal('Current Use') || TYPE_LABEL[deriveAssetType(pr)] || pr.parcelRole || '').trim();
};
// Asset-type icon (a different lucide icon per type) — for the small card badge.
const TYPE_ICON = {
  'Self-Storage': Warehouse,
  'RV Storage': Truck,
  'Retail': Store,
  'Office / Medical': Stethoscope,
  'Residential': Home,
  'Mixed-Use': Building,
  'Land': Trees,
  'Vehicle': Car,
  'Heavy Equipment': Wrench,
  'Other': Building2,
};
const assetTypeIcon = (pr) => TYPE_ICON[deriveAssetType(pr)] || Building2;
// Region = the US state, from the explicit field or parsed from the address (", CA 92082" → CA).
function deriveRegion(p) {
  const st = String(p.state || '').trim();
  if (st) return st.length === 2 ? st.toUpperCase() : st;
  const m = String(p.address || '').match(/,\s*([A-Za-z]{2})\s+\d{5}/);
  return m ? m[1].toUpperCase() : '';
}
const PROPERTY_FIELDS = [
  { sec: 'Identity & ownership' },
  { k: 'name', label: 'Property / parcel name', req: true },
  { k: 'parentId', label: 'Role — leave blank for a PRIMARY asset, or pick the primary to make this a SECONDARY linked under it', type: 'select', dynamic: 'primaries' },
  { k: 'parcelRole', label: 'Parcel role (e.g. RV yard, detention, outparcel)' },
  { k: 'entity', label: 'Operating entity' }, { k: 'builder', label: 'Builder (GC)' }, { k: 'manager', label: 'PM / Asset Manager' },
  { k: 'address', label: 'Street address', req: true },
  { k: 'city', label: 'City' }, { k: 'state', label: 'State' }, { k: 'zip', label: 'ZIP' },
  { k: 'county', label: 'County' }, { k: 'apn', label: 'APN' },
  { k: 'legalDesc', label: 'Legal description', full: true },
  { sec: 'Building & site' },
  { k: 'assetType', label: 'Asset type', type: 'select', options: ASSET_TYPES },
  { k: 'devStage', label: 'Development Stage', type: 'select', options: DEV_STAGES },
  { k: 'yearBuilt', label: 'Year built' }, { k: 'constructionType', label: 'Construction type' }, { k: 'stories', label: 'Stories', type: 'number' },
  { k: 'nrsf', label: 'NRSF', type: 'number' }, { k: 'gsf', label: 'GSF', type: 'number' }, { k: 'acreage', label: 'Acreage', type: 'number' },
  { k: 'zoning', label: 'Zoning / land use' }, { k: 'floodZone', label: 'Flood zone' },
  { k: 'sprinklered', label: 'Sprinklered' }, { k: 'alarmMonitored', label: 'Alarm monitored' },
  { sec: 'Placed in service' },
  { k: 'placedInService', label: 'Placed-in-service date', type: 'date' }, { k: 'coNumber', label: 'CO number' }, { k: 'coDate', label: 'CO date', type: 'date' },
  { sec: 'Unit mix' },
  { k: 'unitsNonClimate', label: 'Non-climate units', type: 'number' }, { k: 'unitsClimate', label: 'Climate units', type: 'number' },
  { k: 'unitsRV', label: 'RV / boat spaces', type: 'number' }, { k: 'unitsMailbox', label: 'Mailbox units', type: 'number' },
  { k: 'unitsTotal', label: 'Total units (excludes mailbox)', type: 'number' },
  { sec: 'Insurance' },
  { k: 'insCarrier', label: 'Carrier' }, { k: 'insPolicy', label: 'Policy #' }, { k: 'insExpiration', label: 'Policy expiration', type: 'date' },
  { k: 'insAgent', label: 'Agent / broker' }, { k: 'insPhone', label: 'Agent phone' },
  { sec: 'Property tax' },
  { k: 'taxId', label: 'Tax account #' }, { k: 'taxAnnual', label: 'Annual tax ($)', type: 'number' }, { k: 'taxDue', label: 'Due dates' },
  { sec: 'Notes' },
  { k: 'notes', label: 'Notes', type: 'textarea', full: true },
];
// Map a property field's log LABEL back to its data key — lets the activity log undo a field edit
// by restoring the previous value.
const PROP_LABEL_KEY = Object.fromEntries(PROPERTY_FIELDS.filter(f => !f.sec && f.k).map(f => [f.label, f.k]));

/* ---------- asset classes: property | vehicle | equipment ----------
   Vehicles & equipment are a separate asset class that lives in the same
   portfolio (no property/site fields; their own Overview + Service & Odometer
   logs). `kind` is the source of truth, `assetType` the display fallback. */
const ASSET_KINDS = [['property', 'Property / Real estate'], ['vehicle', 'Vehicle'], ['equipment', 'Heavy equipment']];
const VEHICLE_FIELDS = [
  { sec: 'Vehicle' },
  { k: 'name', label: 'Asset name / unit #', req: true },
  { k: 'make', label: 'Make' }, { k: 'model', label: 'Model' }, { k: 'trim', label: 'Trim' },
  { k: 'yearBuilt', label: 'Model year' },
  { k: 'vin', label: 'VIN' }, { k: 'plate', label: 'License plate' }, { k: 'color', label: 'Color' },
  { k: 'odometer', label: 'Odometer (mi)', type: 'number' },
  { k: 'devStage', label: 'Status', type: 'select', options: ['Active', 'In Service', 'In Repair', 'Out of Service', 'Retired'] },
  { sec: 'Assignment & ownership' },
  { k: 'entity', label: 'Owner / entity' }, { k: 'manager', label: 'Assigned to / operator' },
  { k: 'address', label: 'Home base / location', full: true },
  { sec: 'Registration & title' },
  { k: 'regNumber', label: 'Registration #' }, { k: 'regExpiration', label: 'Registration expiration', type: 'date' },
  { k: 'titleNumber', label: 'Title #' },
  { sec: 'Service & maintenance' },
  { k: 'serviceIntervalMi', label: 'Service interval (mi)', type: 'number' }, { k: 'nextServiceMi', label: 'Next service (mi)', type: 'number' },
  { k: 'lastServiceDate', label: 'Last service', type: 'date' }, { k: 'nextServiceDate', label: 'Next service due', type: 'date' },
  { sec: 'Insurance & coverage' },
  { k: 'insCarrier', label: 'Carrier' }, { k: 'insPolicy', label: 'Policy #' }, { k: 'insExpiration', label: 'Policy expiration', type: 'date' },
  { k: 'insAgent', label: 'Agent / broker' }, { k: 'insPhone', label: 'Agent phone' },
  { sec: 'Notes' },
  { k: 'notes', label: 'Notes', type: 'textarea', full: true },
];
const EQUIPMENT_FIELDS = [
  { sec: 'Equipment' },
  { k: 'name', label: 'Asset name / unit #', req: true },
  { k: 'make', label: 'Make' }, { k: 'model', label: 'Model' }, { k: 'trim', label: 'Trim' },
  { k: 'yearBuilt', label: 'Year' },
  { k: 'equipType', label: 'Equipment type' }, { k: 'serialNumber', label: 'Serial #' },
  { k: 'hours', label: 'Hour meter', type: 'number' },
  { k: 'devStage', label: 'Status', type: 'select', options: ['Active', 'In Service', 'In Repair', 'Out of Service', 'Retired'] },
  { sec: 'Assignment & ownership' },
  { k: 'entity', label: 'Owner / entity' }, { k: 'manager', label: 'Assigned to / operator' },
  { k: 'address', label: 'Home base / location', full: true },
  { sec: 'Service & maintenance' },
  { k: 'serviceIntervalHrs', label: 'Service interval (hrs)', type: 'number' }, { k: 'nextServiceHrs', label: 'Next service (hrs)', type: 'number' },
  { k: 'lastServiceDate', label: 'Last service', type: 'date' }, { k: 'nextServiceDate', label: 'Next service due', type: 'date' },
  { sec: 'Insurance & coverage' },
  { k: 'insCarrier', label: 'Carrier' }, { k: 'insPolicy', label: 'Policy #' }, { k: 'insExpiration', label: 'Policy expiration', type: 'date' },
  { k: 'insAgent', label: 'Agent / broker' }, { k: 'insPhone', label: 'Agent phone' },
  { sec: 'Notes' },
  { k: 'notes', label: 'Notes', type: 'textarea', full: true },
];
const ASSET_SCHEMAS = { vehicle: VEHICLE_FIELDS, equipment: EQUIPMENT_FIELDS };
// Resolve an asset's class. `kind` wins; else sniff `assetType`; else it's a property.
function inferAssetKind(p) {
  if (!p) return 'property';
  if (p.kind) return p.kind;
  const a = String(p.assetType || '').toLowerCase();
  if (/vehicle/.test(a)) return 'vehicle';
  if (/equipment/.test(a)) return 'equipment';
  return 'property';
}
// Build the grouped snapshot ([{group,fields:[{label,value}]}]) the Overview tab renders, from a
// field schema + a flat value map. Sections ({sec}) become groups; fields carry their label+value.
function buildAssetSnapshot(schema, vals) {
  const groups = []; let cur = null;
  for (const f of schema) {
    if (f.sec) { cur = { group: f.sec, fields: [] }; groups.push(cur); continue; }
    if (!cur) { cur = { group: 'Details', fields: [] }; groups.push(cur); }
    cur.fields.push({ label: f.label, value: vals[f.k] ?? '' });
  }
  return groups.filter(g => g.fields.length);
}
// Seed vehicles (images already in public/assets/properties/). Equipment ships no seeds.
const mkVehicle = (id, name, make, model, trim, yearBuilt, color, image, extra = {}) => {
  const vals = { name, make, model, trim, yearBuilt, color, devStage: 'Active', ...extra };
  return { id, name, kind: 'vehicle', assetType: 'Vehicle', image, ...vals, snapshot: buildAssetSnapshot(VEHICLE_FIELDS, vals) };
};
const VEHICLE_SEEDS = [
  mkVehicle('ford-expedition-tremor', 'Ford Expedition Tremor', 'Ford', 'Expedition', 'Tremor', '2026', 'White', '/assets/properties/ford-expedition-tremor.png'),
  mkVehicle('tesla-model-x', 'Tesla Model X', 'Tesla', 'Model X', '', '2016', 'White', '/assets/properties/tesla-model-x.webp'),
  mkVehicle('tesla-model-y', 'Tesla Model Y', 'Tesla', 'Model Y', '', '2020', 'Red', '/assets/properties/tesla-model-y.webp'),
  mkVehicle('honda-pilot-touring', 'Honda Pilot Touring', 'Honda', 'Pilot', 'Touring', '2016', 'White', '/assets/properties/honda-pilot.webp'),
  mkVehicle('toyota-corolla-hybrid', 'Toyota Corolla Hybrid', 'Toyota', 'Corolla', 'Hybrid', '2024', 'Silver', '/assets/properties/toyota-corolla.webp'),
];

// Per-property tabs. The change Log is intentionally NOT here — per Neil it is global and lives
// on the Manage page, not on each property card.
const TABS = [['portfolio', 'Portfolio'], ['property', 'Overview'], ['vservice', 'Service & Maintenance'], ['odometer', 'Odometer'], ['vdocs', 'Documents'], ['warranties', 'Warranties'], ['inspections', 'Inspections'], ['documents', 'Plans & Docs'], ['utilsahj', 'Utilities & AHJ'], ['vendors', 'Vendors'], ['timeline', 'Timeline'], ['permit', 'Permits']];
// Which collection(s) the single top-bar Search filters for each tab (absent = no searchable table).
const TAB_COLLS = { vservice: ['vservice'], odometer: ['odometer'], vdocs: ['vdocs'], warranties: ['warranties'], inspections: ['inspections'], documents: ['documents'], utilsahj: ['utilities', 'ahj'], vendors: ['vendors'] };
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
function Chip({ c, children, onClick }) {
  const click = onClick ? { onClick: (e) => { e.stopPropagation(); onClick(); }, title: 'Open' } : {};
  const cur = onClick ? { cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 } : {};
  if (c === 'mut') return <span {...click} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.72rem', fontWeight: 600, padding: '3px 9px', borderRadius: 999, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)', ...cur }}>{children}</span>;
  return <span {...click} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.72rem', fontWeight: 600, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', color: `hsl(${CC[c]})`, backgroundColor: `hsla(${CC[c]}, 0.12)`, ...cur }}><span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: `hsl(${CC[c]})` }} />{children}</span>;
}
const warrantyChip = (d) => d == null ? <Chip c="mut">No date</Chip> : d < 0 ? <Chip c="mut">Expired</Chip> : d <= 90 ? <Chip c="orange">{`Expires in ${d}d`}</Chip> : <Chip c="green">Active</Chip>;
const inspectionChip = (d) => d == null ? <Chip c="mut">No date</Chip> : d < 0 ? <Chip c="red">{`Overdue ${Math.abs(d)}d`}</Chip> : d <= 30 ? <Chip c="orange">{`Due in ${d}d`}</Chip> : d <= 90 ? <Chip c="orange">Due soon</Chip> : <Chip c="green">Current</Chip>;
const renewalChip = (d, label) => <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}><span style={{ fontFamily: MONO, fontSize: '0.78rem' }}>{label}</span>{d == null ? null : d < 0 ? <Chip c="red">{`Lapsed ${Math.abs(d)}d`}</Chip> : d <= 60 ? <Chip c="orange">{`Renews in ${d}d`}</Chip> : <Chip c="green">Current</Chip>}</span>;
const microLabel = { fontSize: '0.64rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' };

// Plain-English meaning for each stat label — shown as a hover tooltip so abbreviations are clear.
const STAT_TIP = {
  'Acres': 'Site size in acres', 'NRSF': 'Net Rentable Square Feet', 'RSF': 'Rentable Square Feet',
  'GLA SF': 'Gross Leasable Area (square feet)', 'GSF': 'Gross Square Feet', 'Storage': 'Storage units',
  'Units': 'Total units', 'Vehicle': 'RV / boat / vehicle spaces', 'RV / Boat': 'RV / boat spaces',
  'Total': 'Total units', 'Stories': 'Number of stories', 'Built': 'Year built', 'Flood': 'FEMA flood zone',
};
function Stat({ v, l, big }) {
  return <div title={STAT_TIP[l] || l}><div style={{ fontFamily: MONO, fontWeight: big ? 700 : 600, fontSize: big ? '1rem' : '0.82rem', color: 'var(--text-primary)' }}>{v}</div><div style={{ ...microLabel, marginTop: 2, cursor: 'help' }}>{l}</div></div>;
}

/* ---------- main component ---------- */
export default function AssetModule() {
  const role = useRole();
  const isManager = role?.can ? role.can('manager') : false; // managers (lvl ≥ 3) may remove warranties
  // Officer-residence privacy: only IT Admin / Global Admin (lvl ≥ 4) see private assets.
  const canSeePrivate = role?.can ? role.can('administrator') : false;
  const [data, setData] = useState(EMPTY_WS);
  const [loading, setLoading] = useState(true);
  const firstSaveSkip = useRef(true); // skip the save triggered by the initial server load
  const [tab, setTab] = useState('portfolio');
  const [activeId, setActiveId] = useState(null);
  const [filters, setFilters] = useState({});
  const [modal, setModal] = useState(null); // { type:'row', coll, id } | { type:'property', id }
  const [logsSeen, setLogsSeen] = useState(() => { try { return localStorage.getItem(LOGS_SEEN_KEY) || ''; } catch { return ''; } });
  const [highlight, setHighlight] = useState(null); // { tab, field, item, n } — flashes a field after "Go to"
  const [typeFilter, setTypeFilter] = useState(''); // asset-type filter — set by the clickable type cells in the brandbar
  const unseenLogs = (data.logs || []).filter(l => l.ts > logsSeen).length;
  const markLogsSeen = () => { const now = new Date().toISOString(); setLogsSeen(now); try { localStorage.setItem(LOGS_SEEN_KEY, now); } catch { /* ignore */ } };
  const openTab = (k) => { setTab(k); if (k === 'manage') { setActiveId(null); markLogsSeen(); } };
  // Jump from a log entry straight to the changed field's tab + flash it bright.
  const SECTION_TAB = { 'Property': 'property', 'Warranties': 'warranties', 'Inspections': 'inspections', 'Plans & Documents': 'documents', 'Authorities Having Jurisdiction': 'utilsahj', 'Utilities': 'utilsahj', 'Vendors': 'vendors', 'Timeline': 'timeline', 'Permit': 'permit', 'Linking': 'property' };
  const goToChange = (log) => {
    const t = SECTION_TAB[log.section] || 'property';
    if (log.propertyId) setActiveId(log.propertyId);
    setTab(t);
    setHighlight({ tab: t, section: log.section, field: log.changes?.[0]?.field || '', item: log.item || '', n: Date.now() });
  };

  // Load the shared workspace from the server; the first run (empty store) seeds it from the
  // bundled portfolio JSON and persists that seed. Falls back to the local seed if the API is down.
  useEffect(() => {
    let alive = true;
    api.getPropertyWorkspace()
      .then(ws => {
        if (!alive) return;
        if (ws && Array.isArray(ws.properties) && ws.properties.length) {
          setData(hydrate(ws));
        } else {
          const seed = seedData();
          setData(seed);
          api.savePropertyWorkspace(seed).catch(() => {});
        }
      })
      .catch(() => { if (alive) setData(seedData()); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // Persist the whole workspace to the server (debounced). Skips the render caused by the initial
  // load so we don't immediately echo back the data we just fetched.
  useEffect(() => {
    if (loading) return;
    if (firstSaveSkip.current) { firstSaveSkip.current = false; return; }
    const t = setTimeout(() => { api.savePropertyWorkspace(data).catch(() => {}); }, 700);
    return () => clearTimeout(t);
  }, [data, loading]);
  // While viewing the Manage page (which hosts the log), keep logs marked seen so the badge stays clear.
  useEffect(() => {
    if (tab === 'manage') {
      const now = new Date().toISOString();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLogsSeen(now);
      try { localStorage.setItem(LOGS_SEEN_KEY, now); } catch { /* ignore */ }
    }
  }, [tab, data.logs]);
  // Auto-clear the field highlight a few seconds after a "Go to".
  useEffect(() => { if (highlight) { const id = setTimeout(() => setHighlight(null), 4000); return () => clearTimeout(id); } }, [highlight]);
  // On open (once the workspace has loaded), scan for expiring warranties / due inspections /
  // vehicle reg+insurance+service and raise deduped bell reminders to managers (server-side).
  useEffect(() => { if (!loading) api.scanPropertyReminders().catch(() => {}); }, [loading]);

  if (loading) return <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 500, fontSize: '0.9rem' }}>Loading portfolio…</div>;

  // live cards (deleted ones go to the recover bin); private officer residences are hidden
  // from anyone below IT Admin.
  const props = data.properties.filter(p => !p.deleted && (canSeePrivate || !p.private));
  const deletedProps = data.properties.filter(p => p.deleted);
  const byId = (id) => props.find(p => p.id === id);
  const active = activeId ? byId(activeId) : null;
  const rowsFor = (coll) => (data[coll] || []).filter(r => r.propertyId === activeId);

  const openProperty = (id, toTab = 'property') => { setActiveId(id); setTab(toTab); };

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
  const deleteRow = (coll, id, reason) => {
    setData(d => {
      const row = d[coll].find(r => r.id === id); const prop = d.properties.find(p => p.id === activeId);
      const nd = { ...d, [coll]: d[coll].filter(r => r.id !== id) };
      return row ? pushLog(nd, { section: COLLECTIONS[coll].plural, property: prop?.name || '', propertyId: activeId, action: 'removed', item: rowTitle(coll, row), changes: [], reason: reason || '' }) : nd;
    });
    setModal(null);
  };
  // Officer-residence privacy toggle (admins only) — flips p.private + logs it.
  const togglePrivate = (id) => {
    if (!canSeePrivate) return;
    setData(d => {
      const arr = [...d.properties];
      const i = arr.findIndex(p => p.id === id);
      if (i < 0) return d;
      const prop = arr[i]; const nowPrivate = !prop.private;
      arr[i] = { ...prop, private: nowPrivate };
      return pushLog({ ...d, properties: arr }, { section: 'Property', property: prop.name, propertyId: id, action: nowPrivate ? 'marked private' : 'made public', item: prop.name, changes: [] });
    });
  };
  // Field-level "flag for review" (⚐) — stores {g,f,ts,user} on p.reviewFlags. Toggling logs it.
  const toggleReviewFlag = (propId, group, field) => {
    setData(d => {
      const arr = [...d.properties];
      const i = arr.findIndex(p => p.id === propId); if (i < 0) return d;
      const prop = arr[i]; const flags = [...(prop.reviewFlags || [])];
      const at = flags.findIndex(f => f.g === group && f.f === field);
      let action;
      if (at >= 0) { flags.splice(at, 1); action = 'unflagged'; }
      else { flags.push({ g: group, f: field, ts: new Date().toISOString(), user: role?.myEmail || '' }); action = 'flagged for review'; }
      arr[i] = { ...prop, reviewFlags: flags };
      return pushLog({ ...d, properties: arr }, { section: 'Property', property: prop.name, propertyId: propId, action, item: `${group} — ${field}`, changes: [] });
    });
  };
  // Jump to a flagged field and flash it (reuses the highlight mechanism).
  const openToField = (id, group, field) => {
    setActiveId(id); setTab('property');
    setHighlight({ tab: 'property', section: group, field, item: '', n: Date.now() });
  };
  // Timeline / Permit rows live on the property object (active.timeline / active.permits)
  // as plain arrays without ids — edit & delete operate by original array index.
  const savePropList = (field, index, values, fields, reason) => {
    const lbl = field === 'timeline' ? 'Timeline' : 'Permit';
    const titleOf = (v) => { for (const [k] of (fields || [])) { const t = String(v?.[k] ?? '').trim(); if (t) return t; } return lbl + ' row'; };
    setData(d => {
      const arr = [...d.properties];
      const i = arr.findIndex(p => p.id === activeId);
      if (i < 0) return d;
      const prop = arr[i]; const list = [...(prop[field] || [])]; let entry;
      const base = { section: lbl, property: prop.name, propertyId: activeId };
      if (index != null && index >= 0 && index < list.length) {
        const old = list[index]; list[index] = { ...old, ...values };
        const changes = (fields || []).filter(([k]) => String(old[k] ?? '') !== String(values[k] ?? '')).map(([k, l]) => ({ field: l || k, from: String(old[k] ?? ''), to: String(values[k] ?? '') }));
        if (changes.length) entry = { ...base, action: 'edited', item: titleOf(list[index]), changes, reason: reason || '' };
      } else {
        list.push({ ...values }); entry = { ...base, action: 'added', item: titleOf(values), changes: [] };
      }
      arr[i] = { ...prop, [field]: list };
      const nd = { ...d, properties: arr };
      return entry ? pushLog(nd, entry) : nd;
    });
    setModal(null);
  };
  const deletePropList = (field, index, fields) => {
    const lbl = field === 'timeline' ? 'Timeline' : 'Permit';
    const titleOf = (v) => { for (const [k] of (fields || [])) { const t = String(v?.[k] ?? '').trim(); if (t) return t; } return lbl + ' row'; };
    setData(d => {
      const arr = [...d.properties];
      const i = arr.findIndex(p => p.id === activeId);
      if (i < 0) return d;
      const prop = arr[i]; const list = [...(prop[field] || [])];
      if (index == null || index < 0 || index >= list.length) return d;
      const row = list[index]; list.splice(index, 1);
      arr[i] = { ...prop, [field]: list };
      const nd = { ...d, properties: arr };
      return pushLog(nd, { section: lbl, property: prop.name, propertyId: activeId, action: 'removed', item: titleOf(row), changes: [] });
    });
    setModal(null);
  };
  // Save the property's picture gallery (multiple images) from the Location & media section.
  const saveImages = (images) => {
    setData(d => {
      const arr = [...d.properties];
      const i = arr.findIndex(p => p.id === activeId);
      if (i < 0) return d;
      const prop = arr[i];
      const before = (prop.images && prop.images.length) ? prop.images.length : (prop.image ? 1 : 0);
      arr[i] = { ...prop, images, image: images[0] || '' };
      const nd = { ...d, properties: arr };
      return before === images.length ? nd : pushLog(nd, { section: 'Property', property: prop.name, propertyId: activeId, action: 'edited', item: prop.name, changes: [{ field: 'Pictures', from: `${before} photo${before === 1 ? '' : 's'}`, to: `${images.length} photo${images.length === 1 ? '' : 's'}` }] });
    });
  };
  const saveProperty = (id, values, reason, link) => {
    setData(d => {
      let arr = [...d.properties];
      let newId = id; let action = 'edited'; let oldParent = ''; let changes = []; let propName;
      if (id) {
        const i = arr.findIndex(p => p.id === id);
        if (i < 0) return d;
        const old = arr[i]; oldParent = old.parentId || '';
        // parentId is handled by the linking block below, so exclude it from the field diff.
        changes = fieldDiff(PROPERTY_FIELDS.filter(f => f.k !== 'parentId'), old, values);
        arr[i] = { ...old, ...values }; propName = arr[i].name;
      } else {
        const np = { id: uidGen(), parentId: '', siteName: '', ...values }; newId = np.id; arr.push(np);
        setTimeout(() => setActiveId(np.id), 0); action = 'added'; propName = np.name;
      }
      // Apply linking. role: 'none' = standalone, 'secondary' = this links under target's primary,
      // 'primary' = target's whole group links under THIS property.
      if (link) {
        const primaryOf = (pid) => { const t = arr.find(x => x.id === pid); return t ? (t.parentId || t.id) : ''; };
        if (link.role === 'none') {
          // Only unlink a property that is currently a SECONDARY. A primary (no parent) keeps its
          // group title + children untouched.
          arr = arr.map(x => (x.id === newId && x.parentId) ? { ...x, parentId: '', siteName: '' } : x);
        } else if (link.role === 'secondary' && link.targetId) {
          const gp = primaryOf(link.targetId);
          const gpProp = arr.find(x => x.id === gp);
          const title = (gpProp?.siteName || gpProp?.name || '').trim();
          arr = arr.map(x => x.id === newId ? { ...x, parentId: gp, siteName: title }
            : (x.id === gp && !x.siteName ? { ...x, siteName: title } : x));
        } else if (link.role === 'primary' && link.targetId) {
          const gp = primaryOf(link.targetId);
          const me = arr.find(x => x.id === newId);
          const title = (me?.siteName || me?.name || '').trim();
          arr = arr.map(x => {
            if (x.id === newId) return { ...x, parentId: '', siteName: title };
            if (x.id === gp || x.parentId === gp) return { ...x, parentId: newId, siteName: title };
            return x;
          });
        }
      }
      // Record a "Linked under" change when the relationship changed on an edit.
      const newParent = (arr.find(x => x.id === newId)?.parentId) || '';
      if (id && oldParent !== newParent) {
        const nm = (pid) => pid ? (arr.find(x => x.id === pid)?.name || '(removed)') : 'Standalone';
        changes = [...changes, { field: 'Linked under', from: nm(oldParent), to: nm(newParent) }];
      }
      let entry;
      if (action === 'added') entry = { section: 'Property', property: propName, propertyId: newId, action: 'added', item: propName, changes: [] };
      else if (changes.length) entry = { section: 'Property', property: propName, propertyId: newId, action: 'edited', item: propName, changes, reason: reason || '' };
      const nd = { ...d, properties: arr };
      return entry ? pushLog(nd, entry) : nd;
    });
    setModal(null);
  };
  // Soft-delete a property → moves it to the recover bin (recoverable). If it was a primary, its
  // secondaries become standalone (parentId cleared). Permanent removal is a separate action.
  const deleteProperty = (id, keepOpen) => {
    setData(d => {
      const p = d.properties.find(x => x.id === id);
      const nd = { ...d, properties: d.properties.map(x => {
        if (x.id === id) return { ...x, deleted: true, deletedAt: new Date().toISOString() };
        if (x.parentId === id) return { ...x, parentId: '', siteName: '' };
        return x;
      }) };
      return p ? pushLog(nd, { section: 'Property', property: p.name, propertyId: id, action: 'removed', item: p.name, changes: [] }) : nd;
    });
    if (activeId === id) { setActiveId(null); setTab('portfolio'); }
    if (!keepOpen) setModal(null);
  };
  // Restore a soft-deleted property back to the portfolio.
  const recoverProperty = (id) => setData(d => {
    const p = d.properties.find(x => x.id === id);
    const nd = { ...d, properties: d.properties.map(x => x.id === id ? { ...x, deleted: false, deletedAt: '' } : x) };
    return p ? pushLog(nd, { section: 'Property', property: p.name, propertyId: id, action: 'edited', item: p.name, changes: [{ field: 'Status', from: 'Deleted', to: 'Recovered' }] }) : nd;
  });
  // Permanently remove a property (cannot be recovered).
  const purgeProperty = (id) => setData(d => ({ ...d, properties: d.properties.filter(x => x.id !== id) }));

  // ----- Undo (from the activity log) -----
  // Reliable, property-level undo: undo an add (→ soft-delete), a delete (→ recover), or a field
  // edit (→ restore the previous value). The undo is itself recorded so it stays auditable and can
  // be undone again. Returns true if this entry can be reversed cleanly.
  const canUndoLog = (log) => {
    if (!log || log.undone || log.section !== 'Property') return false;
    const p = data.properties.find(x => x.id === log.propertyId);
    if (!p) return false;
    if (log.action === 'added') return !p.deleted;
    if (log.action === 'removed') return !!p.deleted;
    if (log.action === 'edited') return (log.changes || []).some(c => PROP_LABEL_KEY[c.field] != null);
    return false;
  };
  const undoLog = (log) => {
    setData(d => {
      const arr = [...d.properties];
      const i = arr.findIndex(x => x.id === log.propertyId);
      if (i < 0) return d;
      const p = arr[i];
      let entry;
      if (log.action === 'added' && !p.deleted) {
        for (let j = 0; j < arr.length; j++) if (arr[j].parentId === p.id) arr[j] = { ...arr[j], parentId: '', siteName: '' };
        arr[i] = { ...p, deleted: true, deletedAt: new Date().toISOString() };
        entry = { section: 'Property', property: p.name, propertyId: p.id, action: 'removed', item: p.name, changes: [], reason: 'Undo — reversed an "Added"' };
      } else if (log.action === 'removed' && p.deleted) {
        arr[i] = { ...p, deleted: false, deletedAt: '' };
        entry = { section: 'Property', property: p.name, propertyId: p.id, action: 'edited', item: p.name, changes: [{ field: 'Status', from: 'Deleted', to: 'Recovered' }], reason: 'Undo — reversed a "Removed"' };
      } else if (log.action === 'edited') {
        const revert = {}; const changes = [];
        (log.changes || []).forEach(c => { const k = PROP_LABEL_KEY[c.field]; if (k != null) { revert[k] = c.from; changes.push({ field: c.field, from: c.to, to: c.from }); } });
        if (!changes.length) return d;
        arr[i] = { ...p, ...revert };
        entry = { section: 'Property', property: arr[i].name, propertyId: p.id, action: 'edited', item: arr[i].name, changes, reason: 'Undo — restored previous value(s)' };
      } else return d;
      const logs = (d.logs || []).map(l => l.id === log.id ? { ...l, undone: true } : l);
      const nd = { ...d, properties: arr, logs };
      return entry ? pushLog(nd, entry) : nd;
    });
    if (activeId === log.propertyId && log.action === 'added') { setActiveId(null); setTab('manage'); }
  };

  /* ----- render ----- */
  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      <style>{`
        @keyframes assetShimmer { 0% { background-position: -220px 0 } 100% { background-position: 220px 0 } }
        .asset-card { cursor: pointer; outline: none; transition: transform .18s cubic-bezier(.2,.7,.3,1), box-shadow .18s ease, border-color .18s ease; }
        .asset-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); border-color: var(--border-hover); }
        .asset-card:active { transform: translateY(-1px) scale(.995); }
        .asset-card:focus-visible { outline: 2px solid var(--pine); outline-offset: 2px; }
        .asset-card__cover { overflow: hidden; }
        .asset-card__img { transition: transform .4s cubic-bezier(.2,.7,.3,1), filter .25s ease, opacity .35s ease; }
        .asset-card:hover .asset-card__img { transform: scale(1.07); filter: brightness(1.05); }
        .asset-skeleton { background-image: linear-gradient(90deg, var(--bg-secondary) 0px, var(--border-color) 90px, var(--bg-secondary) 180px); background-size: 320px 100%; animation: assetShimmer 1.2s infinite linear; }
        .asset-card__open { opacity: 0; transition: opacity .15s ease; }
        .asset-card:hover .asset-card__open, .asset-card:focus-visible .asset-card__open { opacity: 1; }
        /* clear clickable highlight on linked-property / list rows */
        .asset-linkrow { position: relative; transition: background-color .14s ease, box-shadow .14s ease; }
        .asset-linkrow:hover { background-color: var(--bg-card); box-shadow: inset 0 0 0 1.5px var(--pine); }
        @media (max-width: 860px) { .asset-toc { display: none !important; } }
        /* review-flag toggle reveals on row hover; stays visible once flagged (.on) */
        .gt-frow:hover .gt-flag { opacity: 1 !important; }
      `}</style>
      {/* Landing header — only on the portfolio landing (hidden on the Manage page, which has its own) */}
      {!active && tab !== 'manage' && (() => {
        const st = headerStats(data);
        return (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <div>
              <h1 style={{ fontSize: '1.5rem', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '-0.02em', margin: 0 }}>Asset Management</h1>
              <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginTop: 4 }}>{st.assets} assets</div>
              <PortfolioPulse data={data} />
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <button className="primary-btn" onClick={() => openTab('manage')} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Settings size={14} /> Manage
                {unseenLogs > 0 && <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, fontSize: '0.64rem', fontWeight: 700, color: '#fff', backgroundColor: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{unseenLogs}</span>}
              </button>
            </div>
          </div>
        );
      })()}

      {/* Selected property name + address (left) + actions (right) — single header, on top of everything */}
      {active && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ fontSize: '1.5rem', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '-0.01em', color: 'var(--text-primary)', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {active.name}
                {active.private && <span style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '3px 8px', borderRadius: 999, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple),0.12)' }}>🔒 Private</span>}
              </h1>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 3 }}>{fmtAddress(active) || '—'}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
              {canSeePrivate && <button className="secondary-btn" onClick={() => togglePrivate(active.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{active.private ? 'Make public' : 'Mark private'}</button>}
              <button className="secondary-btn" onClick={() => exportReport(active, data)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileDown size={14} /> Export PDF</button>
              {tab === 'property' && <button className="primary-btn" onClick={() => setModal({ type: 'property', id: active.id })} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Pencil size={14} /> Edit {inferAssetKind(active) === 'property' ? 'property' : 'asset'}</button>}
            </div>
          </div>
          <HealthStrip p={active} data={data} />
        </div>
      )}

      {/* Per-property tabs — only when a property is selected (Portfolio is the landing) */}
      {active && (() => {
        const searchColls = TAB_COLLS[tab] || [];
        const queryTab = ['timeline', 'permit'].includes(tab);
        const showSearch = searchColls.length > 0 || queryTab;
        const searchVal = searchColls.length ? (filters[searchColls[0]] || '') : (queryTab ? (filters[tab] || '') : '');
        const onSearch = (v) => setFilters(f => { const n = { ...f }; if (searchColls.length) searchColls.forEach(c => { n[c] = v; }); else n[tab] = v; return n; });
        return (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20, padding: '7px 2px 2px' }}>
          <button onClick={() => { setActiveId(null); setTab('portfolio'); }} title="Back to portfolio"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', borderRadius: 999, border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <ArrowLeft size={14} /> Portfolio
          </button>
          {TABS.filter(([k]) => {
            if (k === 'portfolio') return false;
            // Vehicles/equipment show only Overview + their two logs; properties hide those.
            return inferAssetKind(active) === 'property'
              ? !['vservice', 'odometer', 'vdocs'].includes(k)
              : ['property', 'vservice', 'odometer', 'vdocs'].includes(k);
          }).map(([k, label]) => {
            const on = tab === k;
            const lbl = (k === 'property' && inferAssetKind(active) !== 'property') ? 'Overview' : label;
            return (
              <button key={k} onClick={() => openTab(k)}
                style={{ position: 'relative', padding: '8px 16px', borderRadius: 999, border: '1px solid', borderColor: on ? 'var(--pine)' : 'var(--border-color)', background: on ? 'var(--pine)' : 'var(--bg-card)', color: on ? '#fff' : 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {lbl}
              </button>
            );
          })}
          {/* search for searchable tabs — sits inline right after the last tab */}
          {showSearch && (
            <div style={{ position: 'relative', width: 220 }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input className="form-input" placeholder="Search…" value={searchVal} onChange={e => onSearch(e.target.value)} style={{ width: '100%', fontSize: '0.82rem', padding: '7px 10px 7px 32px' }} />
            </div>
          )}
        </div>
        );
      })()}

      {tab === 'portfolio' && !active && <CriticalDates store={data} openProperty={openProperty} />}
      {tab === 'portfolio' && !active && <FlaggedForReview props={props} openToField={openToField} onClear={toggleReviewFlag} />}
      {tab === 'portfolio' && !active && <Portfolio {...{ props, openProperty, typeFilter, setTypeFilter }} />}
      {active && <ParcelSwitcher p={active} props={props} openProperty={openProperty} />}
      {tab === 'property' && active && collectCriticalDates(data).some(x => x.id === active.id) && <CriticalDates store={data} openProperty={openProperty} only={active.id} />}
      {tab === 'property' && active && <PropertyDetail {...{ p: active, onSaveImages: saveImages, highlight: highlight?.tab === 'property' ? highlight : null, onToggleFlag: toggleReviewFlag }} />}
      {tab === 'warranties' && active && <Collection coll="warranties" rows={rowsFor('warranties')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'warranties' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'warranties', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'warranties', id })} />}
      {tab === 'inspections' && active && <Collection coll="inspections" rows={rowsFor('inspections')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'inspections' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'inspections', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'inspections', id })} />}
      {tab === 'documents' && active && <Collection coll="documents" rows={rowsFor('documents')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'documents' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'documents', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'documents', id })} />}
      {tab === 'utilsahj' && active && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Collection coll="utilities" collapsible rows={rowsFor('utilities')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.section === 'Utilities' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'utilities', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'utilities', id })} />
          <Collection coll="ahj" collapsible rows={rowsFor('ahj')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.section === 'Authorities Having Jurisdiction' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'ahj', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'ahj', id })} />
        </div>
      )}
      {tab === 'vendors' && active && <Collection coll="vendors" rows={rowsFor('vendors')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.section === 'Vendors' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'vendors', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'vendors', id })} />}
      {tab === 'vservice' && active && <Collection coll="vservice" rows={rowsFor('vservice')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'vservice' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'vservice', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'vservice', id })} />}
      {tab === 'odometer' && active && <Collection coll="odometer" rows={rowsFor('odometer')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'odometer' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'odometer', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'odometer', id })} />}
      {tab === 'vdocs' && active && <Collection coll="vdocs" rows={rowsFor('vdocs')} active={active} filters={filters} setFilters={setFilters} highlightItem={highlight?.tab === 'vdocs' ? highlight.item : ''} onAdd={() => setModal({ type: 'row', coll: 'vdocs', id: null })} onEdit={(id) => setModal({ type: 'row', coll: 'vdocs', id })} />}
      {tab === 'timeline' && active && (() => {
        const cols = TIMELINE_COLS;
        const editCols = cols.filter(c => c[0] !== 'status'); // status is changed via its button (reason required), not the row form
        return <EditTable title="Development Timeline" subtitle={active.name} rows={active.timeline} cols={cols} query={filters.timeline || ''} highlightItem={highlight?.section === 'Timeline' ? highlight.item : ''} onAdd={() => setModal({ type: 'plist', field: 'timeline', index: null, fields: editCols })} onEdit={(idx) => setModal({ type: 'plist', field: 'timeline', index: idx, fields: editCols })} onStatusClick={(idx, cur) => setModal({ type: 'tstatus', index: idx, current: cur })} />;
      })()}
      {tab === 'permit' && active && (() => {
        const cols = permitCols(active.permits);
        return <EditTable title="Permit Matrix" subtitle={active.name} rows={active.permits} cols={cols} query={filters.permit || ''} highlightItem={highlight?.section === 'Permit' ? highlight.item : ''} onAdd={() => setModal({ type: 'plist', field: 'permits', index: null, fields: cols })} onEdit={(idx) => setModal({ type: 'plist', field: 'permits', index: idx, fields: cols })} onDelete={(idx) => deletePropList('permits', idx, cols)} />;
      })()}
      {tab === 'manage' && !active && <ManagePage props={props} logs={data.logs || []} deletedProps={deletedProps} onBack={() => { setActiveId(null); setTab('portfolio'); }} onAdd={() => setModal({ type: 'property', id: null })} onDelete={(id) => deleteProperty(id, true)} onRecover={recoverProperty} onPurge={purgeProperty} onOpenProperty={openProperty} onGoTo={goToChange} onUndo={undoLog} canUndo={canUndoLog} />}

      {modal?.type === 'row' && <RowModal coll={modal.coll} row={modal.id ? data[modal.coll].find(r => r.id === modal.id) : null} canDelete={modal.coll === 'warranties' ? isManager : true} requireReason={modal.coll === 'warranties'} onSave={(v) => saveRow(modal.coll, modal.id, v)} onDelete={(reason) => deleteRow(modal.coll, modal.id, reason)} onClose={() => setModal(null)} />}
      {modal?.type === 'property' && <PropertyModal row={modal.id ? byId(modal.id) : null} properties={props} onSave={(v, reason, link) => saveProperty(modal.id, v, reason, link)} onDelete={() => deleteProperty(modal.id)} onClose={() => setModal(null)} />}
      {modal?.type === 'plist' && <ListRowModal title={modal.field === 'timeline' ? 'Timeline row' : 'Permit row'} fields={modal.fields} row={modal.index != null && active ? active[modal.field][modal.index] : null} onSave={(v) => savePropList(modal.field, modal.index, v, modal.fields)} onDelete={modal.index != null ? () => deletePropList(modal.field, modal.index, modal.fields) : null} onClose={() => setModal(null)} />}
      {modal?.type === 'tstatus' && <StatusModal current={modal.current} onSave={(status, date, reason) => savePropList('timeline', modal.index, { status, statusDate: date }, TIMELINE_COLS, reason)} onClose={() => setModal(null)} />}
    </div>
  );
}

/* ---------- portfolio ---------- */
// Colour for a Development Stage chip.
const stageColor = (s) => {
  const v = (s || '').toLowerCase();
  if (v.includes('inactive')) return 'gold';
  if (v.includes('stabil') || v.includes('active') || v.includes('built') || v.includes('in-use') || v.includes('in use') || v.includes('open') || v.includes('operat') || v.includes('developed')) return 'green';
  if (v.includes('construction')) return 'orange';
  if (v.includes('entitle')) return 'blue';
  return 'gold';
};
// Timeline item status → chip colour.
const statusColor = (s) => {
  const v = (s || '').toLowerCase();
  if (v.includes('complete')) return 'green';
  if (v.includes('progress')) return 'blue';
  if (v.includes('pending')) return 'gold';
  return 'mut';
};
// Address line — some records store the full address in `address`, others split it into
// city/state/zip. Append the parts only if they're not already in the address string, then
// collapse any duplicated text (e.g. a doubled "San Clemente, CA, 92672") so it shows once.
// Build a consistent address — street → City → STATE ZIP — for every property from the structured
// City / State / Zip fields. The raw `address` field often holds the WHOLE address (sometimes
// doubled, or with "County of …" / "City of …" / stray commas), so we split it into comma segments,
// drop everything that isn't street (city / state / zip / county), then re-assemble in fixed order.
function fmtAddress(p) {
  const city = String(p.city || '').replace(/^\s*(city|town|county)\s+of\s+/i, '').trim();
  let state = String(p.state || '').trim();
  let zip = String(p.zip || '').trim();
  const cityL = city.toLowerCase();
  const raw = String(p.address || '').trim();
  // Backfill State / ZIP from the address when the structured fields are blank (e.g. "…, CA 92672").
  if (!zip) { const m = raw.match(/\b([A-Za-z]{2})[\s,]+(\d{5})(?:-\d{4})?\b/); if (m) { zip = m[2]; if (!state) state = m[1].toUpperCase(); } }
  // Junk = anything in the address that isn't street: the city, state, zip, or a county line.
  const junk = (s) => {
    const low = s.toLowerCase();
    if (/^county\s+of\s+/i.test(s) || /\bcounty$/i.test(s)) return true;     // "County of San Diego" / "San Diego County"
    if (/^[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(s)) return true;               // "CA 92026"
    if (state && low === state.toLowerCase()) return true;                   // a bare state token
    if (zip && low === zip) return true;                                     // a bare ZIP equal to the field
    if (cityL && (low === cityL || low === `city of ${cityL}` || low === `town of ${cityL}`)) return true;
    return false;
  };
  const segs = raw.split(',').map(s => s.trim()).filter(Boolean);
  // The street is everything BEFORE the city segment (so a 5-digit house number is never mistaken
  // for a ZIP); drop any doubled junk that leaked in front of the city.
  const ci = segs.findIndex(s => { const low = s.toLowerCase(); return cityL && (low === cityL || low === `city of ${cityL}` || low === `town of ${cityL}`); });
  const streetSegs = (ci >= 0 ? segs.slice(0, ci) : segs).filter(s => !junk(s));
  // Rejoin a leading bare house-number segment with the next ("7970", "Woodbridge Parkway" → "7970 Woodbridge Parkway").
  const street = streetSegs.join(', ').replace(/^(\d+[a-z]?),\s+/i, '$1 ').trim();
  const stateZip = [state, zip].filter(Boolean).join(' ');
  return [street, city, stateZip].filter(Boolean).join(', ') || street;
}
// County label — avoid "Williamson County County" when the value already ends in "County".
function fmtCounty(c) {
  const v = String(c ?? '').trim();
  return !v ? '' : (/county$/i.test(v) ? v : v + ' County');
}
// Manage menu — the single entry point for portfolio actions (add / link / edit). Per Neil:
// everything that changes the portfolio happens through "Manage", not scattered buttons.
// A collapsible section used on the Manage page. Header shows a title, optional count badge,
// and a chevron; the body shows/hides on click.
function ManageSection({ title, sub, count, badge, open, onToggle, children }) {
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', backgroundColor: 'var(--bg-card)' }}>
      <button onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', padding: '14px 16px', border: 'none', background: 'transparent', cursor: 'pointer' }}>
        <ChevronDown size={17} style={{ flexShrink: 0, color: 'var(--text-secondary)', transition: 'transform 0.18s', transform: open ? 'none' : 'rotate(-90deg)' }} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1rem', fontWeight: 700, fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)' }}>{title}</span>
            {count != null && <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', padding: '1px 8px', borderRadius: 999 }}>{count}</span>}
            {badge}
          </span>
          {sub && <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</span>}
        </span>
      </button>
      {open && <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border-color)' }}><div style={{ paddingTop: 14 }}>{children}</div></div>}
    </div>
  );
}

// Manage PAGE (not a dropdown) — per Neil: one secondary management screen. Two collapsible
// sections: Properties (Add + every property) and Activity log (global, with Recover under it).
// Linking is not a standalone action here — it's folded into the Add property flow (the "Role" field).
function ManagePage({ props, logs, deletedProps, onBack, onAdd, onDelete, onRecover, onPurge, onOpenProperty, onGoTo, onUndo, canUndo }) {
  const [purge, setPurge] = useState(null); // property pending permanent-delete confirmation
  const [del, setDel] = useState(null); // property pending soft-delete confirmation
  const [pq, setPq] = useState(''); // properties search
  const [openProps, setOpenProps] = useState(true);
  const [openLogs, setOpenLogs] = useState(false);
  const q = pq.trim().toLowerCase();
  const ordered = [...props]
    .filter(p => !q || `${p.name} ${fmtAddress(p)} ${p.entity || ''}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div>
      {/* page header — back link, then a clean title row with the Add action on the right */}
      <button onClick={onBack} title="Back to portfolio"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 14, padding: '7px 13px', borderRadius: 999, border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' }}>
        <ArrowLeft size={14} /> Portfolio
      </button>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <span style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pine)', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}><Settings size={18} /></span>
            <h1 style={{ fontSize: '1.5rem', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '-0.02em', margin: 0 }}>Manage</h1>
          </div>
          <div style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', marginTop: 6, maxWidth: 620 }}>Add a property, open one to edit it on its own page, delete one, and review every change in the activity log (with undo).</div>
        </div>
        <button className="primary-btn" onClick={onAdd} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add property</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Property cards — Add + edit/delete every property */}
        <ManageSection title="Property cards" sub={`${props.length} ${props.length === 1 ? 'property' : 'properties'} — Add opens the full form; Open takes you to a property's page to edit it.`} open={openProps} onToggle={() => setOpenProps(o => !o)}>
          <div style={{ position: 'relative', maxWidth: 340, marginBottom: 14 }}>
            <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
            <input className="form-input" value={pq} onChange={e => setPq(e.target.value)} placeholder="Search properties…" style={{ width: '100%', padding: '8px 12px 8px 33px', fontSize: '0.82rem' }} />
          </div>
          {del && (
            <div style={{ marginBottom: 12, padding: '13px 14px', borderRadius: 11, border: '1px solid hsl(var(--color-red) / 0.4)', backgroundColor: 'hsl(var(--color-red) / 0.07)' }}>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Delete “{del.name}”?</div>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 11 }}>It moves to <strong>Recover deleted</strong> below and can be restored{props.some(x => x.parentId === del.id) ? '. Its linked secondaries become standalone.' : '.'}</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="secondary-btn" onClick={() => setDel(null)} style={{ fontSize: '0.8rem' }}>Cancel</button>
                <button className="primary-btn" onClick={() => { onDelete(del.id); setDel(null); }} style={{ fontSize: '0.8rem', backgroundColor: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}>Delete</button>
              </div>
            </div>
          )}
          {ordered.length === 0
            ? <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>{q ? 'No properties match your search.' : 'No properties yet. Use “Add property” to register the first asset.'}</div>
            : <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
                {ordered.map(p => {
                  const sc = p.devStage ? stageColor(p.devStage) : '';
                  return (
                    <div key={p.id} className="asset-linkrow"
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--border-color)' }}>
                      <div onClick={() => onOpenProperty(p.id)} title={`Open ${p.name}`} style={{ minWidth: 0, flex: 1, cursor: 'pointer' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</strong>
                          {p.parentId && <span style={{ flexShrink: 0, fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'hsl(var(--color-purple))' }}>Linked</span>}
                        </div>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtAddress(p) || '—'}</div>
                      </div>
                      {p.devStage && <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', padding: '3px 9px', borderRadius: 999, color: `hsl(var(--color-${sc}))`, backgroundColor: `hsla(var(--color-${sc}), 0.14)` }}><span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: `hsl(var(--color-${sc}))` }} />{p.devStage}</span>}
                      <button onClick={() => onOpenProperty(p.id)} title={`Open ${p.name} to edit`} className="secondary-btn" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', fontSize: '0.76rem' }}>Open <ArrowRight size={13} /></button>
                      <button onClick={() => setDel(p)} title={`Delete ${p.name}`}
                        style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-color)', background: 'transparent', color: 'hsl(var(--color-red))', cursor: 'pointer' }}
                        onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'hsl(var(--color-red) / 0.08)'; e.currentTarget.style.borderColor = 'hsl(var(--color-red))'; }}
                        onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.borderColor = 'var(--border-color)'; }}><Trash2 size={15} /></button>
                    </div>
                  );
                })}
              </div>}
        </ManageSection>

        {/* Activity log (global) — Recover sits under it */}
        <ManageSection title="Activity log" sub="Every change across all properties — newest first." badge={deletedProps.length > 0 ? <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'hsl(var(--color-orange))' }}>{deletedProps.length} recoverable</span> : null} open={openLogs} onToggle={() => setOpenLogs(o => !o)}>
          <LogsTab logs={logs} query="" onOpenProperty={onOpenProperty} activeId={null} activeName="" onGoTo={onGoTo} onUndo={onUndo} canUndo={canUndo} />

          <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '0.92rem', fontFamily: "'Plus Jakarta Sans', sans-serif", margin: '0 0 4px', color: 'var(--text-primary)' }}>Recover deleted</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 12 }}>Restore a deleted property card, or remove it permanently.</div>
            {purge && (
              <div style={{ marginBottom: 12, padding: '13px 14px', borderRadius: 11, border: '1px solid hsl(var(--color-red) / 0.4)', backgroundColor: 'hsl(var(--color-red) / 0.07)' }}>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Permanently delete “{purge.name}”?</div>
                <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 11 }}>This <strong>cannot be undone</strong> — the card is gone for good.</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="secondary-btn" onClick={() => setPurge(null)} style={{ fontSize: '0.8rem' }}>Cancel</button>
                  <button className="primary-btn" onClick={() => { onPurge(purge.id); setPurge(null); }} style={{ fontSize: '0.8rem', backgroundColor: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}>Delete forever</button>
                </div>
              </div>
            )}
            {deletedProps.length === 0
              ? <div style={{ padding: '14px', fontSize: '0.84rem', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 10 }}>No deleted property cards. Anything you delete will appear here.</div>
              : <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
                  {deletedProps.map(p => (
                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border-color)' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{p.name}</strong>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtAddress(p) || '—'}</div>
                      </div>
                      <button onClick={() => onRecover(p.id)} title={`Recover ${p.name}`} className="secondary-btn" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', fontSize: '0.78rem', color: 'var(--pine)', borderColor: 'var(--pine)' }}><RotateCcw size={14} /> Recover</button>
                      <button onClick={() => setPurge(p)} title={`Delete ${p.name} permanently`}
                        style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-color)', background: 'transparent', color: 'hsl(var(--color-red))', cursor: 'pointer' }}
                        onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'hsl(var(--color-red) / 0.08)'; e.currentTarget.style.borderColor = 'hsl(var(--color-red))'; }}
                        onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.borderColor = 'var(--border-color)'; }}><Trash2 size={15} /></button>
                    </div>
                  ))}
                </div>}
          </div>
        </ManageSection>
      </div>
    </div>
  );
}

function Portfolio({ props, openProperty, typeFilter, setTypeFilter }) {
  const [stageFilter, setStageFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState(''); // Commercial / Residential / Industrial
  const [view, setView] = useState('tile'); // 'tile' | 'list'
  const all = props.slice();
  if (!all.length) return <Empty>No properties yet. Use “Add property” to register the first one.</Empty>;
  let list = all.slice();
  if (categoryFilter) list = list.filter(pr => deriveCategory(pr) === categoryFilter);
  if (stageFilter) list = list.filter(pr => (pr.devStage || '') === stageFilter);
  if (typeFilter) list = list.filter(pr => deriveAssetType(pr) === typeFilter);
  if (regionFilter) list = list.filter(pr => deriveRegion(pr) === regionFilter);
  const catCount = (c) => all.filter(pr => deriveCategory(pr) === c).length;
  const stageCount = (s) => all.filter(pr => (pr.devStage || '') === s).length;
  // Asset-type counts (for the Asset type dropdown) — only types actually present.
  const typeCounts = {}; all.forEach(pr => { const t = deriveAssetType(pr); if (t) typeCounts[t] = (typeCounts[t] || 0) + 1; });
  const presentTypes = ASSET_TYPES.filter(t => typeCounts[t] > 0);
  // Region counts (for the Region dropdown) — distinct states present, sorted.
  const regionCounts = {}; all.forEach(pr => { const r = deriveRegion(pr); if (r) regionCounts[r] = (regionCounts[r] || 0) + 1; });
  const presentRegions = Object.keys(regionCounts).sort();
  const selStyle = { width: 'auto', padding: '7px 12px', fontSize: '0.82rem' };
  // Tile / List view toggle (reused on the top level and inside a group's drill-down).
  const viewToggle = (
    <div style={{ display: 'inline-flex', padding: 3, borderRadius: 999, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
      {[['tile', 'Tiles', LayoutGrid], ['list', 'List', List]].map(([k, lbl, Icon]) => (
        <button key={k} onClick={() => setView(k)} title={`${lbl} view`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 600, background: view === k ? 'var(--pine)' : 'transparent', color: view === k ? '#fff' : 'var(--text-secondary)' }}>
          <Icon size={14} /> {lbl}
        </button>
      ))}
    </div>
  );

  // Hierarchy: a primary asset (no parentId) is a top-level card; its secondaries (parentId →
  // primary) are hidden from the top level and shown stacked under / linked to the primary.
  const isPrimary = (p) => !p.parentId;
  const childrenOf = (id) => all.filter(p => p.parentId === id);
  // Standalone cards first; linkage cards (primaries with secondaries) sink to the bottom so
  // their taller stacked panels don't disrupt the rest of the grid. (stable sort keeps order)
  const tops = list.filter(isPrimary).sort((a, b) => (childrenOf(a.id).length ? 1 : 0) - (childrenOf(b.id).length ? 1 : 0));
  // Render each primary. Tile: the primary's card with its secondaries stacked + clickable.
  // List: the primary row, expandable to its secondary rows.
  const renderEntries = () => tops.map(pr => {
    const secs = childrenOf(pr.id);
    if (view === 'list') {
      if (!secs.length) return <PropRow key={pr.id} pr={pr} openProperty={openProperty} />;
      return <LinkedListRow key={pr.id} pr={pr} secondaries={secs} openProperty={openProperty} />;
    }
    return <PropCard key={pr.id} pr={pr} openProperty={openProperty} secondaries={secs} />;
  });
  return (
    <>
      {/* filter toolbar — sits right above the cards */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {/* Category filter (Neil) — its own filter icon, single-select; hides the other categories */}
        <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--pine)' }}><Filter size={13} /> Category</span>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="form-input" style={{ ...selStyle, borderColor: categoryFilter ? 'var(--pine)' : undefined }}>
          <option value="">All categories</option>
          {ASSET_CATEGORIES.map(c => <option key={c} value={c}>{`${c} (${catCount(c)})`}</option>)}
        </select>
        <span style={{ width: 1, height: 22, backgroundColor: 'var(--border-color)' }} />
        <span style={microLabel}>Stage</span>
        <select value={stageFilter} onChange={e => setStageFilter(e.target.value)} className="form-input" style={selStyle}>
          <option value="">All stages</option>
          {DEV_STAGES.map(s => <option key={s} value={s}>{`${s} (${stageCount(s)})`}</option>)}
        </select>
        <span style={microLabel}>Asset type</span>
        <select value={typeFilter} onChange={e => setTypeFilter && setTypeFilter(e.target.value)} className="form-input" style={selStyle}>
          <option value="">All types</option>
          {presentTypes.map(t => <option key={t} value={t}>{`${t} (${typeCounts[t]})`}</option>)}
        </select>
        <span style={microLabel}>Region</span>
        <select value={regionFilter} onChange={e => setRegionFilter(e.target.value)} className="form-input" style={selStyle}>
          <option value="">All regions</option>
          {presentRegions.map(r => <option key={r} value={r}>{`${r} (${regionCounts[r]})`}</option>)}
        </select>
        {(categoryFilter || stageFilter || typeFilter || regionFilter) && <button className="secondary-btn" onClick={() => { setCategoryFilter(''); setStageFilter(''); setTypeFilter && setTypeFilter(''); setRegionFilter(''); }} style={{ padding: '5px 11px', fontSize: '0.76rem', display: 'inline-flex', alignItems: 'center', gap: 6, borderColor: 'var(--pine)', color: 'var(--pine)' }}>Clear filters ✕</button>}
        <div style={{ marginLeft: 'auto' }}>{viewToggle}</div>
      </div>
      {tops.length === 0 ? <Empty>No properties match the current filters{categoryFilter ? ` (${categoryFilter})` : ''}.</Empty> : (
      view === 'list'
        ? <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{renderEntries()}</div>
        : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 18, alignItems: 'stretch' }}>{renderEntries()}</div>
      )}
    </>
  );
}

// One property card. A primary asset with linked secondaries shows a stacked-deck backing and
// directly-clickable secondary chips, so the hierarchy is obvious and reachable in one click.
function PropCard({ pr, openProperty, secondaries = [] }) {
  // Stage defaults to "Active" until the property's Development Stage field is set to something else.
  const stage = pr.devStage || 'Active';
  const sc = stageColor(stage);
  const typeLabel = assetTypeLabel(pr);
  const typeIcon = assetTypeIcon(pr);
  const hasSecs = secondaries.length > 0;
  const family = [pr, ...secondaries];
  // Type-appropriate metrics for this property (stats only show on standalone cards).
  const stats = cardStats(pr);
  const headerName = (hasSecs && pr.siteName) ? pr.siteName : pr.name;
  const fullAddress = fmtAddress(pr) || '—';
  const thumb = (pr.images && pr.images[0]) || pr.image || '';
  const kind = inferAssetKind(pr);
  // Photo-forward cover: the property photo fills the header with a dark gradient scrim so the
  // overlaid white name stays legible. Vehicles/equipment use contain-on-white; no photo → navy.
  const coverBg = thumb
    ? `linear-gradient(180deg, rgba(15,23,42,.10) 0%, rgba(13,20,34,.48) 54%, rgba(8,12,22,.92) 100%), url("${thumb}") ${kind !== 'property' ? 'center/contain' : 'center 30%/cover'} no-repeat${kind !== 'property' ? ' #fff' : ''}`
    : 'linear-gradient(150deg, #202c47 0%, #0d1422 100%)';
  const subtitle = hasSecs ? `${family.length} linked properties`
    : (kind === 'property' ? fullAddress : ([pr.make, pr.model, pr.trim].filter(Boolean).join(' ') || pr.color || fullAddress));
  const open = () => openProperty(pr.id);
  const frost = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.66rem', fontWeight: 700, color: '#fff', padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap' };
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {/* stacked-deck backing — peeks out below to signal this card holds multiple linked properties */}
      {hasSecs && <>
        <div style={{ position: 'absolute', left: 16, right: 16, bottom: -9, height: 18, borderRadius: 13, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', zIndex: 0 }} />
        <div style={{ position: 'absolute', left: 9, right: 9, bottom: -4, height: 18, borderRadius: 14, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', zIndex: 0 }} />
      </>}
    <div className="asset-card" role="button" tabIndex={0} aria-label={`Open ${headerName}`}
      onClick={open} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      style={{ position: 'relative', zIndex: 1, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
      {/* photo-forward cover — property photo fills the header, name overlaid; faint icon watermark when no photo */}
      <div className="asset-card__cover" style={{ position: 'relative', minHeight: 152, padding: '12px 14px 13px 16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8, background: coverBg, overflow: 'hidden' }}>
        {!thumb && createElement(typeIcon, { size: 120, style: { position: 'absolute', right: -14, top: 4, color: '#fff', opacity: 0.07 } })}
        {/* top row: asset-class icon (left) + linked-group badge (right) */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ flexShrink: 0, display: 'inline-flex', color: 'rgba(255,255,255,0.96)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))' }}>{createElement(typeIcon, { size: 26, strokeWidth: 1.7 })}</span>
          {hasSecs && <span style={{ ...frost, backgroundColor: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.22)' }}><Link2 size={11} /> Linked group</span>}
        </div>
        {/* bottom row: name + subtitle (left) + stage pill (right) */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontSize: '1.18rem', fontWeight: 800, fontFamily: "'Plus Jakarta Sans', sans-serif", color: '#fff', margin: 0, lineHeight: 1.16, textShadow: '0 1px 3px rgba(0,0,0,.5)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{headerName}</h3>
            <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.85)', marginTop: 2, textShadow: '0 1px 2px rgba(0,0,0,.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>
          </div>
          <span style={{ ...frost, flexShrink: 0, backgroundColor: 'rgba(0,0,0,0.46)', border: '1px solid rgba(255,255,255,0.14)' }}><span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: `hsl(var(--color-${sc}))` }} />{stage}</span>
        </div>
      </div>
      {/* white body — asset type → owner / manager, stats, footer */}
      <div style={{ padding: '14px 18px 14px', display: 'flex', flexDirection: 'column', gap: 13, flex: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {/* asset type (left) + linked pill (right, only on group cards) */}
          {(typeLabel || hasSecs) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {typeLabel && <div style={{ minWidth: 0, fontSize: '0.82rem', fontWeight: 700, color: 'var(--pine)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{typeLabel}</div>}
              {hasSecs && (
                <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.1)', border: '1px solid hsla(var(--color-purple), 0.3)', whiteSpace: 'nowrap' }}>
                  <Link2 size={11} />{family.length} linked
                </span>
              )}
            </div>
          )}
          {/* owner + asset manager — standalone cards only. On a linked GROUP card these come from
              the primary and aren't worth repeating; the group title says enough. */}
          {!hasSecs && (pr.entity || pr.manager) && (
            <div style={{ display: 'grid', gridTemplateColumns: (pr.entity && pr.manager) ? '1fr 1fr' : '1fr', gap: '4px 16px' }}>
              {pr.entity && (
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' }}>Owner</div>
                  <div style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pr.entity}</div>
                </div>
              )}
              {pr.manager && (
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' }}>Asset manager</div>
                  <div style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pr.manager}</div>
                </div>
              )}
            </div>
          )}
        </div>
        {/* stats strip — only on standalone cards. On a linked GROUP card the aggregated sums mix
            different sites and aren't meaningful (per-property acreage shows in the linked rows). */}
        {!hasSecs && (
          <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: `repeat(${stats.length}, 1fr)`, gap: '6px', borderTop: '1px solid var(--border-color)', padding: '13px 0 0' }}>
            {stats.map((s, i) => <Stat key={i} big v={s.v} l={s.l} />)}
          </div>
        )}
        {/* linked properties — at the BOTTOM: primary trunk + secondary branches, each opens that property */}
        {hasSecs && (
          <div style={{ marginTop: 'auto', border: '1px solid var(--border-color)', borderRadius: 11, padding: '6px 4px 4px', backgroundColor: 'var(--bg-secondary)' }}>
            {family.map((m, i) => {
              const isPrim = i === 0;
              const last = i === family.length - 1;
              const accent = isPrim ? 'var(--pine)' : 'hsl(var(--color-purple))';
              const sub = num0(m.acreage) ? `${num0(m.acreage)} ac` : (num0(m.nrsf) ? `${fmtNum(m.nrsf)} SF` : '');
              return (
                <div key={m.id} onClick={(e) => { e.stopPropagation(); openProperty(m.id); }} title={`Open ${m.name}`}
                  className="asset-linkrow"
                  style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px 6px 26px', borderRadius: 8, cursor: 'pointer' }}>
                  {!isPrim && <span style={{ position: 'absolute', left: 13, top: 0, width: 2, height: last ? '50%' : '100%', backgroundColor: 'var(--border-color)' }} />}
                  {!isPrim && <span style={{ position: 'absolute', left: 13, top: '50%', width: 9, height: 2, backgroundColor: 'var(--border-color)' }} />}
                  <span style={{ position: 'absolute', left: isPrim ? 8 : 9, top: '50%', transform: 'translateY(-50%)', width: isPrim ? 10 : 8, height: isPrim ? 10 : 8, borderRadius: '50%', backgroundColor: isPrim ? accent : 'var(--bg-card)', border: `2px solid ${accent}`, zIndex: 1 }} />
                  <span style={{ flexShrink: 0, fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: accent }}>{isPrim ? 'Primary' : 'Secondary'}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: '0.81rem', fontWeight: isPrim ? 700 : 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                  {sub && <span style={{ flexShrink: 0, fontSize: '0.7rem', color: 'var(--text-secondary)', fontFamily: MONO, whiteSpace: 'nowrap' }}>{sub}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
    </div>
  );
}
// Compact list-view row for a single property. `dropdownTrigger` makes the whole row open the
// linked-properties dropdown (instead of opening the property) — used for linkage rows.
function PropRow({ pr, openProperty, secondaries = [], expanded, onToggle, secondary, dropdownTrigger }) {
  const stage = pr.devStage || 'Active';
  const sc = stageColor(stage);
  const thumb = (pr.images && pr.images[0]) || pr.image || '';
  const stats = cardStats(pr);
  const typeIcon = assetTypeIcon(pr);
  const hasSecs = secondaries.length > 0;
  const accent = hasSecs ? '3px solid var(--pine)' : (secondary ? '3px solid hsla(var(--color-purple), 0.5)' : '1px solid var(--border-color)');
  const tag = (label, color) => <span style={{ fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 5, color: '#fff', backgroundColor: color }}>{label}</span>;
  return (
    <div onClick={() => (dropdownTrigger ? onToggle && onToggle() : openProperty(pr.id))} title={dropdownTrigger ? 'Show linked properties' : 'Open property'}
      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 14px', borderRadius: 12, cursor: 'pointer', border: '1px solid var(--border-color)', borderLeft: accent, backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)', transition: 'border-color 0.15s, box-shadow 0.15s' }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}>
      {thumb
        ? <img src={thumb} alt={pr.name} loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} style={{ flexShrink: 0, width: 52, height: 52, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border-color)' }} />
        : <div style={{ flexShrink: 0, width: 52, height: 52, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pine)', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>{createElement(typeIcon, { size: 22 })}</div>}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          {hasSecs && tag('Primary', 'var(--pine)')}
          {secondary && tag('Secondary', 'hsl(var(--color-purple))')}
          <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{pr.name}</strong>
          <span style={{ fontSize: '0.62rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: `hsl(var(--color-${sc}))`, backgroundColor: `hsla(var(--color-${sc}), 0.12)` }}>{stage}</span>
          {hasSecs && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.64rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.1)' }}><Link2 size={10} />{secondaries.length} linked</span>}
        </div>
        <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{assetTypeLabel(pr) ? `${assetTypeLabel(pr)} · ` : ''}{fmtAddress(pr) || '—'}</div>
        {/* metrics inline under the address — left-grouped so the right edge stays clean */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 16px', marginTop: 7 }}>
          {stats.map((s, i) => (
            <span key={i} title={STAT_TIP[s.l] || s.l} style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
              <strong style={{ fontFamily: MONO, fontWeight: 700, color: 'var(--text-primary)' }}>{s.v}</strong> {s.l}
            </span>
          ))}
        </div>
      </div>
      {hasSecs && onToggle
        ? <button onClick={e => { e.stopPropagation(); onToggle(); }} title={expanded ? 'Hide linked' : 'Show linked'} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, display: 'inline-flex', flexShrink: 0 }}><ChevronDown size={18} style={{ color: 'var(--pine)', transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'none' }} /></button>
        : <ArrowRight size={16} style={{ color: secondary ? 'hsl(var(--color-purple))' : 'var(--pine)', flexShrink: 0 }} />}
    </div>
  );
}

// List-view linkage row: a COMPACT group row (title + count only). Click it to expand the linked
// properties inline as full, individually-clickable rows — same detail as standalone rows.
function LinkedListRow({ pr, secondaries, openProperty }) {
  const [open, setOpen] = useState(false);
  const members = [pr, ...secondaries];
  const thumb = (pr.images && pr.images[0]) || pr.image || '';
  return (
    <div>
      {/* compact group header — title + "N linked properties", nothing else; click to expand */}
      <div onClick={() => setOpen(o => !o)} title={open ? 'Hide linked properties' : 'Show linked properties'}
        style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 14px', borderRadius: 12, cursor: 'pointer', border: '1px solid var(--border-color)', borderLeft: '3px solid var(--pine)', backgroundColor: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)', transition: 'box-shadow 0.15s' }}
        onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
        onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}>
        {thumb
          ? <img src={thumb} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} style={{ flexShrink: 0, width: 52, height: 52, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border-color)' }} />
          : <div style={{ flexShrink: 0, width: 52, height: 52, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--pine)', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}><Building2 size={22} /></div>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{pr.siteName || pr.name}</strong>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.64rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.1)' }}><Link2 size={10} /> Linked group</span>
          </div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2 }}>{members.length} linked properties</div>
        </div>
        <ChevronDown size={18} style={{ flexShrink: 0, color: 'var(--pine)', transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }} />
      </div>
      {/* expanded — each member as a full, clickable detail row (primary first, then secondaries) */}
      {open && (
        <div style={{ marginTop: 8, marginLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {members.map((m, i) => <PropRow key={m.id} pr={m} openProperty={openProperty} secondary={i > 0} />)}
        </div>
      )}
    </div>
  );
}

/* ---------- property detail ---------- */
/* ---------- detail: rich section template (Neil's PT) + health signals ---------- */
const normLabel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const creFmt = (v, t) => {
  if (v == null || String(v).trim() === '') return '';
  if (t === 'money') return fmtMoney(v);
  if (t === 'date') return fmtDate(v);
  if (t === 'pct') { const n = String(v).trim(); return /%/.test(n) ? n : n + '%'; }
  if (t === 'num') return fmtNum(v);
  return v;
};
// Comprehensive property detail schema. `key` pulls from the record; otherwise the value is matched
// from the property's snapshot by normalized label (so Financial/Debt/Leasing fill in as data lands).
// `dev` fields/groups are hidden once the asset is Stabilized. `t` drives formatting.
const PT = [
  { g: 'Project Details', fields: [{ l: 'Project Name', key: 'name' }, { l: 'Property Address', key: 'address' }, { l: 'City', key: 'city' }, { l: 'County', key: 'county' }, { l: 'State', key: 'state' }, { l: 'Zip', key: 'zip' }, { l: 'APN', key: 'apn' }, { l: 'Legal Description' }, { l: 'Current Use' }, { l: 'Proposed Use', dev: true }, { l: 'Development Stage', t: 'stage', dev: true }] },
  { g: 'Financial & Investment', fields: [{ l: 'Acquisition Date', t: 'date' }, { l: 'Acquisition Price', t: 'money' }, { l: 'Total Cost Basis', t: 'money' }, { l: 'Current / Appraised Value', t: 'money' }, { l: 'Valuation Date', t: 'date' }, { l: 'Going-in Cap Rate', t: 'pct' }, { l: 'Current Cap Rate', t: 'pct' }, { l: 'NOI (In-Place)', t: 'money' }, { l: 'NOI (Pro Forma)', t: 'money' }, { l: 'Occupancy %', t: 'pct' }, { l: 'Hold Strategy' }, { l: 'Target Hold (yrs)' }, { l: 'Projected IRR', t: 'pct' }, { l: 'Equity Multiple' }] },
  { g: 'Debt / Financing', fields: [{ l: 'Lender' }, { l: 'Loan Number' }, { l: 'Original Balance', t: 'money' }, { l: 'Current Balance', t: 'money' }, { l: 'Interest Rate', t: 'pct' }, { l: 'Rate Type' }, { l: 'Maturity Date', t: 'date' }, { l: 'Amortization' }, { l: 'LTV', t: 'pct' }, { l: 'DSCR' }, { l: 'Recourse' }, { l: 'Prepay / Lockout' }] },
  { g: 'Leasing & Tenancy', fields: [{ l: 'Tenant' }, { l: 'Lease Structure' }, { l: 'Commencement', t: 'date' }, { l: 'Expiration', t: 'date' }, { l: 'Base Rent (Annual)', t: 'money' }, { l: 'Rent PSF' }, { l: 'Escalations' }, { l: 'Renewal Options' }, { l: 'Guarantor' }, { l: 'WALT (yrs)' }, { l: 'Leased Occupancy', t: 'pct' }] },
  { g: 'Unit Mix', fields: [{ l: 'Non-Climate Units', key: 'unitsNonClimate', t: 'num' }, { l: 'Climate Units', key: 'unitsClimate', t: 'num' }, { l: 'RV / Vehicle Spaces', key: 'unitsRV', t: 'num' }, { l: 'Mailbox Units', key: 'unitsMailbox', t: 'num' }, { l: 'Total Units', key: 'unitsTotal', t: 'num' }] },
  { g: 'Insurance', fields: [{ l: 'Carrier', key: 'insCarrier' }, { l: 'Policy Number', key: 'insPolicy' }, { l: 'Coverage' }, { l: 'Policy Expiration', key: 'insExpiration', t: 'date' }, { l: 'Agent / Broker', key: 'insAgent' }, { l: 'Agent Phone', key: 'insPhone' }] },
  { g: 'Property Tax', fields: [{ l: 'Tax / Parcel Account', key: 'taxId' }, { l: 'Assessed Value', t: 'money' }, { l: 'Annual Tax', key: 'taxAnnual', t: 'money' }, { l: 'Tax Rate' }, { l: 'Due Dates', key: 'taxDue' }] },
  { g: 'Ownership + Core Team', fields: [{ l: 'Ownership Entity', key: 'entity' }, { l: 'PM / Asset Manager', key: 'manager' }, { l: 'Developer / Sponsor', dev: true }, { l: 'Seller (if applicable)', dev: true }, { l: 'Architect', dev: true }, { l: 'Civil', dev: true }, { l: 'Structural', dev: true }, { l: 'MEP', dev: true }, { l: 'GC / CM', key: 'builder', dev: true }, { l: 'Land Use Attorney', dev: true }, { l: 'Title / Escrow', dev: true }] },
  { g: 'Site Data', dev: true, fields: [{ l: 'Lot Size (SF / Acres)', key: 'acreage' }, { l: 'Dimensions' }, { l: 'Topography' }, { l: 'Access Points' }, { l: 'Street Frontage' }, { l: 'Easements / Encroachments' }, { l: 'Flood Zone', key: 'floodZone' }, { l: 'Soils / Geotech Notes' }] },
  { g: 'Zoning + Land Use', dev: true, fields: [{ l: 'Jurisdiction' }, { l: 'General Plan' }, { l: 'Zoning', key: 'zoning' }, { l: 'Overlays / Specific Plan' }, { l: 'Height / FAR Limits' }, { l: 'Setbacks (F/S/R)' }, { l: 'Parking Required' }, { l: 'Design Review / CUP / Variance' }] },
  { g: 'Existing Improvements', fields: [{ l: 'Existing Structures' }, { l: 'Existing Building SF', key: 'nrsf', t: 'num' }, { l: 'Year Built', key: 'yearBuilt' }, { l: 'Occupancy (Vacant/Tenant)' }, { l: 'Demo Needed', dev: true }, { l: 'Known Issues / Violations' }] },
];
const snapMap = (p) => { const m = {}; (p.snapshot || []).forEach(g => (g.fields || []).forEach(f => { m[normLabel(f.label)] = f.value; })); return m; };
// Resolve an asset into [{title, fields:[[label,value]]}] for the Overview. Vehicles/equipment
// render their own snapshot groups (Vehicle / Assignment / Registration / Service / …); properties
// use the rich PT template — dev-stage fields/groups drop once Stabilized.
function ptSections(p) {
  if (inferAssetKind(p) !== 'property') {
    return (p.snapshot || []).map(g => ({ title: g.group, fields: (g.fields || []).map(f => [f.label, f.value]) })).filter(g => g.fields.length);
  }
  const snap = snapMap(p);
  const stabilized = String(p.devStage || '').toLowerCase().includes('stabil');
  return PT.filter(g => !(g.dev && stabilized)).map(g => ({
    title: g.g,
    fields: g.fields.filter(f => !(f.dev && stabilized)).map(f => {
      const raw = f.l === 'Development Stage' ? p.devStage : (f.key ? p[f.key] : snap[normLabel(f.l)]);
      return [f.l, creFmt(raw, f.t)];
    }),
  }));
}
// Health signals — vehicle/equipment vs property branches. Tone ∈ ok|warn|bad|mut|info. dleft = days-until.
function assetSignals(p, store) {
  const snap = snapMap(p);
  const sig = [];
  if (inferAssetKind(p) !== 'property') {
    const dI = dleft(p.insExpiration || snap['policy expiration']);
    sig.push(dI == null ? { l: 'Insurance', v: 'Not on file', t: 'mut' } : dI < 0 ? { l: 'Insurance', v: 'Lapsed', t: 'bad' } : dI <= 60 ? { l: 'Insurance', v: dI + 'd to renewal', t: 'warn' } : { l: 'Insurance', v: 'Active', t: 'ok' });
    const dR = dleft(p.regExpiration || snap['registration expiration']);
    sig.push(dR == null ? { l: 'Registration', v: 'Not on file', t: 'mut' } : dR < 0 ? { l: 'Registration', v: 'Expired', t: 'bad' } : dR <= 60 ? { l: 'Registration', v: dR + 'd left', t: 'warn' } : { l: 'Registration', v: 'Current', t: 'ok' });
    const sv = (store.vservice || []).filter(x => x.propertyId === p.id);
    const dN = dleft(p.nextServiceDate || snap['next service due']);
    sig.push(dN == null ? (sv.length ? { l: 'Service', v: sv.length + ' on file', t: 'info' } : { l: 'Service', v: 'None logged', t: 'mut' }) : dN < 0 ? { l: 'Service', v: 'Overdue', t: 'bad' } : dN <= 30 ? { l: 'Service', v: 'Due ' + dN + 'd', t: 'warn' } : { l: 'Service', v: 'Current', t: 'ok' });
    const od = (store.odometer || []).filter(x => x.propertyId === p.id);
    const lr = od.map(x => x.date).filter(Boolean).sort().pop();
    const dO = lr ? -dleft(lr) : null;
    sig.push(dO == null ? { l: 'Odometer', v: 'No reading', t: 'mut' } : dO > 365 ? { l: 'Odometer', v: 'Reading due', t: 'warn' } : { l: 'Odometer', v: 'Current', t: 'ok' });
    return sig;
  }
  const dI = dleft(p.insExpiration || snap['policy expiration']);
  sig.push(dI == null ? { l: 'Insurance', v: 'Not on file', t: 'mut' } : dI < 0 ? { l: 'Insurance', v: 'Lapsed', t: 'bad' } : dI <= 90 ? { l: 'Insurance', v: dI + 'd to renewal', t: 'warn' } : { l: 'Insurance', v: 'Active', t: 'ok' });
  const insp = (store.inspections || []).filter(x => x.propertyId === p.id);
  const due = insp.map(x => dleft(x.nextDue)).filter(x => x != null);
  const nd = due.length ? Math.min(...due) : null;
  sig.push(!insp.length ? { l: 'Inspections', v: 'None scheduled', t: 'mut' } : nd == null ? { l: 'Inspections', v: insp.length + ' on file', t: 'info' } : nd < 0 ? { l: 'Inspections', v: 'Overdue', t: 'bad' } : nd <= 30 ? { l: 'Inspections', v: 'Due ' + nd + 'd', t: 'warn' } : { l: 'Inspections', v: 'Current', t: 'ok' });
  const pm = p.permits || [];
  const op = pm.filter(x => /open|process|in review|pending|violation|submitted|out to applicant/i.test(JSON.stringify(x).toLowerCase())).length;
  sig.push(!pm.length ? { l: 'Permits', v: 'None tracked', t: 'mut' } : op ? { l: 'Permits', v: op + ' in process', t: 'info' } : { l: 'Permits', v: pm.length + ' on file', t: 'ok' });
  const mat = snap['maturity date'];
  const dm = dleft(mat);
  sig.push(!mat ? { l: 'Debt', v: 'None recorded', t: 'mut' } : dm < 0 ? { l: 'Debt', v: 'Matured', t: 'bad' } : { l: 'Debt', v: 'Matures ' + fmtDate(mat), t: dm <= 180 ? 'warn' : 'ok' });
  return sig;
}
// Freshness — most recent activity-log entry for this asset (green→ok, gold→warn so the chip colors).
function freshMeta(logs, id) {
  const ts = (logs || []).filter(l => l.propertyId === id).map(l => l.ts).filter(Boolean).sort().pop();
  if (!ts) return { l: 'Freshness', v: 'Not yet updated', t: 'mut' };
  const d = -dleft(ts);
  const rel = d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? d + 'd ago' : fmtDate(ts);
  return { l: 'Freshness', v: 'Updated ' + rel, t: d <= 30 ? 'ok' : d <= 120 ? 'warn' : 'mut' };
}
const SIGNAL_TONE = { ok: 'green', warn: 'orange', bad: 'red', info: 'blue' };
function HealthChip({ label, val, tone }) {
  const col = tone === 'mut' ? 'var(--text-secondary)' : `hsl(var(--color-${SIGNAL_TONE[tone]}))`;
  const dot = tone === 'mut' ? 'var(--text-muted)' : col;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 11px', borderRadius: 10, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-card)', whiteSpace: 'nowrap' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: dot }} />
      <span style={{ fontSize: '0.72rem' }}><span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{label}</span>{' '}<span style={{ color: col, fontWeight: 600 }}>{val}</span></span>
    </span>
  );
}
// The signal-chip row on the asset detail header.
function HealthStrip({ p, data }) {
  const sig = assetSignals(p, data || {});
  const fresh = freshMeta((data && data.logs) || [], p.id);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12, alignItems: 'center' }}>
      {[...sig, fresh].map((x, i) => <HealthChip key={i} label={x.l} val={x.v} tone={x.t} />)}
    </div>
  );
}

// Aggregate every date-driven obligation across the whole portfolio into a single
// sorted list (soonest/most-overdue first). Ported from Neil's template.
function collectCriticalDates(store) {
  const props = (store.properties || []).filter(p => !p.deleted);
  const byId = {}; props.forEach(p => { byId[p.id] = p; });
  const out = [];
  const push = (id, cat, label, date, detail) => {
    if (!byId[id]) return;
    const d = dleft(date); if (d == null) return;
    const p = byId[id];
    out.push({ id, name: p.siteName || p.name || 'Unknown asset', cat, label, detail: detail || '', date, days: d });
  };
  props.forEach(p => {
    const sm = snapMap(p), isProp = inferAssetKind(p) === 'property';
    push(p.id, 'Insurance', 'Policy expiration', p.insExpiration || sm['policy expiration']);
    if (isProp) {
      push(p.id, 'Property Tax', 'Tax payment due', p.taxDue);
      push(p.id, 'Loan', 'Loan maturity', sm['maturity date']);
    } else {
      push(p.id, 'Registration', 'Registration expiration', p.regExpiration || sm['registration expiration']);
      push(p.id, 'Service', 'Next service due', p.nextServiceDate || sm['next service due']);
    }
  });
  (store.warranties || []).forEach(x => push(x.propertyId, 'Warranty', 'Warranty expiration', x.expiration, x.scope || x.party || x.kind));
  (store.inspections || []).forEach(x => push(x.propertyId, 'Inspection', 'Inspection due', x.nextDue, x.type));
  (store.vendors || []).forEach(x => {
    push(x.propertyId, 'Contract', 'Contract end', x.contractEnd, x.company || x.category);
    push(x.propertyId, 'COI', 'Insurance cert expiration', x.coiExpiration, x.company || x.category);
  });
  (store.ahj || []).forEach(x => push(x.propertyId, 'Permit / AHJ', 'Renewal due', x.renewalDate, x.authority || x.jurisdiction));
  (store.maintenance || []).forEach(x => push(x.propertyId, 'Maintenance', 'Follow-up due', x.nextDue, x.system || x.description));
  (store.vservice || []).forEach(x => push(x.propertyId, 'Service', 'Service due', x.nextDue, x.type));
  out.sort((a, b) => a.days - b.days);
  return out;
}

// Collapsible Critical Dates panel — portfolio-wide, with overdue/30/90 windows and a
// category filter. Each row deep-links to its asset. When `only` is passed, it scopes to
// one asset (per-asset "Critical Items" variant on the detail view).
function CriticalDates({ store, openProperty, only }) {
  const [open, setOpen] = useState(true);
  const [win, setWin] = useState('90');
  const [cat, setCat] = useState('');
  let all = collectCriticalDates(store);
  if (only) all = all.filter(x => x.id === only);
  const over = all.filter(x => x.days < 0).length;
  const d30 = all.filter(x => x.days >= 0 && x.days <= 30).length;
  const d90 = all.filter(x => x.days >= 0 && x.days <= 90).length;
  const cats = [...new Set(all.map(x => x.cat))].sort();
  const inWin = x => win === 'all' ? true : win === 'overdue' ? x.days < 0 : win === '30' ? x.days <= 30 : x.days <= 90;
  const rows = all.filter(inWin).filter(x => !cat || x.cat === cat);
  const tone = d => d < 0 ? 'red' : d <= 30 ? 'orange' : d <= 90 ? 'gold' : 'green';
  const dtxt = d => d < 0 ? Math.abs(d) + 'd overdue' : d === 0 ? 'Due today' : 'Due in ' + d + 'd';
  const pill = (nn, label, c) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', color: nn ? `hsl(var(--color-${c}))` : 'var(--text-muted)', backgroundColor: nn ? `hsla(var(--color-${c}), 0.12)` : 'var(--bg-secondary)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: nn ? `hsl(var(--color-${c}))` : 'var(--text-muted)' }} />
      {nn + ' ' + label}
    </span>
  );
  const chip = (val, label) => {
    const active = win === val;
    return (
      <button onClick={() => setWin(val)} style={{ padding: '5px 11px', borderRadius: 999, fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer', border: active ? '1px solid transparent' : '1px solid var(--border-color)', color: active ? '#fff' : 'var(--text-secondary)', background: active ? 'hsl(var(--color-blue))' : 'var(--bg-card)' }}>{label}</button>
    );
  };
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)' }}>Critical Dates</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {pill(over, 'Overdue', 'red')}
          {pill(d30, 'Due ≤30d', 'orange')}
          {pill(d90, 'Due ≤90d', 'gold')}
        </div>
        <button onClick={() => setOpen(o => !o)} style={{ marginLeft: 'auto', padding: '5px 11px', borderRadius: 8, fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {chip('overdue', 'Overdue')}
            {chip('30', 'Next 30 days')}
            {chip('90', 'Next 90 days')}
            {chip('all', 'All upcoming')}
            <select value={cat} onChange={e => setCat(e.target.value)} className="form-input" style={{ marginLeft: 'auto', padding: '5px 10px', fontSize: '0.76rem', maxWidth: 190 }}>
              <option value="">All categories</option>
              {cats.map(cc => <option key={cc} value={cc}>{cc}</option>)}
            </select>
          </div>
          {rows.length ? (
            <div style={{ maxHeight: 340, overflowY: 'auto', marginTop: 10, border: '1px solid var(--border-color)', borderRadius: 8 }}>
              {rows.map((x, i) => (
                <div key={x.id + '|' + x.cat + '|' + i} onClick={() => openProperty(x.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', cursor: 'pointer', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
                  <span style={{ flexShrink: 0, minWidth: 98, textAlign: 'center', padding: '4px 8px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', color: `hsl(var(--color-${tone(x.days)}))`, backgroundColor: `hsla(var(--color-${tone(x.days)}), 0.12)` }}>{dtxt(x.days)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</div>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.cat}{' · '}{x.label}{x.detail ? ' — ' + x.detail : ''}</div>
                  </div>
                  <span style={{ flexShrink: 0, fontSize: '0.76rem', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDate(x.date)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 10, padding: '16px', fontSize: '0.82rem', fontWeight: 600, color: 'hsl(var(--color-green))', textAlign: 'center' }}>All clear — nothing due in this window.</div>
          )}
        </>
      )}
    </div>
  );
}

// Portfolio-wide "Flagged for Review" panel — every field flagged across all assets, grouped
// by asset. Click a flag to jump to the field (to fix via Edit), or Resolve to clear it.
function FlaggedForReview({ props, openToField, onClear }) {
  const items = [];
  props.forEach(p => (p.reviewFlags || []).forEach(f => items.push({ ...f, id: p.id, name: p.siteName || p.name || p.id })));
  if (!items.length) return null;
  items.sort((a, b) => (a.name || '') < (b.name || '') ? -1 : (a.name > b.name ? 1 : (a.g || '').localeCompare(b.g || '')));
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, marginBottom: 16, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: '0.98rem', fontWeight: 700, color: 'var(--text-primary)' }}>Flagged for Review</span>
        <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 999, fontSize: '0.68rem', fontWeight: 700, color: '#fff', backgroundColor: 'hsl(var(--color-orange))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{items.length}</span>
      </div>
      <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden' }}>
        {items.map((x, i) => (
          <div key={x.id + '|' + x.g + '|' + x.f} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderTop: i ? '1px solid var(--border-color)' : 'none' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.g}{' · '}{x.f}{x.user ? ' — ' + emailToName(x.user) : ''}</div>
            </div>
            <button className="secondary-btn" onClick={() => openToField(x.id, x.g, x.f)} style={{ padding: '5px 12px', fontSize: '0.76rem', whiteSpace: 'nowrap' }}>Go to field</button>
            <button className="secondary-btn" onClick={() => onClear(x.id, x.g, x.f)} style={{ padding: '5px 12px', fontSize: '0.76rem', whiteSpace: 'nowrap', color: 'hsl(var(--color-green))' }}>Resolve</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Compact pill row on the detail view to jump between linked parcels in the same project
// group. Hidden for vehicles/equipment and for single-member (standalone) groups.
function ParcelSwitcher({ p, props, openProperty }) {
  if (inferAssetKind(p) !== 'property') return null;
  const primaryId = p.parentId || p.id;
  const members = props.filter(x => x.id === primaryId || x.parentId === primaryId);
  if (members.length < 2) return null;
  // primary first, then by parcelOrder, then name
  const ordered = [...members].sort((a, b) => {
    const ap = a.id === primaryId ? -1 : 0, bp = b.id === primaryId ? -1 : 0;
    if (ap !== bp) return ap - bp;
    const ao = a.parcelOrder ?? 999, bo = b.parcelOrder ?? 999;
    if (ao !== bo) return ao - bo;
    return (a.name || '') < (b.name || '') ? -1 : 1;
  });
  const groupName = members.find(x => x.id === primaryId)?.siteName || 'Linked Parcels';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16, padding: '10px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 10 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
        <Link2 size={13} /> {groupName}
      </span>
      {ordered.map(m => {
        const on = m.id === p.id;
        const isPrimary = m.id === primaryId;
        return (
          <button key={m.id} onClick={() => !on && openProperty(m.id)} title={isPrimary ? 'Primary parcel' : 'Secondary parcel'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999, fontSize: '0.78rem', fontWeight: 600, cursor: on ? 'default' : 'pointer', border: '1px solid', borderColor: on ? 'var(--pine)' : 'var(--border-color)', background: on ? 'var(--pine)' : 'var(--bg-card)', color: on ? '#fff' : 'var(--text-secondary)' }}>
            {m.name}
            {isPrimary && <span style={{ fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.85 }}>· Primary</span>}
          </button>
        );
      })}
    </div>
  );
}

// Portfolio-wide attention pills shown under the landing header (insurance / inspections /
// permits / loans). Mirrors the desktop's PortfolioPulse.
function PortfolioPulse({ data }) {
  const props = (data.properties || []).filter(p => !p.deleted);
  let insLapsed = 0, insSoon = 0, inspOverdue = 0, permitsOpen = 0, loansMaturing = 0;
  props.forEach(p => {
    const snap = snapMap(p);
    const dI = dleft(p.insExpiration || snap['policy expiration']);
    if (dI != null) { if (dI < 0) insLapsed++; else if (dI <= 90) insSoon++; }
    (p.permits || []).forEach(x => { if (/open|process|in review|pending|violation|submitted|out to applicant/i.test(JSON.stringify(x).toLowerCase())) permitsOpen++; });
    const dm = dleft(snap['maturity date']);
    if (dm != null && dm >= 0 && dm <= 180) loansMaturing++;
  });
  (data.inspections || []).forEach(r => { const d = dleft(r.nextDue); if (d != null && d < 0) inspOverdue++; });
  const pills = [];
  if (insLapsed) pills.push([`${insLapsed} insurance lapsed`, 'red']);
  if (insSoon) pills.push([`${insSoon} insurance expiring`, 'orange']);
  if (inspOverdue) pills.push([`${inspOverdue} inspection${inspOverdue > 1 ? 's' : ''} overdue`, 'red']);
  if (permitsOpen) pills.push([`${permitsOpen} permits in process`, 'blue']);
  if (loansMaturing) pills.push([`${loansMaturing} loan${loansMaturing > 1 ? 's' : ''} maturing`, 'orange']);
  const dot = (c) => ({ width: 6, height: 6, borderRadius: '50%', backgroundColor: `hsl(var(--color-${c}))` });
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center', marginTop: 8 }}>
      {pills.length === 0
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 600, color: 'hsl(var(--color-green))' }}><span style={dot('green')} />All clear — nothing needs attention</span>
        : pills.map(([txt, c], i) => <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', fontWeight: 600, padding: '3px 10px', borderRadius: 999, color: `hsl(var(--color-${c}))`, backgroundColor: `hsla(var(--color-${c}), 0.12)` }}><span style={dot(c)} />{txt}</span>)}
    </div>
  );
}

// Render a field value, turning emails/phones into mailto:/tel: links (contact popover-lite).
function FieldValue({ v }) {
  const s = (v ?? '') === '' ? '—' : String(v);
  const linkStyle = { color: 'hsl(var(--color-blue))', textDecoration: 'none', fontWeight: 600 };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())) return <a href={`mailto:${s.trim()}`} style={linkStyle}>{s}</a>;
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length >= 10 && /^[\d\s()+\-.]+$/.test(s.trim())) return <a href={`tel:${digits}`} style={linkStyle}>{s}</a>;
  return <>{s}</>;
}
function PropertyDetail({ p, onSaveImages, highlight, onToggleFlag }) {
  const hlField = (highlight?.field || '').toLowerCase();
  const sections = ptSections(p);
  const isProp = inferAssetKind(p) === 'property';
  const flagged = (g, f) => (p.reviewFlags || []).some(x => x.g === g && x.f === f);
  const jump = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const lblStyle = { fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-secondary)', lineHeight: 1.4 };
  const secCard = { backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', overflow: 'hidden', scrollMarginTop: 64 };
  const toc = [...sections.map((s, i) => [`gt-sec${i}`, s.title]), ...(isProp ? [['gt-map', 'Map']] : []), ['gt-media', 'Media']];
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      {/* sticky "On this page" table of contents (hidden on narrow screens via .asset-toc) */}
      <nav className="asset-toc" style={{ position: 'sticky', top: 16, flexShrink: 0, width: 178, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{ ...microLabel, padding: '2px 11px 8px' }}>On this page</div>
        {toc.map(([id, title]) => (
          <button key={id} onClick={() => jump(id)} style={{ textAlign: 'left', padding: '7px 11px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}>{title}</button>
        ))}
      </nav>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {sections.map((sec, si) => (
          <section key={si} id={`gt-sec${si}`} style={secCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
              <strong style={{ fontSize: '0.98rem', fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--text-primary)' }}>{sec.title}</strong>
              <span style={{ marginLeft: 'auto', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{sec.fields.length} fields</span>
            </div>
            <div>
              {sec.fields.map(([L, V], fi) => {
                const hl = hlField && String(L).toLowerCase() === hlField;
                const isFlagged = flagged(sec.title, L);
                return (
                  <div key={fi} ref={hl ? (el => el && el.scrollIntoView({ behavior: 'smooth', block: 'center' })) : null}
                    className="gt-frow"
                    style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 36%) 1fr auto', gap: 16, alignItems: 'baseline', padding: '9px 18px', borderTop: fi ? '1px solid var(--border-color)' : 'none', background: hl ? 'hsla(var(--color-gold), 0.16)' : (isFlagged ? 'hsla(var(--color-orange), 0.07)' : 'transparent'), scrollMarginTop: 64 }}>
                    <span style={lblStyle}>{L}</span>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' }}><FieldValue v={V} /></span>
                    {onToggleFlag && (
                      <button className={`gt-flag${isFlagged ? ' on' : ''}`} title={isFlagged ? 'Flagged for review — click to clear' : 'Flag this field for review'}
                        onClick={() => onToggleFlag(p.id, sec.title, L)}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1, padding: '0 2px', color: isFlagged ? 'hsl(var(--color-orange))' : 'var(--text-muted)', opacity: isFlagged ? 1 : 0, transition: 'opacity .12s' }}>⚑</button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {isProp && <div id="gt-map" style={{ scrollMarginTop: 64 }}><MapSection p={p} /></div>}
        <div id="gt-media" style={{ scrollMarginTop: 64 }}><MediaSection p={p} onSave={onSaveImages} /></div>
      </div>
    </div>
  );
}
// Map — collapsible, full-width, read-only (keyless Google embed, no API key/cost).
function MapSection({ p, n }) {
  const addr = [fmtAddress(p), p.county ? fmtCounty(p.county) : ''].filter(Boolean).join(', ');
  const mapQ = encodeURIComponent(addr || p.name || '');
  const [open, setOpen] = useState(false);
  return (
    <Panel>
      <div onClick={() => setOpen(o => !o)} title={open ? 'Collapse' : 'Expand'}
        style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', userSelect: 'none', marginBottom: open ? 14 : 0, paddingBottom: open ? 10 : 0, borderBottom: open ? '1px solid var(--border-color)' : 'none' }}>
        {n != null && <span style={{ width: 22, height: 22, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: '0.72rem', fontWeight: 700, color: '#fff', backgroundColor: 'var(--pine)' }}>{n}</span>}
        <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Map</strong>
        <ChevronDown size={18} style={{ marginLeft: 'auto', color: 'var(--text-secondary)', transition: 'transform 0.2s', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
      </div>
      {open && (addr
        ? <iframe title="Property map" src={`https://www.google.com/maps?q=${mapQ}&output=embed`} loading="lazy" referrerPolicy="no-referrer-when-downgrade" style={{ width: '100%', height: 380, border: '1px solid var(--border-color)', borderRadius: 10, display: 'block' }} />
        : <div style={{ height: 200, borderRadius: 10, border: '1px dashed var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.82rem', backgroundColor: 'var(--bg-secondary)' }}>Add an address to show the map.</div>)}
    </Panel>
  );
}
// Media — collapsible. Pictures support multiple upload + per-image delete behind an Edit button
// that appears once the section is open.
function MediaSection({ p, n, onSave }) {
  const pics = (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const startEdit = (e) => { e.stopPropagation(); setDraft(pics); setEditing(true); setOpen(true); };
  const onPick = async (e) => {
    const files = [...(e.target.files || [])]; const urls = [];
    for (const f of files) { if (f.type.startsWith('image/')) { try { urls.push(await uploadAssetFile(f, true)); } catch { /* ignore */ } } }
    setDraft(d => [...d, ...urls]); e.target.value = '';
  };
  const shown = editing ? draft : pics;
  const thumb = { width: 132, height: 96, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border-color)', display: 'block' };
  return (
    <Panel>
      <div onClick={() => !editing && setOpen(o => !o)} title={editing ? '' : (open ? 'Collapse' : 'Expand')}
        style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: editing ? 'default' : 'pointer', userSelect: 'none', marginBottom: open ? 14 : 0, paddingBottom: open ? 10 : 0, borderBottom: open ? '1px solid var(--border-color)' : 'none' }}>
        {n != null && <span style={{ width: 22, height: 22, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: '0.72rem', fontWeight: 700, color: '#fff', backgroundColor: 'var(--pine)' }}>{n}</span>}
        <strong style={{ fontSize: '0.95rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Media {shown.length > 0 && `(${shown.length})`}</strong>
        {open && !editing && <button className="secondary-btn" onClick={startEdit} style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: '0.76rem', color: 'hsl(var(--color-blue))', borderColor: 'hsl(var(--color-blue))', backgroundColor: 'hsl(var(--color-blue) / 0.08)' }}>Edit</button>}
        <ChevronDown size={18} style={{ marginLeft: open && !editing ? 8 : 'auto', color: 'var(--text-secondary)', transition: 'transform 0.2s', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
      </div>
      {open && (
        <>
          {shown.length === 1
            ? <div style={{ position: 'relative', maxWidth: 480 }}>
                <img src={shown[0]} alt={p.name} loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} style={{ width: '100%', height: 280, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border-color)', display: 'block' }} />
                {editing && <button onClick={() => setDraft([])} title="Remove" style={{ position: 'absolute', top: 8, right: 8, width: 24, height: 24, borderRadius: '50%', border: 'none', cursor: 'pointer', color: '#fff', backgroundColor: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><X size={14} /></button>}
              </div>
            : shown.length > 1
              ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {shown.map((src, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      <img src={src} alt={`${p.name} ${i + 1}`} loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} style={thumb} />
                      {editing && <button onClick={() => setDraft(d => d.filter((_, j) => j !== i))} title="Remove" style={{ position: 'absolute', top: -7, right: -7, width: 22, height: 22, borderRadius: '50%', border: 'none', cursor: 'pointer', color: '#fff', backgroundColor: 'hsl(var(--color-red))', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><X size={13} /></button>}
                    </div>
                  ))}
                </div>
              : <div style={{ height: 120, borderRadius: 10, border: '1px dashed var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '0.82rem', backgroundColor: 'var(--bg-secondary)' }}>{editing ? 'Upload pictures below.' : 'No pictures — click Edit to add.'}</div>}
          {editing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <label className="secondary-btn" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
                <Upload size={14} /> Upload pictures
                <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPick} />
              </label>
              <button className="secondary-btn" onClick={() => { setEditing(false); setDraft([]); }} style={{ marginLeft: 'auto' }}>Cancel</button>
              <button className="primary-btn" onClick={() => { onSave(draft); setEditing(false); }}>Save</button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/* ---------- generic collection ---------- */
function Collection({ coll, rows, active, filters, onAdd, onEdit, highlightItem, collapsible }) {
  const cfg = COLLECTIONS[coll];
  const [open, setOpen] = useState(false); // only used when collapsible — collapsed by default
  // "Go to field" from Logs targets a row here — auto-expand so the highlighted row is visible.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (collapsible && highlightItem) setOpen(true);
  }, [collapsible, highlightItem]);
  const shown = !collapsible || open;
  const q = (filters[coll] || '').toLowerCase();
  let list = rows.slice().sort(cfg.sort);
  if (q) list = list.filter(r => JSON.stringify(r).toLowerCase().includes(q));
  const sum = cfg.summary ? cfg.summary(rows) : null;
  return (
    <Panel>
      <div onClick={collapsible ? () => setOpen(o => !o) : undefined} title={collapsible ? (open ? 'Collapse' : 'Expand') : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: shown ? 14 : 0, flexWrap: 'wrap', cursor: collapsible ? 'pointer' : 'default', userSelect: collapsible ? 'none' : 'auto' }}>
        {collapsible && <ChevronDown size={18} style={{ color: 'var(--text-secondary)', transition: 'transform 0.2s', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }} />}
        <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{cfg.plural}</strong>
        <span style={microLabel}>{active.name}</span>
        <button className="primary-btn" onClick={(e) => { e.stopPropagation(); onAdd(); }} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: '0.8rem' }}><Plus size={14} /> Add</button>
      </div>
      {shown && (<>
      {sum && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {sum.map(([l, v]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
              <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>{v}</span><span style={microLabel}>{l}</span>
            </div>
          ))}
        </div>
      )}
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
      </>)}
    </Panel>
  );
}

/* ---------- modals ---------- */
function FormField({ f, value, onChange }) {
  const common = { className: 'form-input', value: value ?? '', onChange: e => onChange(f.k, e.target.value), readOnly: f.readOnly, style: { fontSize: '0.85rem', ...(f.readOnly ? { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'not-allowed' } : {}) } };
  if (f.type === 'file') {
    const onFile = async (e) => {
      const file = e.target.files?.[0]; if (!file) { return; }
      try { const url = await uploadAssetFile(file, false); onChange(f.k, url); if (f.nameKey) onChange(f.nameKey, file.name); } catch { /* ignore */ }
      e.target.value = '';
    };
    return (
      <div className={f.full ? 'form-group form-group-full' : 'form-group'}>
        <label>{f.label}{f.req ? <span style={{ color: 'hsl(var(--color-red))' }}> *</span> : ''}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label className="secondary-btn" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
            <Upload size={14} /> {value ? 'Replace file' : 'Upload file'}
            <input type="file" style={{ display: 'none' }} onChange={onFile} />
          </label>
          {value && <a href={value} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.82rem', color: 'hsl(var(--color-blue))', fontWeight: 600 }}><FileText size={14} /> View document</a>}
          {value && <button type="button" className="secondary-btn" onClick={() => onChange(f.k, '')} style={{ padding: '5px 11px', fontSize: '0.76rem' }}>Clear</button>}
        </div>
      </div>
    );
  }
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
function RowModal({ coll, row, canDelete = true, requireReason = false, onSave, onDelete, onClose }) {
  const cfg = COLLECTIONS[coll];
  const [vals, setVals] = useForm(cfg.fields, row);
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState('');
  const isWarranty = coll === 'warranties';
  const set = (k, v) => setVals(s => {
    const next = { ...s, [k]: v };
    if (isWarranty && (k === 'startDate' || k === 'expiration')) next.termMonths = monthsBetween(next.startDate, next.expiration);
    return next;
  });
  const submit = () => {
    for (const f of cfg.fields) if (f.req && !String(vals[f.k] || '').trim()) { alert('Please fill: ' + f.label); return; }
    const out = isWarranty ? { ...vals, termMonths: monthsBetween(vals.startDate, vals.expiration) } : vals;
    onSave(out);
  };
  const startRemove = () => { if (requireReason) setRemoving(true); else if (window.confirm(`Remove this ${cfg.title.toLowerCase()}?`)) onDelete(); };
  const confirmRemove = () => { if (!reason.trim()) { alert('Please give a reason for removing this ' + cfg.title.toLowerCase() + '.'); return; } onDelete(reason.trim()); };
  return (
    <Modal title={(row ? 'Edit ' : 'Add ') + cfg.title.toLowerCase()} onClose={onClose}
      footer={removing ? <>
        <button className="secondary-btn" onClick={() => { setRemoving(false); setReason(''); }}>Cancel</button>
        <button className="primary-btn" onClick={confirmRemove} style={{ backgroundColor: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }}>Confirm remove</button>
      </> : <>
        {row && canDelete && <button className="secondary-btn" onClick={startRemove} style={{ marginRight: 'auto', color: 'hsl(var(--color-red))' }}>Remove</button>}
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={submit}>Save</button>
      </>}>
      {removing && (
        <div style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 10, border: '1px solid hsla(var(--color-red), 0.4)', backgroundColor: 'hsla(var(--color-red), 0.08)' }}>
          <label style={{ ...microLabel, display: 'block', marginBottom: 6 }}>Reason for removing this {cfg.title.toLowerCase()} <span style={{ color: 'hsl(var(--color-red))' }}>*</span></label>
          <textarea className="form-input" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder={`Why is this ${cfg.title.toLowerCase()} being removed?`} style={{ fontSize: '0.85rem' }} />
        </div>
      )}
      <div className="form-grid">{cfg.fields.map(f => {
        const v = (isWarranty && f.k === 'termMonths') ? monthsBetween(vals.startDate, vals.expiration) : vals[f.k];
        return <FormField key={f.k} f={f} value={v} onChange={set} />;
      })}</div>
    </Modal>
  );
}
// Address fields that need a reason when an EXISTING property is edited.
const ADDRESS_FIELDS = [['address', 'Street address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['county', 'County']];
function PropertyModal({ row, properties, onSave, onDelete, onClose }) {
  // Asset class — chosen at creation, fixed when editing. Drives which field schema is shown.
  const [kind, setKind] = useState(() => inferAssetKind(row));
  const schema = ASSET_SCHEMAS[kind] || PROPERTY_FIELDS;
  const flat = schema.filter(f => !f.sec);
  const isProp = kind === 'property';
  const noun = kind === 'vehicle' ? 'vehicle' : kind === 'equipment' ? 'equipment' : 'property';
  // Every OTHER property (any one can be linked to), excluding self. Linking is property-only.
  const others = (properties || []).filter(x => (!row || x.id !== row.id) && inferAssetKind(x) === 'property');
  const [vals, setVals] = useState(() => {
    const init = { image: row?.image || '' };
    if (row) { Object.keys(row).forEach(k => { init[k] = row[k]; }); }
    else { [PROPERTY_FIELDS, VEHICLE_FIELDS, EQUIPMENT_FIELDS].forEach(s => s.forEach(f => { if (!f.sec) init[f.k] = init[f.k] ?? ''; })); }
    return init;
  });
  const [reason, setReason] = useState('');
  // Linking: pick a property to link to, then choose whether THIS property is the primary or secondary.
  const [linkTarget, setLinkTarget] = useState(row?.parentId || '');
  const [linkRole, setLinkRole] = useState('secondary');
  const targetName = others.find(x => x.id === linkTarget)?.name || '';
  const fileRef = useRef(null);
  const set = (k, v) => setVals(s => ({ ...s, [k]: v }));
  const onPickImage = async (e) => { const f = e.target.files?.[0]; if (f && f.type.startsWith('image/')) { try { set('image', await uploadAssetFile(f, true)); } catch { /* ignore */ } } e.target.value = ''; };
  // Address-change reason only applies to properties (a vehicle's "address" is its home base).
  const changedAddr = (row && isProp) ? ADDRESS_FIELDS.filter(([k]) => String(row[k] ?? '') !== String(vals[k] ?? '')) : [];
  const needReason = changedAddr.length > 0;
  const submit = () => {
    for (const f of flat) if (f.req && !String(vals[f.k] || '').trim()) { alert('Please fill: ' + f.label); return; }
    if (needReason && !reason.trim()) { alert('Please give a reason for the address change.'); return; }
    // Non-property assets carry their kind + assetType + a rebuilt snapshot so the Overview reflects edits.
    const payload = isProp ? { ...vals, kind: 'property' }
      : { ...vals, kind, assetType: kind === 'vehicle' ? 'Vehicle' : 'Heavy Equipment', snapshot: buildAssetSnapshot(schema, vals) };
    // Linking is offered only when ADDING a property; never touch links on edit or for non-property assets.
    let link;
    if (!isProp) link = { role: 'none' };
    else if (!row) link = linkTarget ? { targetId: linkTarget, role: linkRole } : { role: 'none' };
    else link = undefined;
    onSave(payload, needReason ? reason.trim() : undefined, link);
  };
  const remove = () => { if (window.confirm(`Delete "${row.name}"? It moves to "Recover deleted" and can be restored later.`)) onDelete(); };
  return (
    <Modal title={row ? ('Edit ' + noun) : 'Add asset'} wide onClose={onClose}
      footer={<>
        {row && onDelete && <button className="secondary-btn" onClick={remove} style={{ marginRight: 'auto', color: 'hsl(var(--color-red))' }}>Delete</button>}
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={submit}>Save {noun}</button>
      </>}>
      {/* Asset class — only when ADDING (a property can't later become a vehicle). Swaps the field schema. */}
      {!row && (
        <div style={{ marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid var(--border-color)' }}>
          <div style={{ ...microLabel, color: 'var(--pine)', fontSize: '0.7rem', marginBottom: 10 }}>Asset class</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {ASSET_KINDS.map(([k, lbl]) => {
              const on = kind === k;
              return (
                <button key={k} type="button" onClick={() => setKind(k)}
                  style={{ padding: '9px 14px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem', border: `1.5px solid ${on ? 'var(--pine)' : 'var(--border-color)'}`, background: on ? 'var(--pine)' : 'var(--bg-card)', color: on ? '#fff' : 'var(--text-secondary)' }}>{lbl}</button>
              );
            })}
          </div>
        </div>
      )}
      {needReason && (
        <div style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 10, border: '1px solid hsla(var(--color-gold), 0.5)', backgroundColor: 'hsla(var(--color-gold), 0.1)' }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'hsl(var(--color-gold))', marginBottom: 6 }}>⚠ You changed the address — reason required</div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginBottom: 8 }}>Changing: <strong style={{ color: 'var(--text-primary)' }}>{changedAddr.map(([, l]) => l).join(', ')}</strong>. A reason is recorded in the activity log.</div>
          <input className="form-input" autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is the address being changed? (required)" style={{ fontSize: '0.85rem' }} />
        </div>
      )}
      {/* Linking FIRST — only when ADDING a property (one-time at creation; not shown when editing or for non-property assets) */}
      {!row && isProp && (
      <div style={{ marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ ...microLabel, color: 'var(--pine)', fontSize: '0.7rem', marginBottom: 10 }}>Linking <span style={{ textTransform: 'none', fontWeight: 400, color: 'var(--text-secondary)' }}>(optional)</span></div>
        <div className="form-group">
          <label>Link this property to another</label>
          <select className="form-input" value={linkTarget} onChange={e => setLinkTarget(e.target.value)}>
            <option value="">— Standalone (not linked) —</option>
            {others.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
        {linkTarget && (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Make this property the…</label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {[['secondary', 'Secondary', `linked under “${targetName}”`], ['primary', 'Primary', `“${targetName}” links under this`]].map(([v, t, sub]) => {
                const on = linkRole === v;
                const col = v === 'primary' ? 'var(--pine)' : 'hsl(var(--color-purple))';
                return (
                  <button key={v} type="button" onClick={() => setLinkRole(v)}
                    style={{ flex: '1 1 200px', textAlign: 'left', padding: '11px 13px', borderRadius: 10, cursor: 'pointer', border: `1.5px solid ${on ? col : 'var(--border-color)'}`, backgroundColor: on ? (v === 'primary' ? 'var(--bg-secondary)' : 'hsla(var(--color-purple), 0.08)') : 'var(--bg-card)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 15, height: 15, borderRadius: '50%', border: `2px solid ${on ? col : 'var(--border-color)'}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{on && <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: col }} />}</span>
                      <span style={{ fontSize: '0.85rem', fontWeight: 700, color: on ? col : 'var(--text-primary)' }}>{t}</span>
                    </div>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 4, marginLeft: 22 }}>{sub}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      )}
      <div className="form-grid">
        {schema.filter(f => f.k !== 'parentId').map((f, i) => f.sec
          ? <div key={i} style={{ ...microLabel, gridColumn: '1 / -1', marginTop: i ? 8 : 0, color: 'var(--pine)', fontSize: '0.7rem' }}>{f.sec}</div>
          : <FormField key={f.k} f={f} value={vals[f.k]} onChange={set} />)}
      </div>
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-color)' }}>
        <div style={{ ...microLabel, color: 'var(--pine)', fontSize: '0.7rem', marginBottom: 10 }}>{isProp ? 'Property image' : 'Asset image'}</div>
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


// Activity Log tab — full audit history: who changed what field, in which tab, on which
// property, and when. Newest first, grouped by day.
function LogsTab({ logs, query, onOpenProperty, activeId, activeName, onGoTo, onUndo, canUndo }) {
  const q = query || '';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [confirmUndo, setConfirmUndo] = useState(null); // log id pending undo confirmation
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
          <label style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 5 }}>From <input type="date" className="form-input" value={from} onChange={e => setFrom(e.target.value)} style={dinp} /></label>
          <label style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 5 }}>To <input type="date" className="form-input" value={to} onChange={e => setTo(e.target.value)} style={dinp} /></label>
          {(from || to) && <button className="secondary-btn" onClick={() => { setFrom(''); setTo(''); }} style={{ padding: '5px 11px', fontSize: '0.76rem' }}>Clear</button>}
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        <span title={l.user} style={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', fontWeight: 700, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.14)' }}>{initials(l.user)}</span>
                        <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.user}</span>
                        <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {l.undone && <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><RotateCcw size={12} /> Undone</span>}
                          {l.propertyId && onGoTo && (
                            <button onClick={() => onGoTo(l)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 7, border: '1px solid var(--border-color)', background: 'var(--bg-card)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600, color: 'hsl(var(--color-blue))', whiteSpace: 'nowrap' }}>Go to {l.action === 'removed' ? l.section : (l.changes && l.changes.length ? 'field' : l.section)} →</button>
                          )}
                          {onUndo && canUndo && canUndo(l) && (
                            <button onClick={() => setConfirmUndo(l.id)} title="Undo this change" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 7, border: '1px solid hsl(var(--color-gold) / 0.5)', background: 'hsla(var(--color-gold), 0.1)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: 'hsl(var(--color-gold))', whiteSpace: 'nowrap' }}><RotateCcw size={12} /> Undo</button>
                          )}
                        </div>
                      </div>
                      {confirmUndo === l.id && (
                        <div style={{ marginTop: 8, padding: '11px 13px', borderRadius: 9, border: '1px solid hsl(var(--color-gold) / 0.5)', backgroundColor: 'hsla(var(--color-gold), 0.08)' }}>
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-primary)', marginBottom: 9 }}>Undo this change? {l.action === 'added' ? 'The property will be moved to Recover.' : l.action === 'removed' ? 'The property will be restored.' : 'The previous value(s) will be put back.'}</div>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button className="secondary-btn" onClick={() => setConfirmUndo(null)} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>Cancel</button>
                            <button className="primary-btn" onClick={() => { onUndo(l); setConfirmUndo(null); }} style={{ fontSize: '0.78rem', padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 5 }}><RotateCcw size={13} /> Undo</button>
                          </div>
                        </div>
                      )}
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

// Permit Matrix column keys vary per property — derive them from the rows (union of keys).
function permitCols(rows) {
  const keys = [];
  (rows || []).forEach(r => Object.keys(r).forEach(k => { if (k !== 'id' && k !== 'propertyId' && !keys.includes(k)) keys.push(k); }));
  if (!keys.length) return [['Permit / Approval', 'Permit / Approval'], ['Jurisdiction / Agency', 'Jurisdiction / Agency'], ['Status', 'Status'], ['Notes', 'Notes']];
  return keys.map(k => [k, k]);
}
// Editable variant of ReadTable — per-row Edit/Delete + Add row. Operates on original indices.
function EditTable({ title, subtitle, rows, cols, query, highlightItem, onAdd, onEdit, onDelete, onStatusClick }) {
  const data = rows || [];
  const columns = cols || (() => {
    const keys = [];
    data.forEach(r => Object.keys(r).forEach(k => { if (k !== 'id' && k !== 'propertyId' && !keys.includes(k)) keys.push(k); }));
    return keys.map(k => [k, k]);
  })();
  // Row title = first non-empty column value (matches the log's `item`) — used for "Go to field" highlight.
  const rowTitleOf = (r) => { for (const c of columns) { const t = String(r[c[0]] ?? '').trim(); if (t) return t; } return ''; };
  const q = (query || '').toLowerCase();
  let list = data.map((r, idx) => ({ r, idx })).filter(({ r }) => columns.some(c => String(r[c[0]] ?? '').trim()));
  if (q) list = list.filter(({ r }) => columns.some(c => String(r[c[0]] ?? '').toLowerCase().includes(q)));
  return (
    <Panel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '1rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{title}</strong>
        {subtitle && <span style={microLabel}>{subtitle}</span>}
        <span style={{ ...microLabel, marginLeft: 'auto' }}>{list.length} row{list.length === 1 ? '' : 's'}</span>
        <button className="primary-btn" onClick={onAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: '0.8rem' }}><Plus size={14} /> Add</button>
      </div>
      {list.length ? (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
            <thead><tr>
              {columns.map(c => <th key={c[0]} style={{ ...microLabel, textAlign: 'left', padding: '10px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>{c[1]}</th>)}
              <th style={{ ...microLabel, textAlign: 'right', padding: '10px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>Actions</th>
            </tr></thead>
            <tbody>{list.map(({ r, idx }) => {
              const hl = highlightItem && rowTitleOf(r) === highlightItem;
              return (
              <tr key={idx} ref={hl ? (el => el && el.scrollIntoView({ behavior: 'smooth', block: 'center' })) : null}
                style={{ transition: 'background-color 0.3s', background: hl ? 'hsla(var(--color-gold), 0.2)' : '', boxShadow: hl ? 'inset 3px 0 0 hsl(var(--color-gold))' : 'none' }}>
                {columns.map(c => {
                  const val = String(r[c[0]] ?? '').trim();
                  let cell;
                  if (c[0] === 'status' && onStatusClick) {
                    cell = <button onClick={() => onStatusClick(idx, val)} title="Change status (reason required)" style={{ border: '1px solid var(--border-color)', background: 'var(--bg-card)', borderRadius: 999, padding: '3px 6px', cursor: 'pointer' }}>{val ? <Chip c={statusColor(val)}>{val}</Chip> : <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Set status</span>}</button>;
                  } else if (c[0] === 'status' && val) {
                    cell = <Chip c={statusColor(val)}>{val}</Chip>;
                  } else cell = (val || '—');
                  return <td key={c[0]} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top', color: 'var(--text-primary)', fontSize: '0.78rem' }}>{cell}</td>;
                })}
                <td style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top', whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button className="secondary-btn" onClick={() => onEdit(idx)} style={{ padding: '5px 11px', fontSize: '0.74rem', marginRight: onDelete ? 6 : 0 }}>Edit</button>
                  {onDelete && <button className="secondary-btn" onClick={() => { if (window.confirm('Delete this row?')) onDelete(idx); }} style={{ padding: '5px 11px', fontSize: '0.74rem', color: 'hsl(var(--color-red))' }}>Delete</button>}
                </td>
              </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <Empty>No {title.toLowerCase()} data yet — use “Add row” to add one.</Empty>}
    </Panel>
  );
}
// Generic key/value row editor for Timeline & Permit rows (dynamic columns).
function ListRowModal({ title, fields, row, onSave, onDelete, onClose }) {
  const cols = fields || [];
  const [vals, setVals] = useState(() => { const init = {}; cols.forEach(([k]) => { init[k] = row ? (row[k] ?? '') : ''; }); return init; });
  const set = (k, v) => setVals(s => ({ ...s, [k]: v }));
  const long = (k) => /note|submittal|description|comment|scope|condition/i.test(k);
  return (
    <Modal title={(row ? 'Edit ' : 'Add ') + title.toLowerCase()} wide onClose={onClose}
      footer={<>
        {row && onDelete && <button className="secondary-btn" onClick={() => { if (window.confirm('Delete this row?')) onDelete(); }} style={{ marginRight: 'auto', color: 'hsl(var(--color-red))' }}>Delete</button>}
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={() => onSave(vals)}>Save</button>
      </>}>
      <div className="form-grid">
        {cols.map(([k, l, options]) => (
          <div key={k} className={long(k) ? 'form-group form-group-full' : 'form-group'}>
            <label>{l || k}</label>
            {options
              ? <select className="form-input" value={vals[k]} onChange={e => set(k, e.target.value)}><option value="">Select…</option>{options.map(o => <option key={o} value={o}>{o}</option>)}</select>
              : long(k)
                ? <textarea className="form-input" rows={3} value={vals[k]} onChange={e => set(k, e.target.value)} />
                : <input type="text" className="form-input" value={vals[k]} onChange={e => set(k, e.target.value)} />}
          </div>
        ))}
      </div>
    </Modal>
  );
}
// Change a Timeline item's status — reason is mandatory; the date auto-fills to today.
function StatusModal({ current, onSave, onClose }) {
  const [status, setStatus] = useState(current || '');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const submit = () => {
    if (!status) { alert('Please pick a status.'); return; }
    if (!reason.trim()) { alert('Please give a reason for the status change.'); return; }
    onSave(status, date, reason.trim());
  };
  return (
    <Modal title="Update status" onClose={onClose}
      footer={<>
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={submit}>Save</button>
      </>}>
      <div className="form-grid">
        <div className="form-group">
          <label>Status</label>
          <select className="form-input" value={status} onChange={e => setStatus(e.target.value)}><option value="">Select…</option>{STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select>
        </div>
        <div className="form-group">
          <label>Date</label>
          <input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="form-group form-group-full">
          <label>Reason <span style={{ color: 'hsl(var(--color-red))' }}>*</span></label>
          <textarea className="form-input" rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is the status changing?" />
        </div>
      </div>
    </Modal>
  );
}

/* ---------- shared bits ---------- */
function Panel({ children }) { return <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, boxShadow: 'var(--shadow-sm)', padding: 18 }}>{children}</div>; }
function Empty({ children }) {
  return <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.875rem', border: '1px dashed var(--border-color)', borderRadius: 12 }}>{children}</div>;
}
function Modal({ title, children, footer, wide, maxWidth, onClose }) {
  return (
    <div className="modal-overlay" style={{ display: 'flex' }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content" style={{ width: maxWidth ? 'min(94vw, ' + maxWidth + 'px)' : undefined, maxWidth: maxWidth || (wide ? 760 : 560) }}>
        <div className="modal-header"><h3>{title}</h3><button className="close-btn" onClick={onClose}><X size={18} /></button></div>
        <div style={{ padding: '4px 24px 16px' }}>{children}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 24px 18px', borderTop: '1px solid var(--border-color)' }}>{footer}</div>
      </div>
    </div>
  );
}

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
  const n = (v) => { const x = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return isNaN(x) ? 0 : x; };
  const nrsf = data.properties.reduce((s, p) => s + n(p.nrsf), 0);
  const units = data.properties.reduce((s, p) => s + n(p.unitsTotal), 0);
  const acreage = data.properties.reduce((s, p) => s + n(p.acreage), 0);
  return { assets: data.properties.length, parcels: data.properties.length, warr, insp, exp, nrsf, units, acreage };
}
/* ---------- PDF report ---------- */
function exportReport(p, data) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const v = (x) => { const s = (x ?? '') === '' ? '' : String(x); return s ? esc(s) : '—'; };
  const dt = (d) => d ? fmtDate(d) : '—';
  const collRows = (coll) => (data[coll] || []).filter(r => r.propertyId === p.id);

  // Related group (properties sharing this one's siteName — no primary/secondary).
  const fam = p.siteName ? data.properties.filter(x => x.siteName === p.siteName) : [p];
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
<div class="band"><div><h1>${esc(p.name)}</h1><div class="sub">${esc(fmtAddress(p))}${p.county ? ` · ${esc(fmtCounty(p.county))}` : ''} · APN ${esc(p.apn || '—')}</div></div>
<div class="r"><b>GREENS</b><br>Asset Report<br>${esc(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}<br>by ${esc(currentUser())}</div></div>

<div class="metrics">
${metric(fmtNum(p.nrsf), 'NRSF')}${metric(num0(p.unitsTotal) ? fmtNum(p.unitsTotal) : '—', 'Units')}${metric(p.acreage ? p.acreage + ' ac' : '—', 'Acreage')}${metric(v(p.yearBuilt), 'Year built')}${metric(fam.length > 1 ? fam.length : '—', 'Linked')}${metric(status, 'Status')}
</div>

<h2>Status &amp; alerts</h2>
${alertHtml}

${card(1, 'Identity & ownership', kv([['Operating entity', p.entity, false], ['Parcel role', p.parcelRole, false], ['Builder (GC)', p.builder, false], ['Asset manager', p.manager, false], ['County', p.county, false], ['Legal description', p.legalDesc, false]]))}
${card(2, 'Building & site', kv([['Year built', p.yearBuilt], ['Construction', p.constructionType, false], ['Stories', p.stories], ['NRSF', p.nrsf ? fmtNum(p.nrsf) : ''], ['GSF', p.gsf ? fmtNum(p.gsf) : ''], ['Acreage', p.acreage], ['Zoning / land use', p.zoning, false], ['Flood zone', p.floodZone], ['Sprinklered', p.sprinklered, false], ['Alarm monitored', p.alarmMonitored, false], ['Development stage', p.devStage, false]]))}
${card(3, 'Placed in service', kv([['Placed-in-service', dt(p.placedInService)], ['CO number', p.coNumber], ['CO date', dt(p.coDate)]]))}
${card(4, 'Unit mix', kv([['Non-climate', p.unitsNonClimate ? fmtNum(p.unitsNonClimate) : ''], ['Climate-controlled', p.unitsClimate ? fmtNum(p.unitsClimate) : ''], ['RV / boat', p.unitsRV ? fmtNum(p.unitsRV) : ''], ['Total units', p.unitsTotal ? fmtNum(p.unitsTotal) : '']]))}
${card(5, 'Insurance', kv([['Carrier', p.insCarrier, false], ['Policy #', p.insPolicy], ['Expiration', dt(p.insExpiration)], ['Agent / broker', [p.insAgent, p.insPhone].filter(Boolean).join(' · '), false]]))}
${card(6, 'Property tax', kv([['Tax account', p.taxId], ['Annual tax', p.taxAnnual ? fmtMoney(p.taxAnnual) : ''], ['Due dates', p.taxDue, false]]))}
${fam.length > 1 ? `<section class="card"><div class="card-h"><span>Related properties — ${esc(p.siteName)}</span></div>
<table class="data"><thead><tr><th>Property</th><th>APN</th><th>NRSF</th><th>Units</th><th>Acres</th></tr></thead><tbody>
${fam.map(x => `<tr><td>${esc(x.name)}${x.id === p.id ? ' (this property)' : ''}</td><td class="mono">${v(x.apn)}</td><td class="mono">${fmtNum(x.nrsf)}</td><td class="mono">${num0(x.unitsTotal) ? fmtNum(x.unitsTotal) : '—'}</td><td class="mono">${x.acreage || '—'}</td></tr>`).join('')}
<tr style="font-weight:700;background:#f8fafc"><td>Combined</td><td>—</td><td class="mono">${fmtNum(agg.nrsf)}</td><td class="mono">${fmtNum(agg.units)}</td><td class="mono">${agg.ac.toFixed(2)}</td></tr>
</tbody></table></section>` : ''}

${(() => { const t = tbl('warranties', [['scope', 'Scope'], ['party', 'Party / contractor'], ['kind', 'Type'], ['expiration', 'Expires', 'date']], 'expiration', 'w'); return t ? `<h2>Warranties</h2>${t}` : ''; })()}
${(() => { const t = tbl('inspections', [['type', 'Inspection'], ['frequency', 'Frequency'], ['vendor', 'Vendor'], ['nextDue', 'Next due', 'date']], 'nextDue', 'i'); return t ? `<h2>Inspections</h2>${t}` : ''; })()}
${(() => { const t = tbl('documents', [['title', 'Document'], ['category', 'Category'], ['version', 'Version'], ['location', 'Egnyte location']]); return t ? `<h2>Plans &amp; Documents</h2>${t}` : ''; })()}
${(() => { const t = tbl('ahj', [['authority', 'Authority'], ['jurisdiction', 'Jurisdiction'], ['accountOrPermit', 'Account / permit'], ['renewalDate', 'Renewal', 'date']], 'renewalDate', 'r'); return t ? `<h2>Authorities Having Jurisdiction</h2>${t}` : ''; })()}
${(() => { const t = tbl('utilities', [['service', 'Service'], ['provider', 'Provider'], ['accountNumber', 'Account #'], ['meterNumber', 'Meter'], ['avgMonthly', 'Avg / mo']]); return t ? `<h2>Utilities</h2>${t}` : ''; })()}
${(() => { const t = tbl('vendors', [['company', 'Vendor'], ['category', 'Category'], ['contractEnd', 'Contract end', 'date'], ['coiExpiration', 'COI', 'date']], 'coiExpiration', 'r'); return t ? `<h2>Vendors</h2>${t}` : ''; })()}

<div class="foot"><span>Confidential — Greens Global · Asset Management</span><span>Generated ${esc(new Date().toLocaleString())} · ${esc(currentUser())}</span></div>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script></body></html>`;
  const w = window.open('', '_blank'); if (!w) { alert('Allow pop-ups to export the PDF report.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
const devStatusReport = (stage) => { const s = (stage || '').toLowerCase(); if (!s) return '—'; if (/(built|in[\s-]?use|open|developed|stabili|operat|complete|occupied|finaled)/.test(s)) return 'Active'; if (/(feasib|entitl|permit|construction|planning|grading|design)/.test(s)) return 'Under Dev'; return '—'; };
