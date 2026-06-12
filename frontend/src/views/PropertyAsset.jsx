import { useState, useEffect, useRef } from 'react';
import {
  Building2, Shield, ClipboardCheck, FileText, Plug, ListChecks, FileCheck,
  ArrowLeft, Plus, Pencil, Check, Trash2, MapPin, X, File as FileIcon, ExternalLink,
  UploadCloud, Download, History, Filter, ChevronDown, Camera, Link2,
} from 'lucide-react';
import { msalInstance } from '../msalInstance';
import timelineTemplate from '../data/timeline-template.json';

// Current signed-in user (for activity logs).
const currentUser = () => {
  const a = msalInstance.getAllAccounts()[0];
  return a?.name || a?.username || 'You';
};
const entryTitle = (entry) => (entry && entry.fields && entry.fields[0] && entry.fields[0].value) || 'entry';

// Field-level diffs for activity logs — returns ["<name> · <Field>: \"old\" → \"new\"", ...]
const cellStr = (v) => (v && typeof v === 'object') ? (v.name || '') : (v ?? '');
const fieldEntryDiff = (oldE, newE) => {
  const res = [];
  if (oldE && ('name' in (newE || {})) && (oldE.name ?? '') !== (newE.name ?? '')) res.push(`Name: "${oldE.name || '—'}" → "${newE.name || '—'}"`);
  (newE.fields || []).forEach((f, i) => {
    const o = cellStr(oldE?.fields?.[i]?.value), n = cellStr(f.value);
    if (String(o) !== String(n)) res.push(`${f.label}: "${o || '—'}" → "${n || '—'}"`);
  });
  return res;
};
const flatEntryDiff = (oldO, newO, defs) => {
  const res = [];
  defs.forEach(([label, key]) => {
    const o = oldO?.[key] ?? '', n = newO?.[key] ?? '';
    if (String(o) !== String(n)) res.push(`${label}: "${o || '—'}" → "${n || '—'}"`);
  });
  return res;
};

