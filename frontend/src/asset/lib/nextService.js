// The ONE "next service" rule for a vehicle or a piece of equipment (fleet cards,
// Neil 11/02/2026). The fleet card's progress track, the Health Status strip's
// Service signal (assetSignals) and Critical Items' Service entry all read
// nextService() - never a second rule.
//
// Where the targets come from:
//   - the Service & Maintenance log (`vservice` rows: date, mileage = the
//     odometer at the service, nextDue = Next Service Due, nextMileage = Next
//     Service Odometer). The NEWEST row that names any next target (a date, an
//     odometer, or both) supersedes every older row's targets and the asset's
//     own fields: a fresh oil change that only sets a date ends the mileage
//     target an older service set.
//   - only when no service row names a target: the asset's own fields from
//     before the log existed (nextServiceDate / lastServiceDate / nextServiceMi /
//     serviceIntervalMi, and the snapshot's "Next Service Due").
//   - a target that a service logged after it has already passed (a service
//     dated on or after the due date, or logged at or past the due odometer)
//     is done, not overdue - it is dropped.
//   - the current odometer: the highest reading on file (the asset's Odometer
//     field, the Odometer Log and the odometers on service rows), except that a
//     reading more than double the next highest AND over 100,000 mi above it is
//     taken as a typo (an extra digit) and skipped, so one bad entry cannot pin
//     a vehicle "overdue" for good. A brand-new vehicle going 100 -> 300 mi is
//     not an outlier; 12,000 -> 120,000 is.
//
// Garbled values are ignored, not trusted: a next odometer at or below that
// row's own service odometer, a date that is not a real calendar day
// ("2026-13-45").
//
// Miles are tracked for vehicles only (equipment carries an Hour Meter, but no
// service row records hours, so equipment is tracked by date). When both a
// date and a mileage target stand, the one further along wins - service is
// due at whichever comes first.
//
// No service data = null: the card draws no track, never a made-up bar.

import { toNumber, formatDate } from './format.js';
import { inferAssetKind } from './vehicleFields.js';

const DAY = 864e5;
// A reading this far above the next one, and more than double it, is a typo.
const OUTLIER_GAP_MI = 100000;

function snapValue(asset, label) {
  for (const group of asset.snapshot || []) {
    for (const field of group.fields || []) {
      if (String(field.label || '').trim().toLowerCase() === label) return field.value || '';
    }
  }
  return '';
}

/** A record date (YYYY-MM-DD, or an imported MM/DD/YYYY) as a local-midnight Date; null when
 *  it is not a real calendar day (no rolling "2026-13-45" over into 2027). */
