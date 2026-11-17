// Critical-dates scanner: walks every asset (property/vehicle/equipment) and every related
// collection record (warranties, inspections, vendors, AHJ/permits, maintenance, service) and
// flattens every date-bearing field found into one list, each entry annotated with `days` - the
// signed day-count from today (negative = overdue, 0 = due today, positive = due in N days). This
// powers the "Critical Items" alert widget (Tier-3 critical-date alert engine) and the
// portfolio's Dates and Overview tabs (lib/datesModel.js, Neil 11/17/2026).
//
// Date sanity (11/17/2026): dates are stored as MM/DD/YYYY or YYYY-MM-DD (both are read). A
// date with a year before 1900 or after 2100, or a day that does not exist ("12/32/3232",
// "02/30/2026"), is SUSPECT: it is still listed (so someone can fix it) with `suspect: true`
// and `days: NaN`, and NaN fails every comparison, so a suspect date is never overdue, due
// or "in N days" anywhere that compares `days`. Check `suspect` before printing `days`.

import { daysUntil } from './format.js';
import { snapMap } from './assetMetrics.js';
import { inferAssetKind } from './vehicleFields.js';
import { nextService } from './nextService.js';

/**
 * One flat list entry:
 *   { id, name, cat, label, detail, date, days }
 *     id    - the owning asset's id (property/vehicle/equipment)
 *     name  - the owning asset's display name (siteName, falling back to name)
 *     cat   - category, e.g. "Insurance" | "Property Tax" | "Loan" | "Registration" | "Service" |
 *             "Warranty" | "Inspection" | "Contract" | "COI" | "Permit / AHJ" | "Maintenance"
 *     label - human label for the specific date, e.g. "Policy Expiration" (Title Case: it is a status word)
 *     detail- extra context (vendor/company/scope/type name), may be ''
 *     date  - the raw date value this entry was computed from
 *     days  - signed days-from-today (see daysUntil in format.js); negative = overdue;
 *             NaN for a suspect date
 *   and, for the Dates tab (lib/datesModel.js):
 *     kind     - stable key: tax | insurance | loan | registration | service | warranty |
 *                inspection | contract | coi | ahj | permit | maintenance
 *     field    - the asset's own top-level key the date is stored in ('' when it lives in a
 *                record or only in the snapshot) - what Mark Paid / Mark Renewed writes
 *     part     - which date of a comma-separated list (property tax installments), else 0
 *     yearly   - the date comes round every year (tax, insurance, registration)
 *     suspect  - true when the date is implausible (see the header)
 *     recordId - the collection record's id ('' for the asset's own fields)
 *     assetName- the asset's own name (a parcel's, where `name` is its site's)
 *
 * Maps each category to the tab an app should navigate to when a critical-item row is clicked.
 */
export const CRITICAL_ITEM_TAB = {
  Insurance: 'property',
  'Property Tax': 'property',
  Loan: 'property',
  Registration: 'property',
  Service: 'vservice',
  Warranty: 'warranties',
  Inspection: 'inspections',
  Contract: 'vendors',
  COI: 'vendors',
  'Permit / AHJ': 'ahj',
  Permit: 'permit',
  Maintenance: 'maintenance',
};

const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

/**
 * A stored date read either way it is kept: "MM/DD/YYYY" (M and D may be one digit) or
 * "YYYY-MM-DD" (a full ISO stamp too). Returns { y, m, d, format: 'us' | 'iso', suspect }, or
 * null when the value is not shaped like a date at all ("", "N/A", "TBD"). `suspect` = a year
 * outside 1900-2100 or a day that does not exist (12/32, 02/30, month 13).
 */
export function parseStoredDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(s);
  const us = iso ? null : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!iso && !us) return null;
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : [+us[3], +us[1], +us[2]];
  const real = m >= 1 && m <= 12 && d >= 1 && d <= new Date(2000 + (y % 400), m, 0).getDate();
  return { y, m, d, format: iso ? 'iso' : 'us', suspect: !real || y < YEAR_MIN || y > YEAR_MAX };
}

/** True for a value shaped like a date that cannot be right (see parseStoredDate). */
export function isSuspectDate(v) {
  const p = parseStoredDate(v);
  return !!(p && p.suspect);
}