// IndexedDB blob store — keeps uploaded files of ANY type/size locally (no localStorage quota limit).
const IDB_NAME = 'nexus_asset_files', IDB_STORE = 'files';
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(IDB_STORE)) r.result.createObjectStore(IDB_STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(key, blob) { const db = await idbOpen(); return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(blob, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
async function idbGet(key) { const db = await idbOpen(); return new Promise((res, rej) => { const tx = db.transaction(IDB_STORE, 'readonly'); const rq = tx.objectStore(IDB_STORE).get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }
const fmtBytes = (n) => { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`; };
const fmtLogDate = (ts) => { try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ts; } };
async function downloadIdbFile(key, name) {
  try { const blob = await idbGet(key); if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name || 'file'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); } catch { /* ignore */ }
}
// Read an uploaded image File, downscale it (longest side -> maxDim) and return a
// compressed JPEG data URL. Small enough to live in the property record (localStorage),
// so the card photo persists across reloads and updates instantly on change.
function fileToScaledDataUrl(file, maxDim = 900, quality = 0.82) {
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

// Standard Overview template — same across all existing properties. New properties get
// these blank groups/fields (editable) so the old-template cards are there from the start.
const SNAPSHOT_TEMPLATE = () => [
  ['Project Details', ['Project Name', 'Property Address', 'City', 'County', 'State', 'Zip', 'APN(s)', 'Legal Description (short)', 'Current Use', 'Proposed Use', 'Development Stage (Feasibility / Entitlement / Permitting / Construction / Stabilized)']],
  ['Ownership + Core Team', ['Ownership Entity', 'Seller (if applicable)', 'Developer / Sponsor', 'PM / Asset Manager', 'Architect', 'Civil', 'Structural', 'MEP', 'GC / CM', 'Land Use Attorney', 'Title / Escrow']],
  ['Site Data', ['Lot Size (SF / Acres)', 'Dimensions', 'Topography', 'Access Points', 'Street Frontage', 'Easements / Encroachments', 'Flood Zone', 'Soils / Geotech Notes']],
  ['Zoning + Land Use', ['Jurisdiction', 'General Plan', 'Zoning', 'Overlays / Specific Plan', 'Height / FAR Limits', 'Setbacks (F/S/R)', 'Parking Required', 'Design Review / CUP / Variance (Yes/No + notes)']],
  ['Existing Improvements', ['Existing Structures (Yes/No)', 'Existing Building SF', 'Year Built', 'Occupancy (Vacant/Tenant)', 'Demo Needed (Yes/No)', 'Known Issues / Violations', 'Sprinklered (Yes/No)', 'Alarm Monitored (Yes/No)']],
  // Asset-management / operations fields (per Neil's Property tab) — backfilled onto every
  // property via normalizeSnapshot, and ready for the next Excel version's columns.
  ['Insurance', ['Insurance Carrier', 'Policy Number', 'Policy Expiration Date', 'Insurance Agent']],
  ['Property Tax', ['Tax Account Number', 'Annual Tax', 'Tax Due Date']],
  ['Unit Mix', ['Climate Units', 'Non-Climate Units', 'RV Units', 'Total Units']],
].map(([group, labels]) => ({ group, fields: labels.map(label => ({ label, value: '' })) }));
const emptyDetail = () => ({ snapshot: SNAPSHOT_TEMPLATE(), utilities: UTILITIES_TEMPLATE(), ahj: [], warranties: [], inspections: [], documents: [], permitsTimeline: structuredClone(timelineTemplate), logs: [] });
// Ensure every property's Overview has all template groups/fields (e.g. the newer
// Insurance / Property Tax / Unit Mix groups, Sprinklered / Alarm flags). Existing values
// and order are preserved; only missing groups/fields are appended (empty + editable).
const normalizeSnapshot = (snapshot) => {
  const result = (snapshot || []).map(g => ({ ...g, fields: [...(g.fields || [])] }));
  SNAPSHOT_TEMPLATE().forEach(tg => {
    let g = result.find(x => x.group === tg.group);
    if (!g) { g = { group: tg.group, fields: [] }; result.push(g); }
    tg.fields.forEach(tf => { if (!g.fields.some(f => f.label === tf.label)) g.fields.push({ label: tf.label, value: '' }); });
  });
  return result;
};
// Real properties (per-file). To add/update one: regenerate its JSON and list it here.
const REAL = [georgetown, austin, lakeside, rainbow, escondidoNorth, escondidoSouth, sachse,
  valleyCenterNorth, valleyCenterEast, valleyCenterSouth, greensFamily918, gurudevFamily910, rjkResidence, greensFairfield];
// Build the seed list deduped by id — same id never duplicates (it updates instead).
const SEED = [...new Map(REAL.map(p => [p.id, p])).values()];
const LS_KEY = 'nexus_asset_properties';

// Inner sections shown AFTER opening a property (property-scoped — per Neil's feedback).
const SECTIONS = [
  { key: 'overview',    label: 'Overview',            Icon: Building2 },
  { key: 'utilities',   label: 'Utilities & Vendors', Icon: Plug },
  { key: 'timeline',    label: 'Timeline',            Icon: ListChecks },
  { key: 'permit',      label: 'Permit',              Icon: FileCheck },
  { key: 'documents',   label: 'Plans & Docs',        Icon: FileText },
  { key: 'warranties',  label: 'Warranties',          Icon: Shield },
  { key: 'inspections', label: 'Inspections',         Icon: ClipboardCheck },
];
// Map a tab key -> the section name used in activity logs.
const SECTION_LOG = { overview: 'Overview', utilities: 'Utilities', timeline: 'Timeline', permit: 'Permit', documents: 'Plans & Docs', warranties: 'Warranties', inspections: 'Inspections' };

// Card summary fields <-> top-level JSON keys (editable, mapped both ways).
const SUMMARY_FIELDS = [
  ['Property Name', 'name'], ['Property Category', 'type'], ['Geographic Address', 'address'],
  ['Total Units/Suites', 'units'], ['Acquisition Cost ($)', 'purchaseCost'],
  ['Year Completed', 'yearBuilt'], ['Occupancy (%)', 'occupancyRate'], ['Asset Manager', 'manager'],
];

// Templates for new editable entries (shapes mirror Neil's demo).
const WARRANTY_TPL   = ['Type', 'Scope / item covered', 'Contractor / manufacturer', 'Contact', 'Phone', 'Email', 'Start date', 'Term (months)', 'Expiration', 'Document location', 'Coverage summary', 'Status', 'Notes'];
const WARRANTY_STATUS_OPTIONS = ['Active', 'Expiring Soon', 'Expired', 'Claimed', 'Void'];
const warrantyStatusColor = (s) => { const v = (s || '').toLowerCase(); if (v === 'active') return 'green'; if (v === 'expiring soon') return 'gold'; if (v === 'expired') return 'red'; if (v === 'claimed') return 'blue'; return null; };
const INSPECTION_TPL = ['Inspection type', 'Frequency', 'Vendor', 'Vendor phone', 'Last completed', 'Next due', 'Cost', 'Document', 'Notes'];
// Plans & Docs render as Development-style file chips; fields kept the same.
const DOC_FIELDS = [['Title', 'title'], ['Category', 'category'], ['Document date', 'date'], ['Version / set', 'version'], ['Location (Egnyte path)', 'location'], ['Notes', 'notes']];
const mkDoc = () => ({ title: '', category: '', date: '', version: '', location: '', notes: '', updatedAt: 0, fileName: '', fileSize: 0, fileKey: '' });
// Asset-management-centric document categories (per Neil) — the As-Built plans set is the
// core. "Other (type manually)" is added in the dropdown for anything not listed.
const DOC_CATEGORY_OPTIONS = [
  'Certificate of Occupancy',
  'Permit',
  'Survey',
  'Geotech',
  'O&M Manual',
  'Closeout Set',
  'As-Built - Electrical',
  'As-Built - HVAC',
  'As-Built - Landscape',
  'As-Built - Low Voltage',
];

// Timeline editable rows + status dropdown.
const TIMELINE_FIELDS = [['Phase', 'phase'], ['Permit / Approval', 'permit'], ['Issuing Agency', 'agency'], ['When Required', 'whenRequired'], ['Key Submittals', 'submittals'], ['Review Time', 'reviewTime']];
const mkTimeline = () => ({ phase: '', permit: '', agency: '', whenRequired: '', submittals: '', reviewTime: '', status: 'Not Started' });
const STATUS_OPTIONS = ['Not Started', 'In Progress', 'Pending', 'Completed', 'On Hold', 'N/A'];
const statusStyle = (s) => {
  const v = (s || '').toLowerCase();
  if (v.startsWith('complete')) return { c: 'green' };
  if (v === 'in progress') return { c: 'blue' };
  if (v === 'pending') return { c: 'gold' };
  if (v === 'on hold') return { c: 'orange' };
  return { c: null }; // Not Started / N/A / unknown -> neutral
};

// Permit Matrix (Excel sheet 4) — editable, Development "Permit Status" style.
const PERMIT_FIELDS = [['Phase', 'phase'], ['Permit / Approval Type', 'type'], ['Permit No', 'permitNo'], ['Permit Expiration Date', 'expiration'], ['Jurisdiction / Agency', 'agency'], ['Agency Contact', 'agencyContact'], ['Internal Owner', 'internalOwner'], ['Initial Submittal Date', 'initialSubmittal'], ['Re-submittal Date 1', 'resubmittal1'], ['Re-submittal Date 2', 'resubmittal2'], ['Re-submittal Date 3', 'resubmittal3'], ['Ball in whose Court', 'ballInCourt'], ['Permit Issuance Date', 'issuanceDate'], ['Notes', 'notes']];
const mkPermit = () => ({ status: 'Not Submitted', phase: '', type: '', permitNo: '', expiration: '', agency: '', agencyContact: '', internalOwner: '', initialSubmittal: '', resubmittal1: '', resubmittal2: '', resubmittal3: '', ballInCourt: '', issuanceDate: '', notes: '' });
const PERMIT_STATUS_OPTIONS = ['Not Submitted', 'Submitted', 'Under Review', 'Approved', 'Issued', 'Rejected', 'Expired'];
// Permit / Approval types — sourced from the Excel Timeline sheet. Pick one or choose "Other".
const PERMIT_TYPE_OPTIONS = [
  'Pre-Application Meeting', 'General Plan Amendment (if needed)', 'Zone Change (Rezone)', 'Conditional Use Permit (CUP)',
  'Variance', 'Development Agreement (if applicable)', 'CEQA Exemption', 'Initial Study / Mitigated ND',
  'Environmental Impact Report (EIR)', 'Site Plan Review', 'Architectural Review', 'Landscape Plan Approval',
  'Grading Permit', 'SWPPP (Stormwater Pollution Prevention Plan)', 'Encroachment Permit', 'Water Service Approval',
  'Sewer Capacity Letter', 'Fire Flow Letter', 'Building Permit', 'Structural / MEP Plan Check', 'Fire Department Permit',
  'Elevator Permit (if applicable)', 'Solar Permit (if required by code)', 'Foundation / Framing / MEP Inspections',
  'Fire Final Inspection', 'Certificate of Occupancy (COO)', 'Business License', 'Alcohol License', 'Cal/OSHA Permit',
  'Coastal Development Permit', 'Air Quality Permit',
];
const permitStatusStyle = (s) => {
  const v = (s || '').toLowerCase();
  if (v === 'approved' || v === 'issued') return { c: 'green' };
  if (v === 'under review' || v === 'submitted') return { c: 'blue' };
  if (v === 'rejected' || v === 'expired') return { c: 'red' };
  if (v === 'pending action') return { c: 'orange' };
  return { c: null }; // Not Submitted / N/A / unknown -> neutral
};
const UTILITY_TPL    = ['Authority / Agency Type', 'Contact Name', 'Email', 'Phone', 'Application / Account #', 'Status', 'Notes'];
// Common utility cards present across (almost) all properties — fixed template for new ones.
const UTILITY_TEMPLATE_NAMES = ['Electric Utility', 'Gas Utility', 'Water Utility', 'Sewer Utility', 'Trash Utility', 'Storm Drain', 'Internet Service Provider'];
const UTILITIES_TEMPLATE = () => UTILITY_TEMPLATE_NAMES.map(name => ({ name, fields: UTILITY_TPL.map(label => ({ label, value: '' })) }));
const mkEntry  = (labels) => ({ fields: labels.map(label => ({ label, value: '' })) });
const mkUtility = () => ({ name: '', fields: UTILITY_TPL.map(label => ({ label, value: '' })) });

// Render these labels as native date pickers instead of text inputs.
const isDateLabel = (label) => {
  const l = (label || '').toLowerCase();
  return l.includes('date') || l === 'expiration' || l === 'last completed' || l === 'next due';
};

// Snapshot fields that should be dropdowns (option-type). Matched by label prefix.
const SNAPSHOT_OPTIONS = [
  ['occupancy (vacant', ['Vacant', 'Tenant', 'Rental Units', 'Owner-Occupied']],
  ['development stage', ['Feasibility', 'Entitlement', 'Permitting', 'Construction', 'Built', 'Stabilized']],
  ['existing structures', ['Yes', 'No']],
  ['demo needed', ['Yes', 'No']],
  ['sprinklered', ['Yes', 'No']],
  ['alarm monitored', ['Yes', 'No']],
];
const fieldOptions = (label) => {
  const l = (label || '').toLowerCase();
  for (const [key, opts] of SNAPSHOT_OPTIONS) if (l.startsWith(key)) return opts;
  return null;
};

// Read a value out of a property's snapshot groups (for card summary fields).
const snapVal = (p, group, prefix) => {
  for (const g of (p.snapshot || [])) {
    if (g.group === group) {
      for (const f of (g.fields || [])) {
        if (f.label.toLowerCase().startsWith(prefix.toLowerCase())) return f.value;
      }
    }
  }
  return '';
};
// Split an APN string into individual parcels (handles & , / and "and" separators).
const splitParcels = (apn) => (apn ? apn.split(/[&,/]|\band\b/i).map(x => x.trim()).filter(Boolean) : []);
const stageColor = (s) => {
  const v = (s || '').toLowerCase();
  if (v.includes('built') || v.includes('stabilized')) return 'green';
  if (v.includes('entitle')) return 'blue';
  if (v.includes('feasibility')) return 'gold';
  if (v.includes('permit') || v.includes('construction')) return 'orange';
  return null;
};
// High-level status from the granular development stage: a completed/operating asset is
// "Active"; anything still in feasibility/entitlement/permitting/construction is
// "Under Development". Returns null when the stage is blank/unknown.
const devStatus = (stage) => {
  const s = (stage || '').toLowerCase();
  if (!s) return null;
  const done = /(built|in[\s-]?use|open|developed|stabili[sz]ed|operat|complete|occupied|finaled)/.test(s);
  if (done) return 'Active';
  if (/(feasib|entitl|permit|construction|planning|predevelop|grading|design)/.test(s)) return 'Under Development';
  return null;
};
const statusColor = (status) => status === 'Active' ? 'green' : status === 'Under Development' ? 'orange' : null;

const DELETED_KEY = 'nexus_asset_deleted';
const loadDeleted = () => { try { return JSON.parse(localStorage.getItem(DELETED_KEY) || '[]'); } catch { return []; } };

function loadProperties() {
  const seedById = Object.fromEntries(SEED.map(p => [p.id, p]));
  let savedById = {};
  try { savedById = Object.fromEntries(JSON.parse(localStorage.getItem(LS_KEY) || '[]').map(p => [p.id, p])); } catch { /* ignore */ }
  // Seed properties first; overlay the user's saved edits, but keep any NEW seed
  // top-level fields (e.g. image) that aren't in the saved copy yet.
  const result = SEED.map(p => ({ ...p, ...(savedById[p.id] || {}) }));
  // Keep only user-created properties (Add Property -> id starts 'p-'); drop anything else
  // left in storage (e.g. removed mock properties).
  Object.values(savedById).forEach(p => {
    if (!seedById[p.id] && String(p.id).startsWith('p-')) result.push(p);
  });
  const deleted = loadDeleted();
  // Backfill any newly-added Overview groups/fields onto every property.
  return result.filter(p => !deleted.includes(p.id)).map(p => ({ ...p, snapshot: normalizeSnapshot(p.snapshot) }));
}

export default function PropertyAsset() {
  const [properties, setProperties] = useState(loadProperties);
  const [selectedId, setSelectedId] = useState(null);
  const [section, setSection] = useState('overview');
  const [editMode, setEditMode] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [editBaseline, setEditBaseline] = useState(null);
  const [reasonModal, setReasonModal] = useState(null); // pending Overview changes awaiting a reason
  const [overviewReason, setOverviewReason] = useState('');
  const [showLink, setShowLink] = useState(false);
  const [linkForm, setLinkForm] = useState({ name: '', ids: [] });
  const [editPropertyId, setEditPropertyId] = useState(null); // editing an existing property's summary via portfolio
  const [deleteConfirm, setDeleteConfirm] = useState(null);    // property pending delete
  const [portfolioManage, setPortfolioManage] = useState(false); // portfolio edit/manage mode (per-card edit+delete)
  const [form, setForm] = useState({ name: '', type: '', units: '', address: '', purchaseCost: '', yearBuilt: '', occupancyRate: '', manager: '' });

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(properties)); } catch { /* ignore quota */ }
  }, [properties]);

  const selected = properties.find(p => p.id === selectedId) || null;

  const mutate = (fn) => setProperties(prev => prev.map(p => {
    if (p.id !== selectedId) return p;
    const clone = structuredClone(p);
    fn(clone);
    return clone;
  }));

  // Append one or more activity-log entries (newest first) to the selected property.
  // One change = ONE log entry: which item, which fields changed (old→new), + optional reason.
  const log = (section, action, item, changes = [], reason = '') => {
    const lines = (Array.isArray(changes) ? changes : [changes]).filter(Boolean);
    if (!lines.length && !item) return;
    const entry = { ts: new Date().toISOString(), user: currentUser(), property: selected?.name || '', section, action, item: item || '', changes: lines, reason: reason || '' };
    mutate(p => { p.logs = [entry, ...(p.logs || [])]; });
  };

  // Overview is edited inline; diff the snapshot+summary between Edit start and "Done".
  const overviewDiff = (before, after) => {
    const ch = [];
    SUMMARY_FIELDS.forEach(([label, key]) => {
      const b = key === 'manager' ? (before.manager ?? before.assetManager ?? '') : (before[key] ?? '');
      const a = key === 'manager' ? (after.manager ?? after.assetManager ?? '') : (after[key] ?? '');
      if (String(b) !== String(a)) ch.push(`${label}: "${b || '—'}" → "${a || '—'}"`);
    });
    (after.snapshot || []).forEach((g, gi) => (g.fields || []).forEach((f, fi) => {
      const b = before.snapshot?.[gi]?.fields?.[fi]?.value ?? '';
      if (String(b) !== String(f.value ?? '')) ch.push(`${f.label}: "${b || '—'}" → "${f.value || '—'}"`);
    }));
    return ch;
  };

  // Utilities are also edited inline via the common Edit button; diff them too.
  const utilitiesDiff = (before, after) => {
    const ch = [];
    const bu = before.utilities || [], au = after.utilities || [];
    au.forEach((u, ui) => {
      const b = bu[ui];
      if (!b) { ch.push(`Added "${u.name || 'utility'}"`); return; }
      if ((b.name ?? '') !== (u.name ?? '')) ch.push(`${u.name || b.name} · Name: "${b.name || '—'}" → "${u.name || '—'}"`);
      (u.fields || []).forEach((f, fi) => {
        const bv = b.fields?.[fi]?.value ?? '';
        if (String(bv) !== String(f.value ?? '')) ch.push(`${u.name || 'utility'} · ${f.label}: "${bv || '—'}" → "${f.value || '—'}"`);
      });
    });
    if (bu.length > au.length) ch.push(`Removed ${bu.length - au.length} utilit${bu.length - au.length === 1 ? 'y' : 'ies'}`);
    return ch;
  };

  const toggleEdit = () => {
    if (!editMode) { setEditBaseline(structuredClone(selected)); setEditMode(true); return; }
    const ov = editBaseline ? overviewDiff(editBaseline, selected) : [];
    const ut = editBaseline ? utilitiesDiff(editBaseline, selected) : [];
    if (ov.length || ut.length) { setReasonModal({ ov, ut }); return; }  // changed -> ask reason before saving
    setEditBaseline(null); setEditMode(false);                            // no change -> just exit
  };
  const confirmOverviewReason = (e) => {
    e.preventDefault();
    if (reasonModal.ov.length) log('Overview', 'edited', '', reasonModal.ov, overviewReason);
    if (reasonModal.ut.length) log('Utilities', 'edited', '', reasonModal.ut, overviewReason);
    setReasonModal(null); setOverviewReason(''); setEditBaseline(null); setEditMode(false);
  };
  const cancelOverviewReason = () => { setReasonModal(null); setOverviewReason(''); }; // back to editing

  const openProperty = (id, edit = false) => { setSelectedId(id); setSection('overview'); setEditMode(edit); setShowLogs(false); };

  // Phone bottom bar: while a property is open, broadcast its sections as the
  // bar's actions (same contextual pattern as Item Management). Cleared on
  // back/unmount so other screens get their own bars.
  const MOBILE_SECTION_LABEL = { overview: 'Overview', utilities: 'Utilities', timeline: 'Timeline', permit: 'Permit', documents: 'Docs', warranties: 'Warranty', inspections: 'Inspect' };
  useEffect(() => {
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    if (!selectedId) {
      window.dispatchEvent(new CustomEvent('nexus:mobile-actions', { detail: { actions: null } }));
      return;
    }
    window.dispatchEvent(new CustomEvent('nexus:mobile-actions', {
      detail: { actions: SECTIONS.map(s => ({ id: s.key, label: MOBILE_SECTION_LABEL[s.key] || s.label, active: s.key === section })) },
    }));
    const h = e => e.detail?.id && setSection(e.detail.id);
    window.addEventListener('nexus:mobile-action', h);
    return () => {
      window.removeEventListener('nexus:mobile-action', h);
      window.dispatchEvent(new CustomEvent('nexus:mobile-actions', { detail: { actions: null } }));
    };
  }, [selectedId, section]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back from a property detail: return to its group's sub-list if grouped, else the portfolio.
  const backToPortfolio = () => { setSelectedId(null); setEditMode(false); setShowLogs(false); };
  const backToTop = () => { setSelectedGroup(null); setSelectedId(null); setEditMode(false); setShowLogs(false); };

  const blankForm = { name: '', type: '', units: '', address: '', purchaseCost: '', yearBuilt: '', occupancyRate: '', manager: '' };
  const closeAddModal = () => { setShowAdd(false); setEditPropertyId(null); setForm(blankForm); };

  // Open the portfolio Add/Edit modal pre-filled to edit an existing property's summary.
  const openEditProperty = (p) => {
    setForm({
      name: p.name || '', type: p.type || '', units: p.units ?? '', address: p.address || '',
      purchaseCost: p.purchaseCost ?? '', yearBuilt: p.yearBuilt ?? '',
      occupancyRate: p.occupancyRate ?? '', manager: p.manager || p.assetManager || '',
    });
    setEditPropertyId(p.id);
    setShowAdd(true);
  };

  const deleteProperty = (id) => {
    const deleted = loadDeleted();
    if (!deleted.includes(id)) { deleted.push(id); try { localStorage.setItem(DELETED_KEY, JSON.stringify(deleted)); } catch { /* ignore */ } }
    setProperties(prev => prev.filter(p => p.id !== id));
    setDeleteConfirm(null);
  };

  // Upload/replace a property's card photo. Scaled to a compact JPEG so it persists
  // in localStorage; the card updates immediately because the property record changes.
  const changePropertyImage = async (id, file) => {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const dataUrl = await fileToScaledDataUrl(file);
      setProperties(prev => prev.map(p => p.id === id ? { ...p, image: dataUrl } : p));
    } catch { /* ignore unreadable image */ }
  };

  const submitAdd = (e) => {
    e.preventDefault();
    if (editPropertyId) {
      // Edit existing property's summary fields.
      setProperties(prev => prev.map(p => p.id !== editPropertyId ? p : {
        ...p, name: form.name, type: form.type, address: form.address,
        units: form.units ? parseInt(form.units, 10) : '',
        purchaseCost: form.purchaseCost ? parseInt(form.purchaseCost, 10) : '',
        yearBuilt: form.yearBuilt ? parseInt(form.yearBuilt, 10) : '',
        occupancyRate: form.occupancyRate ? parseInt(form.occupancyRate, 10) : null,
        manager: form.manager,
      }));
      closeAddModal();
      return;
    }
    const p = {
      id: 'p-' + Date.now(),
      name: form.name, type: form.type, address: form.address,
      units: form.units ? parseInt(form.units, 10) : '',
      purchaseCost: form.purchaseCost ? parseInt(form.purchaseCost, 10) : '',
      yearBuilt: form.yearBuilt ? parseInt(form.yearBuilt, 10) : '',
      occupancyRate: form.occupancyRate ? parseInt(form.occupancyRate, 10) : null,
      manager: form.manager, ...emptyDetail(),
    };
    // Pre-fill the matching Overview template fields from the add form.
    const setSnap = (group, prefix, value) => { const g = p.snapshot.find(x => x.group === group); const f = g && g.fields.find(x => x.label.toLowerCase().startsWith(prefix.toLowerCase())); if (f && value) f.value = String(value); };
    setSnap('Project Details', 'Project Name', form.name);
    setSnap('Project Details', 'Property Address', form.address);
    setSnap('Project Details', 'Current Use', form.type);
    setSnap('Existing Improvements', 'Year Built', form.yearBuilt);
    setSnap('Ownership + Core Team', 'PM / Asset Manager', form.manager);
    setProperties(prev => [...prev, p]);
    closeAddModal();
  };

  // Link selected properties under a site name (group). Unchecking a current member unlinks it.
  const submitLink = (e) => {
    e.preventDefault();
    const name = linkForm.name.trim();
    if (!name) return;
    setProperties(prev => prev.map(p => {
      if (linkForm.ids.includes(p.id)) return { ...p, group: name };
      if (p.group === name) { const { group, ...rest } = p; return rest; }
      return p;
    }));
    setShowLink(false);
    setLinkForm({ name: '', ids: [] });
  };

  // ---------------- GROUP SUB-LIST (a site, e.g. Greens Escondido -> North / South) ----------------
  if (!selected && selectedGroup) {
    const items = properties.filter(p => p.group === selectedGroup);
    return (
      <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
        <div style={{ marginBottom: 20 }}>
          <button className="secondary-btn" onClick={backToTop} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', fontSize: '0.8rem', marginBottom: 10 }}>
            <ArrowLeft size={14} /> Portfolio
          </button>
          <h3 style={{ fontSize: '1.2rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>{selectedGroup}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{items.length} properties under this site — open one to see its full details</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
          {items.map(p => <PropertyCard key={p.id} p={p} onOpen={openProperty} manage={portfolioManage} onEdit={openEditProperty} onDelete={setDeleteConfirm} onChangeImage={changePropertyImage} />)}
        </div>
      </div>
    );
  }

  // ---------------- PORTFOLIO ----------------
  if (!selected) {
    const groups = {}; const standalone = [];
    properties.forEach(p => { if (p.group) (groups[p.group] ||= []).push(p); else standalone.push(p); });
    return (
      <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
        <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h3 style={{ fontSize: '1.1rem', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 4 }}>Real Estate Property Portfolio</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Track properties Values, Occupancy, capacities, and active managers</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className={portfolioManage ? 'primary-btn' : 'secondary-btn'} onClick={() => setPortfolioManage(m => !m)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {portfolioManage ? <><Check size={14} /> Done</> : <><Pencil size={14} /> Edit</>}
            </button>
            <button className="secondary-btn" onClick={() => { setLinkForm({ name: '', ids: [] }); setShowLink(true); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ListChecks size={14} /> Link Properties
            </button>
            <button className="primary-btn" onClick={() => setShowAdd(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Plus size={14} /> Add Property Asset
            </button>
          </div>
        </div>

        {portfolioManage && (
          <div style={{ marginBottom: 16, padding: '8px 12px', borderRadius: 8, fontSize: '0.8rem', color: 'hsl(var(--color-gold))', backgroundColor: 'hsla(var(--color-gold), 0.08)', border: '1px solid hsla(var(--color-gold), 0.25)' }}>
            Edit mode — use the ✏️ and 🗑️ on each card to edit or delete a property. Click <strong>Done</strong> when finished.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
          {standalone.map(p => <PropertyCard key={p.id} p={p} onOpen={openProperty} manage={portfolioManage} onEdit={openEditProperty} onDelete={setDeleteConfirm} onChangeImage={changePropertyImage} />)}
          {Object.entries(groups).map(([name, items]) => <GroupCard key={name} name={name} items={items} onOpen={setSelectedGroup} />)}
        </div>

        {showAdd && (
          <div className="modal-overlay" style={{ display: 'flex' }}>
            <div className="modal-content">
              <div className="modal-header">
                <h3>{editPropertyId ? 'Edit Property' : 'Register Property Asset'}</h3>
                <button className="close-btn" onClick={closeAddModal}><X size={18} /></button>
              </div>
              <form onSubmit={submitAdd}>
                <div className="form-grid">
                  <div className="form-group form-group-full">
                    <label>Property Name<Req /></label>
                    <input type="text" className="form-input" required placeholder="e.g. Greens Plaza East" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Property Category<Req /></label>
                    <input type="text" className="form-input" required placeholder="e.g. Mixed-Use Commercial" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Total Units/Suites</label>
                    <input type="number" className="form-input" min="1" placeholder="e.g. 64" value={form.units} onChange={e => setForm(f => ({ ...f, units: e.target.value }))} />
                  </div>
                  <div className="form-group form-group-full">
                    <label>Geographic Address<Req /></label>
                    <input type="text" className="form-input" required placeholder="e.g. 101 North Boulevard, Sector 4" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Acquisition Cost ($)</label>
                    <input type="number" className="form-input" min="1" placeholder="e.g. 24000000" value={form.purchaseCost} onChange={e => setForm(f => ({ ...f, purchaseCost: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Year Completed</label>
                    <input type="number" className="form-input" min="1900" max="2030" placeholder="e.g. 2025" value={form.yearBuilt} onChange={e => setForm(f => ({ ...f, yearBuilt: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Initial Occupancy (%)</label>
                    <input type="number" className="form-input" min="0" max="100" placeholder="e.g. 90" value={form.occupancyRate} onChange={e => setForm(f => ({ ...f, occupancyRate: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label>Assigned Asset Manager</label>
                    <input type="text" className="form-input" placeholder="e.g. Sarah Johnson" value={form.manager} onChange={e => setForm(f => ({ ...f, manager: e.target.value }))} />
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="secondary-btn" onClick={closeAddModal}>Cancel</button>
                  <button type="submit" className="primary-btn">{editPropertyId ? 'Save changes' : 'Save Asset'}</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {showLink && (
          <div className="modal-overlay" style={{ display: 'flex' }}>
            <div className="modal-content">
              <div className="modal-header">
                <h3>Link properties into a site</h3>
                <button className="close-btn" onClick={() => setShowLink(false)}><X size={18} /></button>
              </div>
              <form onSubmit={submitLink}>
                <div className="form-grid">
                  <div className="form-group form-group-full">
                    <label>Site / Linkage name</label>
                    <input list="link-groups" className="form-input" required placeholder="e.g. Greens Escondido"
                      value={linkForm.name}
                      onChange={e => { const name = e.target.value; const has = properties.some(p => p.group === name); setLinkForm(f => ({ name, ids: has ? properties.filter(p => p.group === name).map(p => p.id) : f.ids })); }} />
                    <datalist id="link-groups">{[...new Set(properties.map(p => p.group).filter(Boolean))].map(g => <option key={g} value={g} />)}</datalist>
                  </div>
                  <div className="form-group form-group-full">
                    <label>Select properties under this site</label>
                    <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 8, padding: 6 }}>
                      {properties.map(p => (
                        <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', cursor: 'pointer', fontSize: '0.85rem' }}>
                          <input type="checkbox" checked={linkForm.ids.includes(p.id)}
                            onChange={() => setLinkForm(f => ({ ...f, ids: f.ids.includes(p.id) ? f.ids.filter(x => x !== p.id) : [...f.ids, p.id] }))} />
                          <span style={{ flex: 1 }}>{p.name}</span>
                          {p.group && <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>in {p.group}</span>}
                        </label>
                      ))}
                    </div>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 4 }}>Tip: type an existing site name to edit its members. Unchecking a current member unlinks it.</span>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="secondary-btn" onClick={() => setShowLink(false)}>Cancel</button>
                  <button type="submit" className="primary-btn">Save linkage</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {deleteConfirm && (
          <div className="modal-overlay" style={{ display: 'flex' }}>
            <div className="modal-content" style={{ maxWidth: 440 }}>
              <div className="modal-header">
                <h3>Delete property?</h3>
                <button className="close-btn" onClick={() => setDeleteConfirm(null)}><X size={18} /></button>
              </div>
              <div style={{ padding: '6px 2px 14px', fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                Are you sure you want to delete <strong>{deleteConfirm.name}</strong>? This removes the property and all its details from the portfolio.
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                <button type="button" className="primary-btn" style={{ backgroundColor: 'hsl(var(--color-red))', borderColor: 'hsl(var(--color-red))' }} onClick={() => deleteProperty(deleteConfirm.id)}>Delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---------------- PROPERTY DETAIL ----------------
  const active = SECTIONS.find(s => s.key === section) || SECTIONS[0];
  const summaryFields = SUMMARY_FIELDS.map(([label, key]) => ({
    label, key,
    value: key === 'manager' ? (selected.manager || selected.assetManager || '') : (selected[key] ?? ''),
  }));

  return (
    <div style={{ animation: 'fadeIn var(--transition-normal) ease-in-out' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <button className="secondary-btn" onClick={backToPortfolio} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', fontSize: '0.8rem', marginBottom: 10 }}>
            <ArrowLeft size={14} /> {selected.group || 'Portfolio'}
          </button>
          <h2 style={{ fontSize: '1.6rem', fontWeight: 700, letterSpacing: '-0.01em', fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 6 }}>{selected.name}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{selected.type || '—'}</span>
            {selected.address && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><MapPin size={13} /> {selected.address}</span>}
            {selected.occupancyRate != null && selected.occupancyRate !== '' && (
              <span style={{ fontSize: '0.74rem', fontWeight: 700, padding: '2px 9px', borderRadius: 20, color: 'hsl(var(--color-green))', backgroundColor: 'hsla(var(--color-green), 0.1)' }}>{selected.occupancyRate}% Occupied</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button className="secondary-btn" onClick={() => setShowLogs(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <History size={14} /> Logs{selected.logs && selected.logs.length ? ` (${selected.logs.length})` : ''}
          </button>
          <button className={editMode ? 'primary-btn' : 'secondary-btn'} onClick={toggleEdit} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {editMode ? <><Check size={14} /> Done Editing</> : <><Pencil size={14} /> Edit</>}
          </button>
        </div>
      </div>

      {/* Inner section tabs (property-scoped) — desktop only; phones use the
          bottom action bar (pa-tabs hidden ≤640 like Item Management) */}
      <div className="scroll-tabs pa-tabs" style={{ display: 'flex', gap: 4, marginBottom: 22, padding: 5, borderRadius: 14, backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', overflowX: 'auto' }}>
        {SECTIONS.map(({ key, label, Icon }) => {
          const on = section === key;
          return (
            <button key={key} onClick={() => setSection(key)}
              style={{ background: on ? 'var(--bg-card)' : 'transparent', border: '1px solid', borderColor: on ? 'var(--border-color)' : 'transparent', borderRadius: 10, padding: '8px 14px', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', whiteSpace: 'nowrap', color: on ? 'var(--text-primary)' : 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 7, boxShadow: on ? 'var(--shadow-sm)' : 'none', transition: 'all 0.15s' }}>
              <Icon size={16} style={{ color: on ? 'hsl(var(--color-blue))' : 'inherit' }} /> {label}
            </button>
          );
        })}
      </div>

      <div style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: 26, boxShadow: 'var(--shadow-sm)' }}>
        <SectionHeading Icon={active.Icon} title={active.label}
          lastUpdated={(() => { const l = (selected.logs || []).find(x => x.section === SECTION_LOG[section]); return l ? fmtLogDate(l.ts) : null; })()} />

        {section === 'overview' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
            <FieldCard title="Property Summary" fields={summaryFields} editMode={editMode}
              onField={(fi, v) => mutate(p => { p[summaryFields[fi].key] = v; })} />
            {(selected.snapshot || []).map((g, gi) => (
              <FieldCard key={gi} title={g.group} fields={g.fields} editMode={editMode}
                onField={(fi, v) => mutate(p => { p.snapshot[gi].fields[fi].value = v; })} />
            ))}
          </div>
        )}

        {section === 'utilities' && (
          <>
            {editMode && (
              <button className="primary-btn" onClick={() => mutate(p => { (p.utilities ||= []).push(mkUtility()); })} style={{ marginBottom: 16, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Plus size={14} /> Add Utility
              </button>
            )}
            {(selected.utilities || []).length === 0
              ? <EmptyState label="No utilities yet — click Edit (top-right) to add and fill in." />
              : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
                  {(selected.utilities || []).map((u, ci) => (
                    <FieldCard key={ci} title={u.name || `Utility ${ci + 1}`} fields={u.fields} editMode={editMode}
                      onField={(fi, v) => mutate(p => { p.utilities[ci].fields[fi].value = v; })}
                      onName={(v) => mutate(p => { p.utilities[ci].name = v; })}
                      onDelete={() => mutate(p => { p.utilities.splice(ci, 1); })} />
                  ))}
                </div>
              )}
          </>
        )}
        {section === 'warranties' && (
          <EntriesSection list={selected.warranties} title="Warranty" template={WARRANTY_TPL}
            fullWidth={['Scope / item covered', 'Coverage summary', 'Notes', 'Document location']}
            selectOptions={{ Status: WARRANTY_STATUS_OPTIONS }}
            onAdd={(en) => { mutate(p => { (p.warranties ||= []).push(en); }); log('Warranties', 'added', entryTitle(en)); }}
            onUpdate={(i, en, reason) => { const d = fieldEntryDiff(selected.warranties[i], en); mutate(p => { p.warranties[i] = en; }); log('Warranties', 'updated', entryTitle(en), d, reason); }}
            onDelete={(i) => { const nm = entryTitle(selected.warranties[i]); mutate(p => { p.warranties.splice(i, 1); }); log('Warranties', 'removed', nm); }} />
        )}
        {section === 'inspections' && (
          <EntriesSection list={selected.inspections} title="Inspection" template={INSPECTION_TPL}
            fullWidth={['Notes', 'Document']} fileFields={['Document']}
            onAdd={(en) => { mutate(p => { (p.inspections ||= []).push(en); }); log('Inspections', 'added', entryTitle(en)); }}
            onUpdate={(i, en, reason) => { const d = fieldEntryDiff(selected.inspections[i], en); mutate(p => { p.inspections[i] = en; }); log('Inspections', 'updated', entryTitle(en), d, reason); }}
            onDelete={(i) => { const nm = entryTitle(selected.inspections[i]); mutate(p => { p.inspections.splice(i, 1); }); log('Inspections', 'removed', nm); }} />
        )}
        {section === 'documents' && (
          <DocsSection list={selected.documents}
            onAdd={(doc) => { doc.updatedAt = Date.now(); mutate(p => { (p.documents ||= []).push(doc); }); log('Plans & Docs', 'added', doc.title || 'document'); }}
            onUpdate={(i, doc, reason) => { const d = flatEntryDiff(selected.documents[i], doc, DOC_FIELDS); doc.updatedAt = Date.now(); mutate(p => { p.documents[i] = doc; }); log('Plans & Docs', 'updated', doc.title || 'document', d, reason); }}
            onDelete={(i) => { const nm = selected.documents[i]?.title || 'document'; mutate(p => { p.documents.splice(i, 1); }); log('Plans & Docs', 'removed', nm); }} />
        )}

        {section === 'timeline' && (
          <TimelineSection list={selected.permitsTimeline}
            onAdd={(row) => { mutate(p => { (p.permitsTimeline ||= []).push(row); }); log('Timeline', 'added', row.phase || row.permit || 'phase'); }}
            onUpdate={(i, row, reason) => { const d = flatEntryDiff(selected.permitsTimeline[i], row, [...TIMELINE_FIELDS, ['Status', 'status']]); mutate(p => { p.permitsTimeline[i] = row; }); log('Timeline', 'updated', row.phase || row.permit || 'phase', d, reason); }}
            onStatus={(i, v, reason) => { const nm = selected.permitsTimeline[i]?.phase || selected.permitsTimeline[i]?.permit || `#${i + 1}`; mutate(p => { p.permitsTimeline[i].status = v; }); log('Timeline', 'status', nm, [`Status → ${v}`], reason); }}
            onDelete={(i) => { const nm = selected.permitsTimeline[i]?.phase || 'phase'; mutate(p => { p.permitsTimeline.splice(i, 1); }); log('Timeline', 'removed', nm); }} />
        )}

        {section === 'permit' && (
          <PermitSection list={selected.permitMatrix}
            onAdd={(row) => { mutate(p => { (p.permitMatrix ||= []).push(row); }); log('Permit', 'added', row.type || row.phase || 'permit'); }}
            onUpdate={(i, row, reason) => { const d = flatEntryDiff(selected.permitMatrix[i], row, [...PERMIT_FIELDS, ['Permit Status', 'status']]); mutate(p => { p.permitMatrix[i] = row; }); log('Permit', 'updated', row.type || row.phase || 'permit', d, reason); }}
            onStatus={(i, v, reason) => { const nm = selected.permitMatrix[i]?.type || selected.permitMatrix[i]?.phase || `#${i + 1}`; mutate(p => { p.permitMatrix[i].status = v; }); log('Permit', 'status', nm, [`Status → ${v}`], reason); }}
            onDelete={(i) => { const nm = selected.permitMatrix[i]?.type || 'permit'; mutate(p => { p.permitMatrix.splice(i, 1); }); log('Permit', 'removed', nm); }} />
        )}
      </div>

      {showLogs && <LogsModal logs={selected.logs} title={selected.name} onClose={() => setShowLogs(false)} />}

      {reasonModal && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Reason for change</h3>
              <button className="close-btn" onClick={cancelOverviewReason}><X size={18} /></button>
            </div>
            <form onSubmit={confirmOverviewReason}>
              <div style={{ padding: '4px 2px 10px' }}>
                {(() => { const all = [...(reasonModal.ov || []), ...(reasonModal.ut || [])]; return (
                  <>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.83rem', marginBottom: 10 }}>You changed {all.length} field{all.length === 1 ? '' : 's'}. Give a reason (saved to the activity log):</p>
                    <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: '0.8rem', color: 'var(--text-primary)', maxHeight: 160, overflowY: 'auto' }}>
                      {all.map((c, i) => <li key={i} style={{ marginBottom: 4, wordBreak: 'break-word' }}>{c}</li>)}
                    </ul>
                  </>
                ); })()}
                <div className="form-group form-group-full">
                  <label>Reason for change <span style={{ color: 'hsl(var(--color-red))' }}>*</span></label>
                  <input className="form-input" value={overviewReason} onChange={e => setOverviewReason(e.target.value)} required autoFocus placeholder="Why are you changing this?" />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={cancelOverviewReason}>Back to editing</button>
                <button type="submit" className="primary-btn">Save changes</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- presentational helpers ---------- */

// Red asterisk for mandatory field labels.
const Req = () => <span style={{ color: 'hsl(var(--color-red))' }}> *</span>;

// Mandatory "reason for change" — shown when editing an existing record (audit trail).
function ReasonField({ value, onChange }) {
  return (
    <div className="form-group form-group-full">
      <label>Reason for change <span style={{ color: 'hsl(var(--color-red))' }}>*</span></label>
      <input className="form-input" value={value || ''} onChange={e => onChange(e.target.value)} required
        placeholder="Why are you changing this? (recorded in the activity log)" />
    </div>
  );
}

// One property card (portfolio + group sub-list). In manage mode it shows edit/delete
// and lets you upload/replace the card photo (auto-updates this card on change).
function PropertyCard({ p, onOpen, manage, onEdit, onDelete, onChangeImage }) {
  const stage = snapVal(p, 'Project Details', 'Development Stage');
  const status = devStatus(stage);
  const stColor = statusColor(status);
  const parcels = splitParcels(snapVal(p, 'Project Details', 'APN'));
  const apnPrimary = parcels[0] || '';
  const apnDisplay = apnPrimary ? (parcels.length > 1 ? `${apnPrimary} · +${parcels.length - 1} more` : apnPrimary) : '';
  const stop = (fn) => (e) => { e.stopPropagation(); fn(p); };
  const fileRef = useRef(null);
  const pickPhoto = (e) => { e.stopPropagation(); fileRef.current?.click(); };
  const onPick = (e) => { const f = e.target.files?.[0]; if (f) onChangeImage?.(p.id, f); e.target.value = ''; };
  const canPhoto = manage && onChangeImage;
  return (
    <div className="motion-card" onClick={() => onOpen(p.id)} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', transition: 'all 0.15s', cursor: 'pointer' }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-hover)'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}>
      {canPhoto && <input ref={fileRef} type="file" accept="image/*" onChange={onPick} onClick={e => e.stopPropagation()} style={{ display: 'none' }} />}
      {p.image ? (
        <div style={{ position: 'relative' }}>
          <img src={p.image} alt={p.name} loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block', borderBottom: '1px solid var(--border-color)' }} />
          {canPhoto && (
            <button onClick={pickPhoto} title="Change photo" style={{ position: 'absolute', top: 8, left: 8, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', fontSize: '0.72rem', fontWeight: 600, color: '#fff', background: 'rgba(15,23,42,0.62)', border: 'none', borderRadius: 6, cursor: 'pointer', backdropFilter: 'blur(2px)' }}>
              <Camera size={13} /> Change photo
            </button>
          )}
        </div>
      ) : canPhoto ? (
        <button onClick={pickPhoto} title="Add photo" style={{ width: '100%', height: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', border: 'none', borderBottom: '1px dashed var(--border-color)', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>
          <Camera size={18} /> Add photo
        </button>
      ) : null}
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
          <div>
            <strong style={{ fontSize: '1.05rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'block' }}>{p.name}</strong>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{p.type || '—'}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
            {manage && (onEdit || onDelete) && (
              <div style={{ display: 'flex', gap: 4 }}>
                {onEdit && <button className="secondary-btn" title="Edit property" onClick={stop(onEdit)} style={{ padding: '4px 6px' }}><Pencil size={13} /></button>}
                {onDelete && <button className="secondary-btn" title="Delete property" onClick={stop(onDelete)} style={{ padding: '4px 6px' }}><Trash2 size={13} /></button>}
              </div>
            )}
            {status && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.72rem', fontWeight: 700, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', color: `hsl(var(--color-${stColor}))`, backgroundColor: `hsla(var(--color-${stColor}), 0.12)` }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: `hsl(var(--color-${stColor}))` }} />{status}
              </span>
            )}
            {stage && <span style={{ fontSize: '0.7rem', fontWeight: 500, color: 'var(--text-secondary)', whiteSpace: 'nowrap', textAlign: 'right' }}>{stage}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.825rem', marginBottom: 16, borderBottom: '1px dashed var(--border-color)', paddingBottom: 12 }}>
          {[['Address', p.address], ['APN', apnDisplay], ['Year Completed', String(p.yearBuilt ?? '').replace(/\?/g, '').trim()], ['Building SF', p.buildingSf]].map(([label, val]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: 'var(--text-secondary)' }}>{label}:</span>
              <strong style={{ color: 'var(--text-primary)', textAlign: 'right' }}>{val || '—'}</strong>
            </div>
          ))}
        </div>
        <button className="secondary-btn" onClick={() => onOpen(p.id)} style={{ width: '100%', padding: '6px 12px', fontSize: '0.8rem' }}>View Details</button>
      </div>
    </div>
  );
}

// A site card grouping multiple properties (e.g. Greens Escondido -> North / South).
function GroupCard({ name, items, onOpen }) {
  const img = (items.find(p => p.image) || {}).image;
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const cities = uniq(items.map(p => snapVal(p, 'Project Details', 'City')));
  const location = cities.length === 1 ? cities[0] : cities.length > 1 ? 'Multiple' : '';
  const mgrs = uniq(items.map(p => p.manager || p.assetManager));
  const manager = mgrs.length === 1 ? mgrs[0] : mgrs.length > 1 ? 'Multiple' : '—';
  // Count UNIQUE parcels across the site: dedupe so two linked properties sharing the
  // same APN aren't double-counted.
  const parcelSet = new Set();
  items.forEach(p => splitParcels(snapVal(p, 'Project Details', 'APN')).forEach(x => parcelSet.add(x)));
  const parcels = parcelSet.size;
  const totalSf = items.reduce((s, p) => { const n = parseInt(String(p.buildingSf || '').replace(/[^0-9]/g, ''), 10); return s + (Number.isFinite(n) ? n : 0); }, 0);
  const stageCounts = {};
  items.forEach(p => { const st = snapVal(p, 'Project Details', 'Development Stage'); if (st) stageCounts[st] = (stageCounts[st] || 0) + 1; });
  const stageMix = Object.entries(stageCounts).map(([s, c]) => `${c} ${s}`).join(' · ');
  // Site-level status: all Active / all Under Development, otherwise a Mixed badge.
  const statuses = [...new Set(items.map(p => devStatus(snapVal(p, 'Project Details', 'Development Stage'))).filter(Boolean))];
  const groupStatus = statuses.length === 1 ? statuses[0] : statuses.length > 1 ? 'Mixed' : null;
  const gColor = groupStatus === 'Mixed' ? 'blue' : statusColor(groupStatus);
  const rows = [
    ['Asset Manager', manager],
    ['Parcels (APN)', parcels || '—'],
    ['Total Building SF', totalSf ? `${totalSf.toLocaleString()} SF` : '—'],
    ...(stageMix ? [['Stages', stageMix]] : []),
  ];
  return (
    <div className="motion-card" onClick={() => onOpen(name)} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', transition: 'all 0.15s', cursor: 'pointer' }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-hover)'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}>
      {img && <img src={img} alt={name} loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block', borderBottom: '1px solid var(--border-color)' }} />}
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: '1.05rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif", display: 'block' }}>{name}</strong>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 3, fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.1)' }}>
              <Link2 size={12} /> Linked Site{location ? ` · ${location}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
            {groupStatus && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.72rem', fontWeight: 700, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', color: `hsl(var(--color-${gColor}))`, backgroundColor: `hsla(var(--color-${gColor}), 0.12)` }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: `hsl(var(--color-${gColor}))` }} />{groupStatus}
              </span>
            )}
            <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{items.length} properties</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.825rem', marginBottom: 12, paddingBottom: 12, borderBottom: '1px dashed var(--border-color)' }}>
          {rows.map(([label, val]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ color: 'var(--text-secondary)' }}>{label}:</span>
              <strong style={{ color: 'var(--text-primary)', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val}</strong>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: '0.8rem', marginBottom: 16 }}>
          {items.map(p => (
            <div key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, color: 'var(--text-primary)', fontWeight: 500 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: 'hsl(var(--color-purple))', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </div>
          ))}
        </div>
        <button className="secondary-btn" onClick={() => onOpen(name)} style={{ width: '100%', padding: '6px 12px', fontSize: '0.8rem' }}>Open Site ({items.length})</button>
      </div>
    </div>
  );
}

function SectionHeading({ Icon, title, lastUpdated }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
      {Icon && <Icon size={18} style={{ color: 'var(--text-secondary)' }} />}
      <h3 style={{ fontSize: '1.05rem', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{title}</h3>
      {lastUpdated && <span style={{ marginLeft: 'auto', fontSize: '0.74rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Last updated: {lastUpdated}</span>}
    </div>
  );
}

function FieldRow({ label, value, editMode, onChange }) {
  const opts = fieldOptions(label);
  let input;
  if (!editMode) {
    input = <span style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 500, wordBreak: 'break-word' }}>{(value ?? '') === '' ? '—' : value}</span>;
  } else if (opts) {
    const all = [...opts, ...(value && !opts.includes(value) ? [value] : [])];
    input = (
      <select className="form-input" value={value ?? ''} onChange={e => onChange(e.target.value)} style={{ fontSize: '0.85rem', padding: '6px 8px' }}>
        <option value="">Select…</option>
        {all.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else {
    input = <input className="form-input" type={isDateLabel(label) ? 'date' : 'text'} value={value ?? ''} onChange={e => onChange(e.target.value)} style={{ fontSize: '0.85rem', padding: '6px 8px' }} />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.02em' }}>{label}</span>
      {input}
    </div>
  );
}

function FieldCard({ title, fields, editMode, onField, onDelete, onName }) {
  return (
    <div style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12, borderBottom: '1px dashed var(--border-color)', paddingBottom: 8 }}>
        {editMode && onName
          ? <input className="form-input" value={title} onChange={e => onName(e.target.value)} style={{ fontSize: '0.9rem', fontWeight: 600, padding: '4px 8px' }} />
          : <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{title}</strong>}
        {editMode && onDelete && (
          <button className="secondary-btn" onClick={onDelete} style={{ padding: '3px 7px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <Trash2 size={12} /> Remove
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {(fields || []).map((f, fi) => (
          <FieldRow key={fi} label={f.label} value={f.value} editMode={editMode} onChange={v => onField(fi, v)} />
        ))}
      </div>
    </div>
  );
}

// Warranties / Inspections — self-contained CRUD (always-on Add, per-card Edit/Remove via modal).
// fileFields: labels rendered as file uploads (value becomes { name, dataUrl? }).
function EntriesSection({ list, title, template, fullWidth = [], fileFields = [], selectOptions = {}, onAdd, onUpdate, onDelete }) {
  const items = list || [];
  const [editing, setEditing] = useState(null); // { index, draft } (index === -1 => add)

  const openAdd  = () => setEditing({ index: -1, draft: mkEntry(template) });
  const openEdit = (i) => setEditing({ index: i, draft: structuredClone(items[i]) });
  const close    = () => setEditing(null);
  const setFieldVal = (fi, v) => setEditing(ed => { const d = structuredClone(ed.draft); d.fields[fi].value = v; return { ...ed, draft: d }; });
  const setFile = (fi, file) => {
    if (!file) return;
    const finish = (val) => setEditing(ed => { const d = structuredClone(ed.draft); d.fields[fi].value = val; return { ...ed, draft: d }; });
    if (file.size <= 1.5 * 1024 * 1024) {              // small files: keep inline so they download later
      const reader = new FileReader();
      reader.onload = () => finish({ name: file.name, dataUrl: reader.result });
      reader.readAsDataURL(file);
    } else {                                            // large files: store name only (real storage = backend phase)
      finish({ name: file.name });
    }
  };
  const save = (e) => { e.preventDefault(); editing.index === -1 ? onAdd(editing.draft) : onUpdate(editing.index, editing.draft, editing.reason); close(); };
  const cardTitle = (entry, i) => (entry.fields && entry.fields[0] && typeof entry.fields[0].value === 'string' && entry.fields[0].value) || `${title} ${i + 1}`;
  const isFileVal = (v) => v && typeof v === 'object' && v.name;

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Add {title}
        </button>
      </div>

      {items.length === 0
        ? <EmptyState label={`No ${title.toLowerCase()} entries yet — click “Add ${title}”.`} />
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
            {items.map((entry, i) => (
              <div key={i} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12, borderBottom: '1px dashed var(--border-color)', paddingBottom: 8 }}>
                  <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif", wordBreak: 'break-word' }}>{cardTitle(entry, i)}</strong>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button className="secondary-btn" title="Edit" onClick={() => openEdit(i)} style={{ padding: '4px 6px' }}><Pencil size={13} /></button>
                    <button className="secondary-btn" title="Remove" onClick={() => onDelete(i)} style={{ padding: '4px 6px' }}><Trash2 size={13} /></button>
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {(entry.fields || []).map((f, fi) => (
                    <div key={fi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.02em' }}>{f.label}</span>
                      {isFileVal(f.value)
                        ? (f.value.dataUrl
                            ? <a href={f.value.dataUrl} download={f.value.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'hsl(var(--color-blue))', fontSize: '0.85rem', fontWeight: 500, textDecoration: 'none' }}><Download size={13} /> {f.value.name}</a>
                            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)', fontSize: '0.85rem', fontWeight: 500 }}><FileIcon size={13} /> {f.value.name}</span>)
                        : (f.label === 'Status' && f.value)
                          ? (() => { const sc = warrantyStatusColor(f.value); return <span style={{ alignSelf: 'flex-start', fontSize: '0.72rem', fontWeight: 700, padding: '2px 9px', borderRadius: 4, color: sc ? `hsl(var(--color-${sc}))` : 'var(--text-secondary)', backgroundColor: sc ? `hsla(var(--color-${sc}), 0.12)` : 'var(--bg-secondary)' }}>{f.value}</span>; })()
                          : <span style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 500, wordBreak: 'break-word' }}>{f.value || '—'}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

      {editing && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>{editing.index === -1 ? `Add ${title}` : `Edit ${title}`}</h3>
              <button className="close-btn" onClick={close}><X size={18} /></button>
            </div>
            <form onSubmit={save}>
              <div className="form-grid">
                {editing.draft.fields.map((f, fi) => {
                  const isFile = fileFields.includes(f.label);
                  const selOpts = selectOptions[f.label];
                  return (
                    <div key={fi} className={(isFile || fullWidth.includes(f.label)) ? 'form-group form-group-full' : 'form-group'}>
                      <label>{f.label}{!isFile && <Req />}</label>
                      {selOpts ? (
                        <select className="form-input" value={typeof f.value === 'string' ? f.value : ''} onChange={e => setFieldVal(fi, e.target.value)} required>
                          <option value="">Select…</option>
                          {[...selOpts, ...(f.value && !selOpts.includes(f.value) ? [f.value] : [])].map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : isFile ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <input id={`file-${fi}`} type="file" style={{ display: 'none' }} onChange={e => setFile(fi, e.target.files[0])} />
                          <label htmlFor={`file-${fi}`} className="secondary-btn" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
                            <UploadCloud size={14} /> {isFileVal(f.value) ? 'Replace file' : 'Upload file'}
                          </label>
                          {isFileVal(f.value) && <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileIcon size={13} /> {f.value.name}</span>}
                        </div>
                      ) : (
                        <input className="form-input" type={isDateLabel(f.label) ? 'date' : 'text'} value={typeof f.value === 'string' ? f.value : ''} onChange={e => setFieldVal(fi, e.target.value)} required />
                      )}
                    </div>
                  );
                })}
                {editing.index !== -1 && <ReasonField value={editing.reason} onChange={r => setEditing(ed => ({ ...ed, reason: r }))} />}
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={close}>Cancel</button>
                <button type="submit" className="primary-btn">{editing.index === -1 ? 'Add' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// Timeline — editable: Add Timeline, per-row Edit/Remove, inline Status dropdown.
function TimelineSection({ list, onAdd, onUpdate, onStatus, onDelete }) {
  const rows = list || [];
  const [editing, setEditing] = useState(null); // { index, draft } (index === -1 => add)
  const [statusChange, setStatusChange] = useState(null); // { index, value } awaiting a reason
  const [statusReason, setStatusReason] = useState('');

  const openAdd  = () => setEditing({ index: -1, draft: mkTimeline() });
  const openEdit = (i) => setEditing({ index: i, draft: { status: 'Not Started', ...rows[i] } });
  const close    = () => setEditing(null);
  const setField = (k, v) => setEditing(ed => ({ ...ed, draft: { ...ed.draft, [k]: v } }));
  const save = (e) => { e.preventDefault(); editing.index === -1 ? onAdd(editing.draft) : onUpdate(editing.index, editing.draft, editing.reason); close(); };

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Entitlement, permitting and construction phases with live status</p>
        <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <Plus size={14} /> Add Timeline
        </button>
      </div>

      {rows.length === 0
        ? <EmptyState label="No timeline phases yet — click “Add Timeline”." />
        : (
          <div className="req-table-wrapper">
            <table className="req-table stack-table">
              <thead>
                <tr><th>Phase</th><th>Permit / Approval</th><th>Issuing Agency</th><th>When Required</th><th>Key Submittals</th><th>Review Time</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const { c } = statusStyle(r.status ?? r.notes);
                  const val = r.status ?? r.notes ?? 'Not Started';
                  const opts = STATUS_OPTIONS.includes(val) ? STATUS_OPTIONS : [val, ...STATUS_OPTIONS];
                  return (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.phase || '—'}</td>
                      <td data-th="Permit">{r.permit || '—'}</td>
                      <td data-th="Agency" style={{ color: 'var(--text-secondary)' }}>{r.agency || '—'}</td>
                      <td data-th="When required" style={{ fontSize: '0.82rem' }}>{r.whenRequired || '—'}</td>
                      <td data-th="Submittals" style={{ fontSize: '0.82rem' }}>{r.submittals || '—'}</td>
                      <td data-th="Review time" style={{ fontSize: '0.82rem' }}>{r.reviewTime || '—'}</td>
                      <td data-th="Status">
                        <select value={val} onChange={e => { if (e.target.value !== val) { setStatusChange({ index: i, value: e.target.value }); setStatusReason(''); } }} className="form-input"
                          style={{ padding: '3px 6px', fontSize: '0.75rem', fontWeight: 700, width: 'auto',
                            color: c ? `hsl(var(--color-${c}))` : 'var(--text-secondary)',
                            backgroundColor: c ? `hsla(var(--color-${c}), 0.1)` : 'var(--bg-secondary)' }}>
                          {opts.map(o => <option key={o} value={o} style={{ color: 'var(--text-primary)', backgroundColor: 'var(--bg-card)' }}>{o}</option>)}
                        </select>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="secondary-btn" title="Edit" onClick={() => openEdit(i)} style={{ padding: '4px 6px', marginRight: 4 }}><Pencil size={13} /></button>
                        <button className="secondary-btn" title="Remove" onClick={() => onDelete(i)} style={{ padding: '4px 6px' }}><Trash2 size={13} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      {editing && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>{editing.index === -1 ? 'Add Timeline Phase' : 'Edit Timeline Phase'}</h3>
              <button className="close-btn" onClick={close}><X size={18} /></button>
            </div>
            <form onSubmit={save}>
              <div className="form-grid">
                {TIMELINE_FIELDS.map(([lbl, key]) => (
                  <div key={key} className={key === 'submittals' ? 'form-group form-group-full' : 'form-group'}>
                    <label>{lbl}<Req /></label>
                    <input className="form-input" value={editing.draft[key] || ''} onChange={e => setField(key, e.target.value)} required />
                  </div>
                ))}
                <div className="form-group">
                  <label>Status<Req /></label>
                  <select className="form-input" value={editing.draft.status || 'Not Started'} onChange={e => setField('status', e.target.value)}>
                    {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                {editing.index !== -1 && <ReasonField value={editing.reason} onChange={r => setEditing(ed => ({ ...ed, reason: r }))} />}
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={close}>Cancel</button>
                <button type="submit" className="primary-btn">{editing.index === -1 ? 'Add' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {statusChange && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Reason for status change</h3>
              <button className="close-btn" onClick={() => setStatusChange(null)}><X size={18} /></button>
            </div>
            <form onSubmit={e => { e.preventDefault(); onStatus(statusChange.index, statusChange.value, statusReason); setStatusChange(null); setStatusReason(''); }}>
              <div style={{ padding: '4px 2px 10px' }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.83rem', marginBottom: 12 }}>
                  Status → <strong style={{ color: 'var(--text-primary)' }}>{statusChange.value}</strong> for <strong style={{ color: 'var(--text-primary)' }}>{rows[statusChange.index]?.phase || rows[statusChange.index]?.permit || 'phase'}</strong>
                </p>
                <div className="form-group form-group-full">
                  <label>Reason for change <span style={{ color: 'hsl(var(--color-red))' }}>*</span></label>
                  <input className="form-input" value={statusReason} onChange={e => setStatusReason(e.target.value)} required autoFocus placeholder="Why is the status changing?" />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setStatusChange(null)}>Cancel</button>
                <button type="submit" className="primary-btn">Update status</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// One plan/document card — big, full-width; info on the left, actions on the right.
function DocCard({ d, latest, onEdit }) {
  const btn = { padding: '7px 12px', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center', width: 130 };
  return (
    <div style={{ padding: 22, borderRadius: 10, backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', gap: 14, minWidth: 0, flex: 1 }}>
        <FileIcon size={26} style={{ color: 'hsl(var(--color-blue))', flexShrink: 0, marginTop: 2 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ color: 'var(--text-primary)', fontSize: '1.05rem', wordBreak: 'break-word', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{d.title || 'Untitled document'}</strong>
            {latest && <span style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', padding: '2px 8px', borderRadius: 4, color: 'hsl(var(--color-green))', backgroundColor: 'hsla(var(--color-green), 0.12)' }}>Latest</span>}
          </div>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'block', marginTop: 4 }}>{[d.category, d.version, d.date].filter(Boolean).join(' · ') || '—'}</span>
          {d.fileName && <div style={{ fontSize: '0.8rem', color: 'hsl(var(--color-blue))', marginTop: 8, wordBreak: 'break-word' }}>📎 {d.fileName} {d.fileSize ? `(${fmtBytes(d.fileSize)})` : ''}</div>}
          {d.notes && (
            <div style={{ fontSize: '0.85rem', marginTop: 10, wordBreak: 'break-word', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '8px 10px' }}>
              <strong style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em', display: 'block', marginBottom: 2 }}>Note</strong>
              <span style={{ color: 'var(--text-primary)' }}>{d.notes}</span>
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
        {d.fileKey && <button className="secondary-btn" onClick={() => downloadIdbFile(d.fileKey, d.fileName)} style={btn}><Download size={14} /> Download</button>}
        {d.location && <a href={d.location} target="_blank" rel="noopener noreferrer" className="secondary-btn" style={btn}><ExternalLink size={14} /> Open Link</a>}
        <button className="secondary-btn" onClick={onEdit} style={btn}><Pencil size={14} /> Edit</button>
      </div>
    </div>
  );
}

// Plans & Docs — category-grouped cards with multi-select filter; full CRUD via modal.
function DocsSection({ list, onAdd, onUpdate, onDelete }) {
  const docs = list || [];
  const [editing, setEditing] = useState(null); // { index, draft }  (index === -1 => adding new)
  const [filter, setFilter] = useState([]);     // selected categories ([] = show all)
  const [filterOpen, setFilterOpen] = useState(false);

  const isCustomCat = (c) => !!(c && !DOC_CATEGORY_OPTIONS.includes(c));
  const openAdd  = () => setEditing({ index: -1, draft: mkDoc(), categoryOther: false });
  const openEdit = (i) => setEditing({ index: i, draft: { ...docs[i] }, categoryOther: isCustomCat(docs[i].category) });
  const close    = () => setEditing(null);
  const setField = (k, v) => setEditing(ed => ({ ...ed, draft: { ...ed.draft, [k]: v } }));
  const setCategory = (v) => v === 'Other'
    ? setEditing(ed => ({ ...ed, categoryOther: true, draft: { ...ed.draft, category: '' } }))
    : setEditing(ed => ({ ...ed, categoryOther: false, draft: { ...ed.draft, category: v } }));
  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const key = `docfile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try { await idbPut(key, f); } catch { /* ignore */ }
    setEditing(ed => ({ ...ed, draft: { ...ed.draft, fileName: f.name, fileSize: f.size, fileKey: key } }));
  };
  const save = (e) => {
    e.preventDefault();
    if (editing.index === -1) onAdd(editing.draft);
    else onUpdate(editing.index, editing.draft, editing.reason);
    close();
  };

  const catOf = (d) => d.category || 'Uncategorized';
  const indexed = docs.map((d, i) => ({ d, i }));
  const cats = [...new Set(indexed.map(x => catOf(x.d)))];
  const visible = filter.length ? indexed.filter(x => filter.includes(catOf(x.d))) : indexed;
  const groups = {};
  visible.forEach(x => { (groups[catOf(x.d)] ||= []).push(x); });
  Object.values(groups).forEach(arr => arr.sort((a, b) => (b.d.updatedAt || 0) - (a.d.updatedAt || 0))); // newest (auto-Latest) first
  const toggleFilter = (c) => setFilter(f => f.includes(c) ? f.filter(x => x !== c) : [...f, c]);

  return (
    <>
      <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Verified blueprints, engineering specs, and closeout documents</p>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '3px 10px', borderRadius: 20, color: 'hsl(var(--color-blue))', backgroundColor: 'hsla(var(--color-blue), 0.1)' }}>{docs.length} plan{docs.length === 1 ? '' : 's'} total</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {/* Multi-select category dropdown */}
          {docs.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button type="button" className="secondary-btn" onClick={() => setFilterOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Filter size={14} /> {filter.length ? `${filter.length} selected` : 'All categories'} <ChevronDown size={14} />
              </button>
              {filterOpen && (
                <>
                  <div onClick={() => setFilterOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 41, backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: 6, minWidth: 220, maxHeight: 300, overflowY: 'auto' }}>
                    {cats.map(c => (
                      <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', cursor: 'pointer', fontSize: '0.83rem', borderRadius: 4 }}>
                        <input type="checkbox" checked={filter.includes(c)} onChange={() => toggleFilter(c)} />
                        <span style={{ flex: 1 }}>{c}</span>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{indexed.filter(x => catOf(x.d) === c).length}</span>
                      </label>
                    ))}
                    {filter.length > 0 && <button type="button" onClick={() => setFilter([])} className="secondary-btn" style={{ width: '100%', marginTop: 4, fontSize: '0.76rem' }}>Clear all</button>}
                  </div>
                </>
              )}
            </div>
          )}
          <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> Add Plan / Document
          </button>
        </div>
      </div>

      {docs.length === 0
        ? <EmptyState label="No plans or documents yet — click “Add Plan / Document”." />
        : (
          // Full-width category sections stacked vertically, separated by a partition.
          // When a filter is applied, sections follow the order you selected them.
          <div>
            {(filter.length ? filter : cats).filter(c => groups[c]).map((cat, idx) => (
              <div key={cat} style={{ paddingTop: idx === 0 ? 0 : 22, marginTop: idx === 0 ? 0 : 22, borderTop: idx === 0 ? 'none' : '2px solid var(--border-color)' }}>
                <h4 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1rem', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
                  {cat} <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 9px', borderRadius: 20, color: 'hsl(var(--color-blue))', backgroundColor: 'hsla(var(--color-blue), 0.12)' }}>{groups[cat].length}</span>
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {groups[cat].map(({ d, i }, idx) => <DocCard key={i} d={d} latest={idx === 0 && (d.updatedAt || 0) > 0} onEdit={() => openEdit(i)} />)}
                </div>
              </div>
            ))}
          </div>
        )}

      {editing && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>{editing.index === -1 ? 'Add Plan / Document' : 'Edit Plan / Document'}</h3>
              <button className="close-btn" onClick={close}><X size={18} /></button>
            </div>
            <form onSubmit={save}>
              <div className="form-grid">
                {DOC_FIELDS.map(([lbl, key]) => {
                  if (key === 'category') {
                    const otherActive = editing.categoryOther;
                    const selVal = otherActive ? 'Other' : (DOC_CATEGORY_OPTIONS.includes(editing.draft.category) ? editing.draft.category : '');
                    return (
                      <div key={key} className="form-group">
                        <label>{lbl}<Req /></label>
                        <select className="form-input" value={selVal} onChange={e => setCategory(e.target.value)} required>
                          <option value="">Select category…</option>
                          {DOC_CATEGORY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                          <option value="Other">Other (type manually)</option>
                        </select>
                        {otherActive && (
                          <input className="form-input" style={{ marginTop: 8 }} placeholder="Enter category"
                            value={editing.draft.category || ''} onChange={e => setField('category', e.target.value)} />
                        )}
                      </div>
                    );
                  }
                  if (key === 'version') {
                    return (
                      <div key={key} className="form-group">
                        <label>{lbl}<Req /></label>
                        <input className="form-input" placeholder="e.g. V1, V2" required
                          value={editing.draft.version || ''}
                          onChange={e => { let v = e.target.value; if (v && !/^V/i.test(v)) v = 'V' + v; v = v.replace(/^[Vv]/, 'V'); setField('version', v); }} />
                      </div>
                    );
                  }
                  return (
                    <div key={key} className={key === 'title' || key === 'location' || key === 'notes' ? 'form-group form-group-full' : 'form-group'}>
                      <label>{lbl}{!['location', 'notes'].includes(key) && <Req />}</label>
                      <input className="form-input" type={isDateLabel(lbl) ? 'date' : 'text'} value={editing.draft[key] || ''} onChange={e => setField(key, e.target.value)}
                        required={!['location', 'notes'].includes(key)} placeholder={key === 'location' ? 'Egnyte path or URL' : ''} />
                    </div>
                  );
                })}
                {editing.index !== -1 && <ReasonField value={editing.reason} onChange={r => setEditing(ed => ({ ...ed, reason: r }))} />}
                <div className="form-group form-group-full">
                  <label>Upload file (any type, no size limit)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <input id="doc-upload" type="file" style={{ display: 'none' }} onChange={onFile} />
                    <label htmlFor="doc-upload" className="secondary-btn" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0 }}>
                      <UploadCloud size={14} /> {editing.draft.fileKey ? 'Replace file' : 'Upload file'}
                    </label>
                    {editing.draft.fileKey && (
                      <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <FileIcon size={13} /> {editing.draft.fileName} {editing.draft.fileSize ? `(${fmtBytes(editing.draft.fileSize)})` : ''}
                        <button type="button" className="secondary-btn" onClick={() => setEditing(ed => ({ ...ed, draft: { ...ed.draft, fileName: '', fileSize: 0, fileKey: '' } }))} style={{ padding: '2px 6px', fontSize: '0.7rem' }}>Clear</button>
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={close}>Cancel</button>
                <button type="submit" className="primary-btn">{editing.index === -1 ? 'Add' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// Permit — editable table (Development "Permit Status" style) with full Permit Matrix fields.
function PermitSection({ list, onAdd, onUpdate, onStatus, onDelete }) {
  const rows = list || [];
  const [editing, setEditing] = useState(null); // { index, draft } (index === -1 => add)
  const [statusChange, setStatusChange] = useState(null); // { index, value } awaiting a reason
  const [statusReason, setStatusReason] = useState('');

  const isCustomType = (t) => !!(t && !PERMIT_TYPE_OPTIONS.includes(t));
  const openAdd  = () => setEditing({ index: -1, draft: mkPermit(), typeOther: false });
  const openEdit = (i) => setEditing({ index: i, draft: { ...mkPermit(), ...rows[i] }, typeOther: isCustomType(rows[i].type) });
  const close    = () => setEditing(null);
  const setField = (k, v) => setEditing(ed => ({ ...ed, draft: { ...ed.draft, [k]: v } }));
  const setType  = (v) => v === 'Other'
    ? setEditing(ed => ({ ...ed, typeOther: true, draft: { ...ed.draft, type: '' } }))
    : setEditing(ed => ({ ...ed, typeOther: false, draft: { ...ed.draft, type: v } }));
  const save = (e) => { e.preventDefault(); editing.index === -1 ? onAdd(editing.draft) : onUpdate(editing.index, editing.draft, editing.reason); close(); };

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Zoning & construction permit tracker — submittals, agencies, and approval status</p>
        <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <Plus size={14} /> Add Permit
        </button>
      </div>

      {rows.length === 0
        ? <EmptyState label="No permits yet — click “Add Permit”." />
        : (
          <div className="req-table-wrapper">
            <table className="req-table stack-table">
              <thead>
                <tr><th>Phase</th><th>Permit / Approval Type</th><th>Permit No</th><th>Jurisdiction / Agency</th><th>Expiration</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const { c } = permitStatusStyle(r.status);
                  const val = r.status || 'Not Submitted';
                  const opts = PERMIT_STATUS_OPTIONS.includes(val) ? PERMIT_STATUS_OPTIONS : [val, ...PERMIT_STATUS_OPTIONS];
                  return (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.phase || '—'}</td>
                      <td data-th="Type">{r.type || '—'}</td>
                      <td data-th="Permit #" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{r.permitNo || '—'}</td>
                      <td data-th="Agency" style={{ color: 'var(--text-secondary)' }}>{r.agency || '—'}</td>
                      <td data-th="Expiration" style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: r.expiration ? 'hsl(var(--color-red))' : 'var(--text-secondary)', fontWeight: r.expiration ? 600 : 400 }}>{r.expiration || '—'}</td>
                      <td data-th="Status">
                        <select value={val} onChange={e => { if (e.target.value !== val) { setStatusChange({ index: i, value: e.target.value }); setStatusReason(''); } }} className="form-input"
                          style={{ padding: '3px 6px', fontSize: '0.75rem', fontWeight: 700, width: 'auto',
                            color: c ? `hsl(var(--color-${c}))` : 'var(--text-secondary)',
                            backgroundColor: c ? `hsla(var(--color-${c}), 0.1)` : 'var(--bg-secondary)' }}>
                          {opts.map(o => <option key={o} value={o} style={{ color: 'var(--text-primary)', backgroundColor: 'var(--bg-card)' }}>{o}</option>)}
                        </select>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="secondary-btn" title="Edit" onClick={() => openEdit(i)} style={{ padding: '4px 6px', marginRight: 4 }}><Pencil size={13} /></button>
                        <button className="secondary-btn" title="Remove" onClick={() => onDelete(i)} style={{ padding: '4px 6px' }}><Trash2 size={13} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      {editing && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>{editing.index === -1 ? 'Add Permit' : 'Edit Permit'}</h3>
              <button className="close-btn" onClick={close}><X size={18} /></button>
            </div>
            <form onSubmit={save}>
              <div className="form-grid">
                {PERMIT_FIELDS.map(([lbl, key]) => {
                  if (key === 'type') {
                    const otherActive = editing.typeOther;
                    const selVal = otherActive ? 'Other' : (PERMIT_TYPE_OPTIONS.includes(editing.draft.type) ? editing.draft.type : '');
                    return (
                      <div key={key} className="form-group form-group-full">
                        <label>{lbl}<Req /></label>
                        <select className="form-input" value={selVal} onChange={e => setType(e.target.value)} required>
                          <option value="">Select permit type…</option>
                          {PERMIT_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                          <option value="Other">Other (type manually)</option>
                        </select>
                        {otherActive && (
                          <input className="form-input" style={{ marginTop: 8 }} placeholder="Enter permit / approval name"
                            value={editing.draft.type || ''} onChange={e => setField('type', e.target.value)} required />
                        )}
                      </div>
                    );
                  }
                  if (key === 'issuanceDate') {
                    const enabled = editing.draft.status === 'Issued';
                    return (
                      <div key={key} className="form-group">
                        <label>{lbl}{enabled && <Req />}</label>
                        <input className="form-input" type="date" disabled={!enabled} required={enabled}
                          value={enabled ? (editing.draft[key] || '') : ''} onChange={e => setField(key, e.target.value)}
                          style={!enabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} />
                        {!enabled && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 2 }}>Set Permit Status to “Issued” to enable</span>}
                      </div>
                    );
                  }
                  return (
                    <div key={key} className={key === 'notes' ? 'form-group form-group-full' : 'form-group'}>
                      <label>{lbl}{!['resubmittal1', 'resubmittal2', 'resubmittal3', 'notes'].includes(key) && <Req />}</label>
                      <input className="form-input" type={isDateLabel(lbl) ? 'date' : 'text'} value={editing.draft[key] || ''} onChange={e => setField(key, e.target.value)}
                        required={!['resubmittal1', 'resubmittal2', 'resubmittal3', 'notes'].includes(key)} />
                    </div>
                  );
                })}
                <div className="form-group">
                  <label>Permit Status<Req /></label>
                  <select className="form-input" value={editing.draft.status || 'Not Submitted'}
                    onChange={e => { const v = e.target.value; setEditing(ed => ({ ...ed, draft: { ...ed.draft, status: v, ...(v !== 'Issued' ? { issuanceDate: '' } : {}) } })); }}>
                    {PERMIT_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                {editing.index !== -1 && <ReasonField value={editing.reason} onChange={r => setEditing(ed => ({ ...ed, reason: r }))} />}
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={close}>Cancel</button>
                <button type="submit" className="primary-btn">{editing.index === -1 ? 'Add' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {statusChange && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Reason for status change</h3>
              <button className="close-btn" onClick={() => setStatusChange(null)}><X size={18} /></button>
            </div>
            <form onSubmit={e => { e.preventDefault(); onStatus(statusChange.index, statusChange.value, statusReason); setStatusChange(null); setStatusReason(''); }}>
              <div style={{ padding: '4px 2px 10px' }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.83rem', marginBottom: 12 }}>
                  Status → <strong style={{ color: 'var(--text-primary)' }}>{statusChange.value}</strong> for <strong style={{ color: 'var(--text-primary)' }}>{rows[statusChange.index]?.type || rows[statusChange.index]?.phase || 'permit'}</strong>
                </p>
                <div className="form-group form-group-full">
                  <label>Reason for change <span style={{ color: 'hsl(var(--color-red))' }}>*</span></label>
                  <input className="form-input" value={statusReason} onChange={e => setStatusReason(e.target.value)} required autoFocus placeholder="Why is the status changing?" />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setStatusChange(null)}>Cancel</button>
                <button type="submit" className="primary-btn">Update status</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// Utilities & Vendors — self-contained CRUD (always-on Add, per-card Edit/Remove via modal).
function UtilitiesSection({ list, onAdd, onUpdate, onDelete }) {
  const items = list || [];
  const [editing, setEditing] = useState(null); // { index, draft } (index === -1 => add)

  const openAdd  = () => setEditing({ index: -1, draft: mkUtility() });
  const openEdit = (i) => setEditing({ index: i, draft: structuredClone(items[i]) });
  const close    = () => setEditing(null);
  const setName  = (v) => setEditing(ed => ({ ...ed, draft: { ...ed.draft, name: v } }));
  const setFieldVal = (fi, v) => setEditing(ed => { const d = structuredClone(ed.draft); d.fields[fi].value = v; return { ...ed, draft: d }; });
  const save = (e) => { e.preventDefault(); editing.index === -1 ? onAdd(editing.draft) : onUpdate(editing.index, editing.draft, editing.reason); close(); };

  return (
    <>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Service providers and vendors — agencies, account numbers, and contacts</p>
        <button className="primary-btn" onClick={openAdd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <Plus size={14} /> Add Utility
        </button>
      </div>

      {items.length === 0
        ? <EmptyState label="No utilities yet — click “Add Utility”." />
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {items.map((u, i) => (
              <div key={i} style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12, borderBottom: '1px dashed var(--border-color)', paddingBottom: 8 }}>
                  <strong style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{u.name || `Utility ${i + 1}`}</strong>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button className="secondary-btn" title="Edit" onClick={() => openEdit(i)} style={{ padding: '4px 6px' }}><Pencil size={13} /></button>
                    <button className="secondary-btn" title="Remove" onClick={() => onDelete(i)} style={{ padding: '4px 6px' }}><Trash2 size={13} /></button>
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 10 }}>
                  {(u.fields || []).map((f, fi) => (
                    <div key={fi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.02em' }}>{f.label}</span>
                      <span style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 500, wordBreak: 'break-word' }}>{f.value || '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

      {editing && (
        <div className="modal-overlay" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>{editing.index === -1 ? 'Add Utility / Vendor' : 'Edit Utility / Vendor'}</h3>
              <button className="close-btn" onClick={close}><X size={18} /></button>
            </div>
            <form onSubmit={save}>
              <div className="form-grid">
                <div className="form-group form-group-full">
                  <label>Utility / Service Name<Req /></label>
                  <input className="form-input" value={editing.draft.name || ''} onChange={e => setName(e.target.value)} required placeholder="e.g. Electric Utility" />
                </div>
                {editing.draft.fields.map((f, fi) => (
                  <div key={fi} className={f.label === 'Notes' ? 'form-group form-group-full' : 'form-group'}>
                    <label>{f.label}<Req /></label>
                    <input className="form-input" value={f.value || ''} onChange={e => setFieldVal(fi, e.target.value)} required />
                  </div>
                ))}
                {editing.index !== -1 && <ReasonField value={editing.reason} onChange={r => setEditing(ed => ({ ...ed, reason: r }))} />}
              </div>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={close}>Cancel</button>
                <button type="submit" className="primary-btn">{editing.index === -1 ? 'Add' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

// Activity log modal — property · tab · field · change, newest first, with a date filter.
function LogsModal({ logs, title, onClose }) {
  const all = logs || [];
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const items = all.filter(l => { const d = (l.ts || '').slice(0, 10); return (!from || d >= from) && (!to || d <= to); });
  const color = (a) => a === 'added' ? 'green' : a === 'removed' ? 'red' : a === 'status' ? 'blue' : 'gold';
  const actText = (a) => a === 'added' ? 'Added' : a === 'removed' ? 'Removed' : a === 'status' ? 'Status changed' : a === 'edited' ? 'Edited' : 'Updated';
  const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
  const dayKey = (ts) => (ts || '').slice(0, 10);
  const dayLabel = (ts) => {
    const today = new Date(); const y = new Date(today); y.setDate(today.getDate() - 1);
    const k = dayKey(ts);
    if (k === dayKey(today.toISOString())) return 'Today';
    if (k === dayKey(y.toISOString())) return 'Yesterday';
    try { return new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); } catch { return k; }
  };
  const initials = (name) => (name || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase() || '?';
  // Group entries by day (items are already newest-first).
  const groups = [];
  items.forEach(l => { const k = dayKey(l.ts); let g = groups.find(x => x.k === k); if (!g) { g = { k, ts: l.ts, list: [] }; groups.push(g); } g.list.push(l); });
  const dinp = { padding: '7px 12px', width: 'auto', fontSize: '0.8rem' };
  return (
    <div className="modal-overlay" style={{ display: 'flex' }}>
      <div className="modal-content" style={{ maxWidth: 700 }}>
        <div className="modal-header">
          <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><History size={18} /> Activity Log — {title}</h3>
          <button className="close-btn" onClick={onClose}><X size={18} /></button>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '14px 24px', marginBottom: 4, borderBottom: '1px solid var(--border-color)' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Filter size={13} /> Date:</span>
          <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>From <input type="date" className="form-input" value={from} onChange={e => setFrom(e.target.value)} style={dinp} /></label>
          <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>To <input type="date" className="form-input" value={to} onChange={e => setTo(e.target.value)} style={dinp} /></label>
          {(from || to) && <button className="secondary-btn" onClick={() => { setFrom(''); setTo(''); }} style={{ padding: '4px 10px', fontSize: '0.76rem' }}>Clear</button>}
          <span style={{ marginLeft: 'auto', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{items.length} entr{items.length === 1 ? 'y' : 'ies'}</span>
        </div>

        <div style={{ padding: '6px 24px 20px', maxHeight: '58vh', overflowY: 'auto' }}>
          {items.length === 0
            ? <EmptyState label={all.length ? 'No activity in this date range.' : 'No activity yet — edits, adds and deletes will show here.'} />
            : groups.map(g => (
              <div key={g.k} style={{ marginBottom: 14 }}>
                <div style={{ position: 'sticky', top: -6, zIndex: 1, padding: '6px 0 8px', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)', backgroundColor: 'var(--card)' }}>{dayLabel(g.ts)}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {g.list.map((l, i) => {
                    const c = color(l.action);
                    const changes = l.changes || (l.summary ? [l.summary] : []); // backward-compat
                    return (
                      <div key={i} style={{ display: 'flex', gap: 11, padding: '12px 13px', borderRadius: 10, border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-secondary)' }}>
                        <span style={{ flexShrink: 0, width: 9, height: 9, marginTop: 5, borderRadius: '50%', backgroundColor: `hsl(var(--color-${c}))`, boxShadow: `0 0 0 3px hsla(var(--color-${c}), 0.15)` }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: changes.length || l.reason ? 7 : 0 }}>
                            <span style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap', color: `hsl(var(--color-${c}))`, backgroundColor: `hsla(var(--color-${c}), 0.12)` }}>{actText(l.action)}</span>
                            <span style={{ fontSize: '0.7rem', fontWeight: 600, padding: '2px 7px', borderRadius: 4, color: 'hsl(var(--color-blue))', backgroundColor: 'hsla(var(--color-blue), 0.1)' }}>{l.section}</span>
                            {l.item && <strong style={{ fontSize: '0.875rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.item}</strong>}
                            <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmtTime(l.ts)}</span>
                          </div>
                          {changes.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 10px', borderRadius: 7, backgroundColor: 'var(--bg-primary)', border: '1px solid var(--border-color)' }}>
                              {changes.map((ch, ci) => (
                                <div key={ci} style={{ fontSize: '0.8rem', color: 'var(--text-primary)', wordBreak: 'break-word', lineHeight: 1.5 }}>{ch}</div>
                              ))}
                            </div>
                          )}
                          {l.reason && (
                            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 6, wordBreak: 'break-word' }}>
                              <span style={{ fontWeight: 600 }}>Reason:</span> <span style={{ fontStyle: 'italic' }}>{l.reason}</span>
                            </div>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                            <span title={l.user} style={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', fontWeight: 700, color: 'hsl(var(--color-purple))', backgroundColor: 'hsla(var(--color-purple), 0.14)' }}>{initials(l.user)}</span>
                            <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.user}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ label }) {
  return (
    <div style={{ padding: '44px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 44, height: 44, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
        <FileText size={20} style={{ color: 'var(--text-muted)' }} />
      </div>
      <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', maxWidth: 360 }}>{label}</span>
    </div>
  );
}
