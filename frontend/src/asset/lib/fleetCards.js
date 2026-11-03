// The words and colors of the portfolio's fleet face - TileCard for a vehicle or a
// piece of equipment (Neil, 11/02/2026, mock https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE
// section 2). The next-service math is lib/nextService.js; this file is the rest.

import { toNumber, formatNumber } from './format.js';
import { inferAssetKind } from './vehicleFields.js';
import { nextService, currentOdometer } from './nextService.js';

// The vehicle / equipment Status vocabulary (vehicleFields.js: In Service, In Repair, Out of
// Service, Retired) as soft-label colors: running is green, in the shop or retired is the quiet
// slate, out of service is red. Orange is never a status - it is the live accent (progress to
// the next service, the selected card).
const SLATE = '#64748b';
const FLEET_STATUS_COLOR = {
  'in service': 'hsl(var(--color-green))',
  'in repair': SLATE,
  'out of service': 'hsl(var(--color-red))',
  retired: SLATE,
};

/** The soft-label color for a vehicle / equipment Status (slate for anything unknown). */
export function fleetStatusColor(devStage) {
  return FLEET_STATUS_COLOR[String(devStage || '').trim().toLowerCase()] || SLATE;
}

/** The identifying line under a fleet card's name: the plate, else the serial, else the VIN. */
export function fleetIdLine(asset) {
  const plate = String(asset.plate || '').trim();
  if (plate) return plate;
  const serial = String(asset.serialNumber || '').trim();
  if (serial) return 'Serial ' + serial;
  const vin = String(asset.vin || '').trim();
  return vin ? 'VIN ' + vin : '';
}

/** Up to two initials for an avatar ("Ana Ruiz" -> "AR", "ana@x.com" -> "A"). */
export function initialsOf(name) {
  const words = String(name || '').replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '';
  const first = words[0][0] || '';
  const last = words.length > 1 ? words[words.length - 1][0] || '' : '';
  return (first + last).toUpperCase();
}

/** The meter fact: "12,478 mi" for a vehicle (the given current odometer), "1,204 hrs" for
 *  equipment, or '' when nothing is on file. */
export function fleetMeter(asset, odometer) {
  if (inferAssetKind(asset) === 'equipment') {
    const h = toNumber(asset.hours);
    return h ? `${formatNumber(h)} hrs` : '';
  }
  const mi = toNumber(odometer != null ? odometer : asset.odometer);
  return mi ? `${formatNumber(mi)} mi` : '';
}

/** When the asset last changed, as an ISO string ('' when nothing is on file). A person's
 *  newest activity-log entry for it wins (a service record logged, a field edited) - the row's
 *  server stamp (`_rev`, its updated_at) also moves for machine writes (the geocoder, a
 *  migration), so it is only the fallback; a log entry with no person comes last. */
export function lastChangeOf(asset, logs) {
  let byPerson = '';
  let any = '';
  for (const entry of logs || []) {
    if (entry.propertyId !== asset.id || !entry.ts) continue;
    if (!any || entry.ts > any) any = entry.ts;
    if (entry.user && (!byPerson || entry.ts > byPerson)) byPerson = entry.ts;
  }
  const valid = (s) => s && Number.isFinite(new Date(s).getTime());
  if (valid(byPerson)) return String(byPerson);
  if (valid(asset._rev)) return String(asset._rev);
  return valid(any) ? String(any) : '';
}

/**
 * Everything a fleet card shows that comes from the records, for every vehicle and piece of
 * equipment at once: { [assetId]: { service, odometer, changed } }. The service, odometer and
 * log rows are grouped by asset in ONE pass, so the portfolio does not rescan the whole store
 * per card on every render (Portfolio memoizes this per store).
 */
export function fleetFactsFor(assets, store = {}) {
  const fleet = (assets || []).filter((a) => inferAssetKind(a) !== 'property');
  if (!fleet.length) return {};
  const ids = new Set(fleet.map((a) => a.id));
  const group = (rows) => {
    const m = new Map();
    for (const r of rows || []) {
      if (!ids.has(r.propertyId)) continue;
      if (!m.has(r.propertyId)) m.set(r.propertyId, []);
      m.get(r.propertyId).push(r);
    }
    return m;
  };
  const services = group(store.vservice);
  const readings = group(store.odometer);
  const logs = group(store.logs);
  const out = {};
  for (const a of fleet) {
    const own = { vservice: services.get(a.id) || [], odometer: readings.get(a.id) || [] };
    out[a.id] = {
      service: nextService(a, own),
      odometer: inferAssetKind(a) === 'vehicle' ? currentOdometer(a, own) : 0,
      changed: lastChangeOf(a, logs.get(a.id) || []),
    };
  }
  return out;
}
