// Registry of every "collection" record type in the app (maintenance logs, service records,
// warranties, inspections, documents, AHJ contacts, utilities, vendors, etc). Each entry drives:
//   - the Add/Edit modal's form fields
//   - the list-view table's columns
//   - default sort order
//   - the summary strip shown above the list (e.g. "Records / Last Service / Total Spend")
//
// All of these collections are flat arrays in the data store, each record carrying a
// `propertyId` foreign key that points at ANY asset's id — property, vehicle, or equipment.
// (The `propertyId` name is a holdover from the module's property-first origin.)

import { formatDate, formatMoney, formatNumber, daysUntil } from './format.js';
import { StatusBadge, expirationStatus, dueDateStatus, renewalCellFromDate } from '../components/shared/StatusBadge.jsx';

const byDateDesc = (a, b) => String(b.date || '').localeCompare(String(a.date || ''));
const totalSpend = (rows) => rows.reduce((sum, r) => {
  const n = parseFloat(String(r.cost || '').replace(/[^0-9.]/g, ''));
  return sum + (isFinite(n) ? n : 0);
}, 0);

const statusChip = (status) => {
  if (!status) return '—';
  const tone = status === 'Completed' ? 'green' : status === 'Scheduled' ? 'blue' : status === 'In Progress' ? 'gold' : status === 'Needs Attention' ? 'red' : 'blue';
  return <StatusBadge tone={tone}>{status}</StatusBadge>;
};