export function dayOf(v) {
  if (!v) return null;
  const s = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const us = iso ? null : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!iso && !us) return null;
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : [+us[3], +us[1], +us[2]];
  const date = new Date(y, m - 1, d);
  if (isNaN(date) || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

const positive = (v) => { const n = toNumber(v); return n > 0 ? n : 0; };
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** The current odometer of a vehicle: the highest believable reading on file, or 0. */
export function currentOdometer(asset, store = {}) {
  const id = asset.id;
  const readings = [positive(asset.odometer)];
  for (const r of store.odometer || []) if (r.propertyId === id) readings.push(positive(r.mileage));
  for (const r of store.vservice || []) if (r.propertyId === id) readings.push(positive(r.mileage));
  const list = readings.filter(Boolean).sort((a, b) => b - a);
  while (list.length > 1 && list[0] > 2 * list[1] && list[0] - list[1] > OUTLIER_GAP_MI) list.shift();
  return list[0] || 0;
}

/**
 * Where an asset stands against its next service, or null when nothing is on file.
 *
 *   { by: 'miles' | 'date',
 *     value  0..1 progress from the last service to the next one (1 once due),
 *     state  'live' while under, 'overdue' once past,
 *     note   "1,120 mi to next service" / "410 mi past due" / "Due 11/14/2026" /
 *            "12 days past due" / "Due today" / "Service due now",
 *     dueDate  the next service date (as stored) or '',
 *     daysLeft signed days to dueDate, or null,
 *     milesLeft signed miles to the next service, or null,
 *     serviceType  the Service Type of the row that set the target, or '',
 *     track  false when only an end is known (a future due date with no last
 *            service to measure from) - show the note, draw no bar }
 *
 * `today` is injectable for tests.
 */
export function nextService(asset, store = {}, today = new Date()) {
  if (!asset) return null;
  const kind = inferAssetKind(asset);
  if (kind === 'property') return null;
  const tracksMiles = kind === 'vehicle';
  const now = new Date(today); now.setHours(0, 0, 0, 0);

  const rows = (store.vservice || [])
    .filter((r) => r.propertyId === asset.id)
    .map((r) => ({ r, day: dayOf(r.date), at: positive(r.mileage) }))
    .filter((x) => x.day)
    .sort((a, b) => b.day - a.day || b.at - a.at);
  const rowDue = (x) => dayOf(x.r.nextDue);
  // A next odometer at or below the row's own service odometer is garbled - ignored.
  const rowMiles = (x) => {
    if (!tracksMiles) return 0;
    const t = positive(x.r.nextMileage);
    return t && t > x.at ? t : 0;
  };

  let dueRaw = '';
  let due = null;
  let start = null;
  let mileTarget = 0;
  let mileFrom = 0;
  let serviceType = '';
  let later = rows;   // services logged after the target was set - they can complete it

  const ti = rows.findIndex((x) => rowDue(x) || rowMiles(x));
  if (ti >= 0) {
    const t = rows[ti];
    later = rows.slice(0, ti);
    serviceType = t.r.type || '';
    if (rowDue(t)) { dueRaw = t.r.nextDue; due = rowDue(t); start = t.day; }
    if (rowMiles(t)) { mileTarget = rowMiles(t); mileFrom = t.at; }
  } else {
    const latest = rows[0] || null;
    const legacyDue = asset.nextServiceDate || snapValue(asset, 'next service due');
    if (dayOf(legacyDue)) {
      dueRaw = legacyDue;
      due = dayOf(legacyDue);
      start = dayOf(asset.lastServiceDate) || (latest && latest.day < due ? latest.day : null);
    }
    if (tracksMiles) {
      const interval = positive(asset.serviceIntervalMi);
      if (positive(asset.nextServiceMi)) {
        mileTarget = positive(asset.nextServiceMi);
        mileFrom = interval ? mileTarget - interval : (latest ? latest.at : 0);
      } else if (interval && latest && latest.at) {
        // A target worked out from the newest service itself - nothing logged after it.
        mileFrom = latest.at;
        mileTarget = mileFrom + interval;
        later = later.filter((x) => x !== latest);
      }
    }
  }
  // A service logged on / after the due date, or at / past the due odometer, completed it.
  if (due && later.some((x) => x.day >= due)) due = null;
  if (mileTarget && later.some((x) => x.at >= mileTarget)) mileTarget = 0;

  // --- by date ---
  let dateFact = null;
  if (due) {
    const daysLeft = Math.round((due - now) / DAY);
    let value = null;
    if (daysLeft <= 0) value = 1;
    else if (start && due > start) value = Math.min(Math.max((now - start) / (due - start), 0), 1);
    dateFact = {
      by: 'date', value, daysLeft, dueDate: String(dueRaw),
      state: daysLeft < 0 ? 'overdue' : 'live',
      note: daysLeft < 0 ? `${plural(-daysLeft, 'day')} past due` : daysLeft === 0 ? 'Due today' : `Due ${formatDate(dueRaw)}`,
    };
  }

  // --- by miles (vehicles) ---
  let mileFact = null;
  const odo = mileTarget ? currentOdometer(asset, store) : 0;
  if (mileTarget && odo) {
    const milesLeft = Math.round(mileTarget - odo);
    let value = null;
    if (milesLeft <= 0) value = 1;
    else if (mileFrom > 0 && mileTarget > mileFrom) value = Math.min(Math.max((odo - mileFrom) / (mileTarget - mileFrom), 0), 1);
    mileFact = {
      by: 'miles', value, milesLeft,
      state: milesLeft < 0 ? 'overdue' : 'live',
      note: milesLeft < 0 ? `${(-milesLeft).toLocaleString('en-US')} mi past due`
        : milesLeft === 0 ? 'Service due now'
        : `${milesLeft.toLocaleString('en-US')} mi to next service`,
    };
  }

  if (!dateFact && !mileFact) return null;
  // Whichever comes first: overdue beats under, then the further-along track.
  // A tie goes to miles (the odometer is the more direct reading).
  const rank = (f) => (f ? (f.state === 'overdue' ? 2 : 0) + (f.value == null ? -0.5 : f.value) : -9);
  const pick = rank(mileFact) >= rank(dateFact) ? mileFact : dateFact;
  return {
    ...pick,
    value: pick.value == null ? 0 : pick.value,
    track: pick.value != null,
    dueDate: dateFact ? dateFact.dueDate : '',
    daysLeft: dateFact ? dateFact.daysLeft : null,
    milesLeft: mileFact ? mileFact.milesLeft : null,
    serviceType,
  };
}
