// The ONE "next service" rule for a vehicle or a piece of equipment (fleet cards,
// Neil 11/02/2026). The fleet card's progress track, the Health Status strip's
// Service signal (assetSignals) and anything else that asks "when is this due
// for service, and how far along is it" read nextService() - never a second rule.
//
// Where the dates and miles come from (the same places the module already kept):
//   - the Service & Maintenance log (`vservice` rows: date, mileage = the
//     odometer at the service, nextDue = Next Service Due, nextMileage = Next
//     Service Odometer). The newest row that names a next date / odometer is
//     the one that counts - an older row's due date was superseded by the
//     service logged after it.
//   - the asset's own fields from before the log existed (nextServiceDate /
//     lastServiceDate / nextServiceMi / serviceIntervalMi, and the snapshot's
//     "Next Service Due") - the fallback Critical Items has always read.
//   - the current odometer: the highest of the asset's Odometer field, the
//     Odometer Log readings and the odometers logged on service rows.
//
// Miles are tracked for vehicles only (equipment carries an Hour Meter, but no
// service row records hours, so equipment is tracked by date). When both a
// date and a mileage target exist, the one further along wins - service is
// due at whichever comes first.
//
// No service data = null: the card draws no track, never a made-up bar.

import { toNumber, formatDate } from './format.js';
import { inferAssetKind } from './vehicleFields.js';

const DAY = 864e5;

function snapValue(asset, label) {
  for (const group of asset.snapshot || []) {
    for (const field of group.fields || []) {
      if (String(field.label || '').trim().toLowerCase() === label) return field.value || '';
    }
  }
  return '';
}

// A record date (YYYY-MM-DD, or an imported MM/DD/YYYY) as a local-midnight Date.
function dayOf(v) {
  if (!v) return null;
  const s = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const us = iso ? null : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!iso && !us) return null;
  const d = iso ? new Date(+iso[1], +iso[2] - 1, +iso[3]) : new Date(+us[3], +us[1] - 1, +us[2]);
  return isNaN(d) ? null : d;
}

const positive = (v) => { const n = toNumber(v); return n > 0 ? n : 0; };
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** The current odometer of a vehicle: the highest reading on file, or 0. */
export function currentOdometer(asset, store = {}) {
  const id = asset.id;
  let best = positive(asset.odometer);
  for (const r of store.odometer || []) if (r.propertyId === id) best = Math.max(best, positive(r.mileage));
  for (const r of store.vservice || []) if (r.propertyId === id) best = Math.max(best, positive(r.mileage));
  return best;
}

/**
 * Where an asset stands against its next service, or null when nothing is on file.
 *
 *   { by: 'miles' | 'date',
 *     value  0..1 progress from the last service to the next one (1 once due),
 *     state  'live' while under, 'overdue' once past,
 *     note   "1,120 mi to next service" / "410 mi past due" / "Due 11/14/2026" /
 *            "12 days past due" / "Due today",
 *     dueDate  the next service date (YYYY-MM-DD as stored) or '',
 *     daysLeft signed days to dueDate, or null,
 *     milesLeft signed miles to the next service, or null,
 *     track  false when only an end is known (a future due date with no last
 *            service to measure from) - show the note, draw no bar }
 *
 * `today` is injectable for tests.
 */
export function nextService(asset, store = {}, today = new Date()) {
  if (!asset || inferAssetKind(asset) === 'property') return null;
  const now = new Date(today); now.setHours(0, 0, 0, 0);
  const rows = (store.vservice || [])
    .filter((r) => r.propertyId === asset.id && dayOf(r.date))
    .sort((a, b) => dayOf(b.date) - dayOf(a.date) || positive(b.mileage) - positive(a.mileage));
  const latest = rows[0] || null;

  // --- by date ---
  let dateFact = null;
  const dueRow = rows.find((r) => dayOf(r.nextDue));
  const dueRaw = dueRow ? dueRow.nextDue : (asset.nextServiceDate || snapValue(asset, 'next service due'));
  const due = dayOf(dueRaw);
  if (due) {
    const startRaw = dueRow ? dueRow.date : (asset.lastServiceDate || (latest && latest.date));
    const start = dayOf(startRaw);
    const daysLeft = Math.round((due - now) / DAY);
    let value = null;
    if (daysLeft < 0) value = 1;
    else if (start && due > start) value = Math.min(Math.max((now - start) / (due - start), 0), 1);
    else if (daysLeft === 0) value = 1;
    dateFact = {
      by: 'date', value, daysLeft, dueDate: String(dueRaw),
      state: daysLeft < 0 ? 'overdue' : 'live',
      note: daysLeft < 0 ? `${plural(-daysLeft, 'day')} past due` : daysLeft === 0 ? 'Due today' : `Due ${formatDate(dueRaw)}`,
    };
  }

  // --- by miles (vehicles) ---
  let mileFact = null;
  if (inferAssetKind(asset) === 'vehicle') {
    const odo = currentOdometer(asset, store);
    const mileRow = rows.find((r) => positive(r.nextMileage));
    let target = 0;
    let from = 0;
    if (mileRow) {
      target = positive(mileRow.nextMileage);
      from = positive(mileRow.mileage);
    } else if (positive(asset.nextServiceMi)) {
      target = positive(asset.nextServiceMi);
      const interval = positive(asset.serviceIntervalMi);
      from = interval ? target - interval : positive(latest && latest.mileage);
    } else if (positive(asset.serviceIntervalMi) && latest && positive(latest.mileage)) {
      from = positive(latest.mileage);
      target = from + positive(asset.serviceIntervalMi);
    }
    if (target && odo) {
      const milesLeft = Math.round(target - odo);
      let value = null;
      if (milesLeft <= 0) value = 1;
      else if (from > 0 && target > from) value = Math.min(Math.max((odo - from) / (target - from), 0), 1);
      mileFact = {
        by: 'miles', value, milesLeft,
        state: milesLeft < 0 ? 'overdue' : 'live',
        note: milesLeft < 0 ? `${(-milesLeft).toLocaleString('en-US')} mi past due`
          : milesLeft === 0 ? 'Service due now'
          : `${milesLeft.toLocaleString('en-US')} mi to next service`,
      };
    }
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
  };
}
