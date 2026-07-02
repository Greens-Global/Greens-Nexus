// Critical-dates scanner: walks every asset (property/vehicle/equipment) and every related
// collection record (warranties, inspections, vendors, AHJ/permits, maintenance, service) and
// flattens every date-bearing field found into one list, each entry annotated with `days` — the
// signed day-count from today (negative = overdue, 0 = due today, positive = due in N days). This
// powers the "Critical Items" alert widget (Tier-3 critical-date alert engine).

import { daysUntil } from './format.js';
import { inferAssetKind } from './vehicleFields.js';
import { snapMap } from './assetMetrics.js';

/**
 * One flat list entry:
 *   { id, name, cat, label, detail, date, days }
 *     id    - the owning asset's id (property/vehicle/equipment)
 *     name  - the owning asset's display name (siteName, falling back to name)
 *     cat   - category, e.g. "Insurance" | "Property Tax" | "Loan" | "Registration" | "Service" |
 *             "Warranty" | "Inspection" | "Contract" | "COI" | "Permit / AHJ" | "Maintenance"
 *     label - human label for the specific date, e.g. "Policy expiration"
 *     detail- extra context (vendor/company/scope/type name), may be ''
 *     date  - the raw date value this entry was computed from
 *     days  - signed days-from-today (see daysUntil in format.js); negative = overdue
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
  Maintenance: 'maintenance',
};

/**
 * Scans the full store (all assets + all collections) for date fields relevant to compliance/
 * renewal tracking and returns a flat, day-sorted (soonest/most-overdue first) list.
 *
 * Only assets that still exist (not soft-deleted) are scanned; entries whose date is empty or
 * unparseable are silently skipped (daysUntil returns null for those, and `push` drops them) —
 * so this list only ever contains dates that are actually on file.
 */
export function collectCriticalDates(store) {
  const properties = (store.properties || []).filter((p) => !p.deleted);
  const byId = {};
  properties.forEach((p) => { byId[p.id] = p; });

  const out = [];
  const push = (id, cat, label, date, detail) => {
    if (!byId[id]) return; // orphaned record (owning asset deleted/missing) — skip
    const days = daysUntil(date);
    if (days == null) return; // no date on file, or unparseable — nothing to alert on
    const asset = byId[id];
    out.push({
      id,
      name: asset.siteName || asset.name || 'Unknown asset',
      cat,
      label,
      detail: detail || '',
      date,
      days,
    });
  };

  // Per-asset fields (property spec sheet fields, either top-level or in the free-text snapshot).
  properties.forEach((p) => {
    const snap = snapMap(p);
    const isProperty = inferAssetKind(p) === 'property';

    // Insurance policy expiration applies to every asset kind — top-level field first
    // (vehicles/equipment store it flat), falling back to the property snapshot's field.
    push(p.id, 'Insurance', 'Policy expiration', p.insExpiration || snap['policy expiration']);

    if (isProperty) {
      push(p.id, 'Property Tax', 'Tax payment due', p.taxDue);
      push(p.id, 'Loan', 'Loan maturity', snap['maturity date']);
    } else {
      // Vehicles/equipment: registration + next-service-due instead of tax/loan.
      push(p.id, 'Registration', 'Registration expiration', snap['registration expiration']);
      push(p.id, 'Service', 'Next service due', p.nextServiceDate || snap['next service due']);
    }
  });

  // Collection records — each carries a propertyId FK pointing at any asset.
  (store.warranties || []).forEach((x) =>
    push(x.propertyId, 'Warranty', 'Warranty expiration', x.expiration, x.scope || x.party || x.kind)
  );
  (store.inspections || []).forEach((x) =>
    push(x.propertyId, 'Inspection', 'Inspection due', x.nextDue, x.type)
  );
  (store.vendors || []).forEach((x) => {
    push(x.propertyId, 'Contract', 'Contract end', x.contractEnd, x.company || x.category);
    push(x.propertyId, 'COI', 'Insurance cert expiration', x.coiExpiration, x.company || x.category);
  });
  (store.ahj || []).forEach((x) =>
    push(x.propertyId, 'Permit / AHJ', 'Renewal due', x.renewalDate, x.authority || x.jurisdiction)
  );
  (store.maintenance || []).forEach((x) =>
    push(x.propertyId, 'Maintenance', 'Follow-up due', x.nextDue, x.system || x.description)
  );
  (store.vservice || []).forEach((x) =>
    push(x.propertyId, 'Service', 'Service due', x.nextDue, x.type)
  );

  out.sort((a, b) => a.days - b.days);
  return out;
}