export const RECORD_TYPES = {
  // Property maintenance log — one-line "Quick add a maintenance note" bar feeds this directly.
  maintenance: {
    title: 'Maintenance Record',
    plural: 'Maintenance',
    empty: 'No maintenance records yet — log repairs, inspections and preventive work, or upload an invoice or report.',
    fields: [
      { k: 'date', label: 'Service Date', type: 'date', req: true },
      { k: 'system', label: 'System / Area', type: 'select', req: true, options: ['HVAC', 'Roofing', 'Plumbing', 'Electrical', 'Elevator', 'Fire / Life Safety', 'Landscaping / Grounds', 'Pest Control', 'Painting', 'Parking / Pavement', 'Structural', 'Appliance', 'Security / Access', 'General Repair', 'Preventive Maintenance', 'Inspection', 'Other'] },
      { k: 'description', label: 'Work Performed', full: true },
      { k: 'vendor', label: 'Contractor / Vendor' },
      { k: 'cost', label: 'Cost' },
      { k: 'status', label: 'Status', type: 'select', options: ['Completed', 'Scheduled', 'In Progress', 'Needs Attention'] },
      { k: 'nextDue', label: 'Next Service Due', type: 'date' },
      { k: 'docFile', label: 'Invoice / Report (Upload)', type: 'file', nameKey: 'docFileName', full: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    // Quick-add config (single-input fast entry bar): the field it fills, extra defaults, placeholder + button text.
    quickAdd: { k: 'description', extra: { status: 'Completed' }, placeholder: 'Quick add a maintenance note — e.g. Replaced HVAC filter', button: 'Add note' },
    cols: [
      { label: 'Date', mono: (r) => r.date ? formatDate(r.date) : '—' },
      { label: 'Work', main: (r) => r.system || r.description || '—', sub: (r) => r.system ? (r.description || r.vendor) : r.vendor },
      { label: 'Vendor', plain: (r) => r.vendor || '—' },
      { label: 'Cost', plain: (r) => r.cost || '—' },
      { label: 'Status', chip: (r) => statusChip(r.status) },
      { label: 'Next Due', mono: (r) => r.nextDue ? formatDate(r.nextDue) : '—' },
      { label: 'Doc', plain: (r) => r.docFileName || (r.docFile ? 'Attached' : '—') },
    ],
    sort: byDateDesc,
    summary: (rows) => {
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      const last = dates[dates.length - 1];
      const total = totalSpend(rows);
      return [['Records', String(rows.length)], ['Last Service', last ? formatDate(last) : '—'], ['Total Spend', total > 0 ? formatMoney(total) : '—']];
    },
  },

  // Vehicle/equipment service log — same "quick add" pattern, plus a "Recommended Maintenance"
  // sub-tab (see RecommendedMaintenance.jsx) showing the researched factory schedule.
  vservice: {
    title: 'Service Record',
    plural: 'Service & Maintenance',
    empty: "No service records yet — log maintenance as it's performed, or upload an invoice.",
    fields: [
      { k: 'date', label: 'Service Date', type: 'date', req: true },
      { k: 'type', label: 'Service Type', type: 'select', req: true, options: ['Oil Change', 'Tire Rotation', 'Brakes', 'Battery', 'Fluids', 'Inspection', 'Scheduled Maintenance', 'Repair', 'Recall', 'Other'] },
      { k: 'mileage', label: 'Odometer (mi)', type: 'number' },
      { k: 'vendor', label: 'Shop / Vendor' },
      { k: 'cost', label: 'Cost' },
      { k: 'nextDue', label: 'Next Service Due', type: 'date' },
      { k: 'docFile', label: 'Invoice / Receipt (Upload)', type: 'file', nameKey: 'docFileName', full: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    quickAdd: { k: 'type', extra: {}, placeholder: 'Quick add a service — e.g. Oil change, brake job', button: 'Add service' },
    cols: [
      { label: 'Date', mono: (r) => r.date ? formatDate(r.date) : '—' },
      { label: 'Service', main: (r) => r.type || '—', sub: (r) => {
          const notes = (r.notes || '').trim();
          const truncated = notes.length > 100 ? notes.slice(0, 100) + '…' : notes;
          return [r.vendor, truncated].filter(Boolean).join(' — ');
        } },
      { label: 'Odometer', plain: (r) => r.mileage ? formatNumber(r.mileage) + ' mi' : '—' },
      { label: 'Cost', plain: (r) => r.cost || '—' },
      { label: 'Next Due', mono: (r) => r.nextDue ? formatDate(r.nextDue) : '—' },
      { label: 'Doc', plain: (r) => r.docFileName || (r.docFile ? 'Attached' : '—') },
    ],
    sort: byDateDesc,
    summary: (rows) => {
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      const last = dates[dates.length - 1];
      const total = totalSpend(rows);
      return [['Records', String(rows.length)], ['Last Service', last ? formatDate(last) : '—'], ['Total Spend', total > 0 ? formatMoney(total) : '—']];
    },
  },

  odometer: {
    title: 'Odometer Reading',
    plural: 'Odometer Log',
    empty: 'No odometer readings yet. A reading is required once a year per vehicle.',
    fields: [
      { k: 'date', label: 'Reading Date', type: 'date', req: true },
      { k: 'mileage', label: 'Odometer (mi)', type: 'number', req: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Date', mono: (r) => r.date ? formatDate(r.date) : '—' },
      { label: 'Odometer', main: (r) => r.mileage ? formatNumber(r.mileage) + ' mi' : '—' },
      { label: 'Notes', plain: (r) => r.notes || '—' },
    ],
    sort: byDateDesc,
    summary: (rows) => {
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      const last = dates[dates.length - 1];
      const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 864e5) : null;
      const status = days == null ? 'No reading on file' : days > 365 ? `Overdue (${days}d)` : `Current (${days}d ago)`;
      return [['Readings', String(rows.length)], ['Last Reading', last ? formatDate(last) : '—'], ['Annual Status', status]];
    },
  },

  vdocs: {
    title: 'Document',
    plural: 'Documents',
    empty: 'No documents yet — upload the registration, title, bill of sale, insurance, loan, and warranty documents.',
    fields: [
      { k: 'category', label: 'Document Type', type: 'select', options: ['Registration', 'Title', 'Bill of Sale / Purchase', 'Insurance Card', 'Loan / Financing', 'Warranty', 'Inspection / Emissions', 'Service Record', 'Other'] },
      { k: 'egnyteDest', label: 'Egnyte Destination', type: 'select', options: ['Registration & Title', 'Insurance', 'Purchase / Financing', 'Service & Maintenance', 'Warranty', 'Other'] },
      { k: 'title', label: 'Title', req: true },
      { k: 'dateOf', label: 'Document Date', type: 'date' },
      { k: 'location', label: 'Location (Egnyte Path)', full: true },
      { k: 'docFile', label: 'File (Upload)', type: 'file', nameKey: 'docFileName', full: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Type', main: (r) => r.category || 'Document', sub: (r) => r.title },
      { label: 'Date', mono: (r) => r.dateOf ? formatDate(r.dateOf) : '—' },
      { label: 'Egnyte', plain: (r) => r.egnyteDest || '—' },
      { label: 'File', plain: (r) => r.docFileName || (r.docFile ? 'Attached' : r.location || '—') },
    ],
    sort: (a, b) => String(b.dateOf || '').localeCompare(String(a.dateOf || '')),
  },

  warranties: {
    title: 'Warranty',
    plural: 'Warranties',
    empty: 'No warranties on file. Add subcontractor and equipment warranties from the closeout package.',
    fields: [
      { k: 'kind', label: 'Type', type: 'select', options: ['Contractor', 'Subcontractor', 'Manufacturer', 'Other'] },
      { k: 'scope', label: 'Scope / Item Covered', req: true },
      { k: 'party', label: 'Name', req: true },
      { k: 'contactName', label: 'Contact Name' },
      { k: 'phone', label: 'Contact Phone' },
      { k: 'email', label: 'Contact Email' },
      { k: 'startDate', label: 'Start Date', type: 'date' },
      { k: 'expiration', label: 'Expiration', type: 'date', req: true },
      { k: 'termMonths', label: 'Term (Months, Auto)', type: 'number', readOnly: true },
      { k: 'docRef', label: 'Document Location (Egnyte Path)', full: true },
      { k: 'docFile', label: 'Warranty Document (Upload)', type: 'file', nameKey: 'docFileName', full: true },
      { k: 'coverage', label: 'Coverage Summary', type: 'textarea', full: true, req: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    // termMonths is auto-derived from startDate/expiration on save — see ../lib/warrantyTerm.js
    cols: [
      { label: 'Scope', main: (r) => r.scope, sub: (r) => r.kind },
      { label: 'Party', main: (r) => r.party, sub: (r) => [r.contactName, r.phone].filter(Boolean).join(' · ') },
      { label: 'Expires', mono: (r) => formatDate(r.expiration) },
      { label: 'Status', chip: (r) => expirationStatus(daysUntil(r.expiration)) },
    ],
    sort: (a, b) => (a.expiration || '9999') < (b.expiration || '9999') ? -1 : 1,
    summary: (rows) => [
      ['Active', rows.filter((r) => daysUntil(r.expiration) > 90).length],
      ['Expiring ≤ 90d', rows.filter((r) => { const d = daysUntil(r.expiration); return d != null && d >= 0 && d <= 90; }).length],
      ['Expired', rows.filter((r) => daysUntil(r.expiration) != null && daysUntil(r.expiration) < 0).length],
    ],
  },

  inspections: {
    title: 'Inspection',
    plural: 'Inspections',
    empty: 'No inspections scheduled. Add annual and periodic inspections — fire, elevator, backflow, roof PM, stormwater.',
    fields: [
      { k: 'type', label: 'Inspection Type', req: true, full: true },
      { k: 'frequency', label: 'Frequency', type: 'select', options: ['Monthly', 'Quarterly', 'Semi-annual', 'Annual', 'Every 3 years', 'Every 5 years', 'One-time'] },
      { k: 'ahjRequired', label: 'AHJ Required', type: 'select', options: ['Yes', 'No'] },
      { k: 'vendor', label: 'Vendor' },
      { k: 'vendorPhone', label: 'Vendor Phone' },
      { k: 'lastCompleted', label: 'Last Completed', type: 'date' },
      { k: 'nextDue', label: 'Next Due', type: 'date', req: true },
      { k: 'cost', label: 'Cost ($)', type: 'number' },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Inspection', main: (r) => r.type, sub: (r) => r.frequency + (r.ahjRequired === 'Yes' ? ' · AHJ required' : '') },
      { label: 'Vendor', main: (r) => r.vendor || '—', sub: (r) => r.vendorPhone || '' },
      { label: 'Last', mono: (r) => formatDate(r.lastCompleted) },
      { label: 'Next Due', mono: (r) => formatDate(r.nextDue) },
      { label: 'Status', chip: (r) => dueDateStatus(daysUntil(r.nextDue)) },
    ],
    sort: (a, b) => (a.nextDue || '9999') < (b.nextDue || '9999') ? -1 : 1,
    summary: (rows) => [
      ['Overdue', rows.filter((r) => daysUntil(r.nextDue) != null && daysUntil(r.nextDue) < 0).length],
      ['Due ≤ 30d', rows.filter((r) => { const d = daysUntil(r.nextDue); return d != null && d >= 0 && d <= 30; }).length],
      ['Current', rows.filter((r) => daysUntil(r.nextDue) == null || daysUntil(r.nextDue) > 30).length],
    ],
  },

  documents: {
    title: 'Document',
    plural: 'Plans & Documents',
    empty: 'No documents indexed. Register as-builts, CO, permits, surveys, and O&M manuals with their Egnyte locations.',
    fields: [
      { k: 'category', label: 'Category', type: 'select', options: ['As-Built — Civil', 'As-Built — Architectural', 'As-Built — Structural', 'As-Built — MEP', 'Certificate of Occupancy', 'Permit', 'Survey', 'Geotech', 'O&M Manual', 'Warranty Document', 'Other'] },
      { k: 'egnyteDest', label: 'Egnyte Destination', type: 'select', options: ['Financial', 'Legal & Title', 'Insurance', 'Permits & Approvals', 'Plans & Drawings', 'Photos', 'Service & Maintenance', 'Closeout / O&M', 'Other'] },
      { k: 'title', label: 'Title', req: true },
      { k: 'dateOf', label: 'Document Date', type: 'date' },
      { k: 'version', label: 'Version / Set' },
      { k: 'location', label: 'Location (Egnyte Path)', full: true },
      { k: 'docFile', label: 'File (Upload)', type: 'file', nameKey: 'docFileName', full: true },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Document', main: (r) => r.title, sub: (r) => r.category + (r.version ? ' · ' + r.version : '') },
      { label: 'Date', mono: (r) => formatDate(r.dateOf) },
      { label: 'Location', mono: (r) => r.location || '—' },
    ],
    sort: (a, b) => (a.category || '') < (b.category || '') ? -1 : 1,
  },

  ahj: {
    title: 'Authority',
    plural: 'Authorities Having Jurisdiction',
    empty: 'No authorities on file. Add fire marshal, building department, elevator program, appraisal district, and district operators.',
    fields: [
      { k: 'authority', label: 'Authority Type', req: true },
      { k: 'jurisdiction', label: 'Jurisdiction / Agency', req: true },
      { k: 'contactName', label: 'Contact' },
      { k: 'title', label: 'Contact Title' },
      { k: 'phone', label: 'Phone' },
      { k: 'email', label: 'Email' },
      { k: 'portal', label: 'Portal URL' },
      { k: 'accountOrPermit', label: 'Account / Permit #' },
      { k: 'renewalDate', label: 'Renewal Date', type: 'date' },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Authority', main: (r) => r.authority, sub: (r) => r.jurisdiction },
      { label: 'Contact', main: (r) => r.contactName || '—', sub: (r) => [r.phone, r.email].filter(Boolean).join(' · ') },
      { label: 'Account / Permit', mono: (r) => r.accountOrPermit || '—' },
      { label: 'Renewal', chip: (r) => r.renewalDate ? renewalCellFromDate(r.renewalDate) : <StatusBadge tone="mut">N/A</StatusBadge> },
    ],
    sort: (a, b) => (a.authority || '') < (b.authority || '') ? -1 : 1,
  },

  utilities: {
    title: 'Utility',
    plural: 'Utilities',
    empty: 'No utility accounts on file. Add electric, water/sewer, internet, and trash with account and meter numbers.',
    fields: [
      { k: 'service', label: 'Service', req: true },
      { k: 'provider', label: 'Provider', req: true },
      { k: 'accountNumber', label: 'Account Number', req: true },
      { k: 'meterNumber', label: 'Meter' },
      { k: 'serviceAddress', label: 'Service Address', full: true },
      { k: 'autopay', label: 'Autopay', type: 'select', options: ['Yes — Ramp card', 'Yes — ACH', 'No'] },
      { k: 'avgMonthly', label: 'Avg Monthly ($)', type: 'number' },
      { k: 'contactPhone', label: 'Provider Phone' },
      { k: 'portal', label: 'Portal URL' },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Service', main: (r) => r.service, sub: (r) => r.provider },
      { label: 'Account #', mono: (r) => r.accountNumber || '—' },
      { label: 'Meter', mono: (r) => r.meterNumber || '—' },
      { label: 'Autopay', plain: (r) => r.autopay || '—' },
      { label: 'Avg / mo', mono: (r) => formatMoney(r.avgMonthly) },
    ],
    sort: (a, b) => (a.service || '') < (b.service || '') ? -1 : 1,
  },

  vendors: {
    title: 'Vendor',
    plural: 'Vendors',
    empty: 'No vendors on file. Add landscaping, pest, fire/life safety, elevator service, and gate/door vendors with contract and COI dates.',
    fields: [
      { k: 'category', label: 'Category', type: 'select', options: ['Fire & Life Safety', 'Elevator Service', 'Landscaping', 'Pest Control', 'Gate & Door Service', 'Access Control / Cameras', 'Janitorial / Porter', 'HVAC Service', 'Roofing', 'Other'] },
      { k: 'company', label: 'Company', req: true },
      { k: 'contactName', label: 'Contact' },
      { k: 'phone', label: 'Phone' },
      { k: 'email', label: 'Email' },
      { k: 'contractStart', label: 'Contract Start', type: 'date' },
      { k: 'contractEnd', label: 'Contract End', type: 'date' },
      { k: 'coiExpiration', label: 'COI Expiration', type: 'date' },
      { k: 'monthlyCost', label: 'Monthly Cost ($)', type: 'number' },
      { k: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    cols: [
      { label: 'Vendor', main: (r) => r.company, sub: (r) => r.category },
      { label: 'Contact', main: (r) => r.contactName || '—', sub: (r) => [r.phone, r.email].filter(Boolean).join(' · ') },
      { label: 'Contract', mono: (r) => formatDate(r.contractStart) + ' → ' + formatDate(r.contractEnd) },
      { label: 'COI', chip: (r) => r.coiExpiration ? renewalCellFromDate(r.coiExpiration) : <StatusBadge tone="red">Missing</StatusBadge> },
      { label: '$ / mo', mono: (r) => formatMoney(r.monthlyCost) },
    ],
    sort: (a, b) => (a.company || '') < (b.company || '') ? -1 : 1,
  },
};
