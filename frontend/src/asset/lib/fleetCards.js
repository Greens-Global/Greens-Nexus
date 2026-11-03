// The words and colors of the portfolio's fleet face - TileCard for a vehicle or a
// piece of equipment (Neil, 11/02/2026, mock https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE
// section 2). The next-service math is lib/nextService.js; this file is the rest.

import { toNumber, formatNumber } from './format.js';
import { inferAssetKind } from './vehicleFields.js';
import { freshTs } from './assetMetrics.js';

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

/** When the asset last changed: the newer of its row's server stamp (`_rev`, the row's
 *  updated_at) and its newest activity-log entry (a service record logged moves that one).
 *  An ISO string, or '' when neither is on file. */
export function lastChangeOf(asset, logs) {
  const stamps = [asset._rev, freshTs(logs, asset.id)]
    .filter(Boolean)
    .map((s) => [s, new Date(s).getTime()])
    .filter(([, t]) => Number.isFinite(t));
  if (!stamps.length) return '';
  stamps.sort((a, b) => b[1] - a[1]);
  return String(stamps[0][0]);
}