/** A comma-separated date list ("11/01/2026, 02/01/2027" - property tax installments). */
export function splitDates(v) {
  return String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

/** The first value of a permit row whose key matches (permit rows have no fixed schema). */
export function permitValue(row, pattern) {
  const key = Object.keys(row || {}).find((k) => pattern.test(k));
  return key ? String(row[key] ?? '').trim() : '';
}
export const PERMIT_KEYS = {
  type: /^(permit\s*\/\s*approval(\s*type)?|permit type|type)$/i,
  number: /^permit\s*(no|number|#)\.?$/i,
  agency: /jurisdiction|agency/i,
  status: /^(permit\s*)?status$/i,
  court: /ball in/i,
  expiration: /expir/i,
};

/**
 * Scans the full store (all assets + all collections) for date fields relevant to compliance/
 * renewal tracking and returns a flat, day-sorted (soonest/most-overdue first) list.
 *
 * Only assets that still exist (not soft-deleted) are scanned; entries whose date is empty or
 * unparseable are silently skipped (daysUntil returns null for those, and `push` drops them) -
 * so this list only ever contains dates that are actually on file.
 */
export function collectCriticalDates(store) {
  const properties = (store.properties || []).filter((p) => !p.deleted);
  const byId = {};
  properties.forEach((p) => { byId[p.id] = p; });

  const out = [];
  const push = (id, cat, label, date, detail, meta = {}) => {
    if (!byId[id]) return; // orphaned record (owning asset deleted/missing) - skip
    const parsed = parseStoredDate(date);
    if (!parsed) return; // no date on file, or not a date at all - nothing to alert on
    const days = parsed.suspect ? NaN : daysUntil(date);
    if (days == null) return;
    const asset = byId[id];
    out.push({
      id,
      name: asset.siteName || asset.name || 'Unknown asset',
      cat,
      label,
      detail: detail || '',
      date,
      days,
      kind: meta.kind || '',
      field: meta.field || '',
      part: meta.part || 0,
      yearly: !!meta.yearly,
      suspect: parsed.suspect,
      recordId: meta.recordId || '',
      assetName: asset.name || asset.siteName || 'Unknown asset',
    });
  };
  // A field that may hold several dates (comma-separated) - one entry per date.
  const pushEach = (id, cat, label, value, detail, meta) => {
    splitDates(value).forEach((one, part) => push(id, cat, label, one, detail, { ...meta, part }));
  };

  // Per-asset fields (property spec sheet fields, either top-level or in the free-text snapshot).
  properties.forEach((p) => {
    const snap = snapMap(p);
    const isProperty = inferAssetKind(p) === 'property';

    // Insurance policy expiration applies to every asset kind - top-level field first
    // (vehicles/equipment store it flat), falling back to the property snapshot's field.
    push(p.id, 'Insurance', 'Policy Expiration', p.insExpiration || snap['policy expiration'], '',
      { kind: 'insurance', field: 'insExpiration', yearly: true });

    if (isProperty) {
      // Property tax falls due in installments: "11/01/2026, 02/01/2027" is two dates.
      pushEach(p.id, 'Property Tax', 'Tax Payment Due', p.taxDue || snap['due dates'], '',
        { kind: 'tax', field: 'taxDue', yearly: true });
      push(p.id, 'Loan', 'Loan Maturity', snap['maturity date'], '', { kind: 'loan' });
      // Permit expirations from the permit matrix (rows have no fixed schema).
      (p.permits || []).forEach((row, i) => push(p.id, 'Permit', 'Permit Expiration',
        permitValue(row, PERMIT_KEYS.expiration),
        permitValue(row, PERMIT_KEYS.type) || permitValue(row, PERMIT_KEYS.number), { kind: 'permit', recordId: String(i) }));
    } else {
      // Vehicles/equipment: registration + next-service-due instead of tax/loan.
      // Vehicles keep it flat (vehicleFields.js regExpiration); older ones in the snapshot.
      push(p.id, 'Registration', 'Registration Expiration', p.regExpiration || snap['registration expiration'], '',
        { kind: 'registration', field: 'regExpiration', yearly: true });
      // ONE entry per asset, from the one next-service rule (lib/nextService.js): the newest
      // service row's target (older, superseded rows' due dates no longer count), else the
      // asset's own fields. A mileage-only target has no date, so it is not a critical date.
      const service = nextService(p, store);
      if (service && service.dueDate) push(p.id, 'Service', 'Next Service Due', service.dueDate, service.serviceType, { kind: 'service' });
    }
  });

  // Collection records - each carries a propertyId FK pointing at any asset.
  const rec = (kind, x) => ({ kind, recordId: x.id || '' });
  (store.warranties || []).forEach((x) =>
    push(x.propertyId, 'Warranty', 'Warranty Expiration', x.expiration, x.scope || x.party || x.kind, rec('warranty', x))
  );
  (store.inspections || []).forEach((x) =>
    push(x.propertyId, 'Inspection', 'Inspection Due', x.nextDue, x.type, rec('inspection', x))
  );
  (store.vendors || []).forEach((x) => {
    push(x.propertyId, 'Contract', 'Contract End', x.contractEnd, x.company || x.category, rec('contract', x));
    push(x.propertyId, 'COI', 'Insurance Cert Expiration', x.coiExpiration, x.company || x.category, rec('coi', x));
  });
  (store.ahj || []).forEach((x) =>
    push(x.propertyId, 'Permit / AHJ', 'Renewal Due', x.renewalDate, x.authority || x.jurisdiction, rec('ahj', x))
  );
  (store.maintenance || []).forEach((x) =>
    push(x.propertyId, 'Maintenance', 'Follow-up Due', x.nextDue, x.system || x.description, rec('maintenance', x))
  );

  // Soonest / most overdue first; suspect dates (days NaN) last.
  out.sort((a, b) => (a.suspect - b.suspect) || (a.suspect ? 0 : a.days - b.days));
  return out;
}
