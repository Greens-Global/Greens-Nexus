// The portfolio's Dates tab and the Overview's worklist (Neil, 11/17/2026): every dated item
// on the records, from the ONE scanner (criticalItems.collectCriticalDates), sorted into
// Passed / Next 90 Days / This Year / Missing, grouped by month, with same-kind rows of a
// month collapsed into one ("Property tax installment - 30 properties - 12/10/2026"), and the
// yearly roll-forward behind Mark Paid / Mark Renewed. Dates are stored as MM/DD/YYYY or
// YYYY-MM-DD; a date is written back in the format it was stored in. A suspect date (year
// outside 1900-2100, a day that does not exist) is never passed or due - it sits in its own
// "Check These Dates" group.

import { collectCriticalDates, parseStoredDate, splitDates, CRITICAL_ITEM_TAB } from './criticalItems.js';
import { inferAssetKind } from './vehicleFields.js';
import { snapMap } from './assetMetrics.js';
import { formatDate } from './format.js';

/** What each kind of date is called on screen, and what a person does when it comes due. */
export const DATE_KINDS = {
  tax: { label: 'Property tax installment', action: 'Mark Paid', field: 'Due Dates', missing: 'property tax due date' },
  insurance: { label: 'Insurance expiration', action: 'Mark Renewed', field: 'Policy Expiration', missing: 'insurance expiration' },
  registration: { label: 'Vehicle registration', action: 'Mark Renewed', field: 'Registration Expiration', missing: 'registration expiration' },
  loan: { label: 'Loan maturity' },
  service: { label: 'Next service' },
  warranty: { label: 'Warranty expiration' },
  inspection: { label: 'Inspection due' },
  contract: { label: 'Contract end' },
  coi: { label: 'Vendor insurance certificate' },
  ahj: { label: 'Permit renewal' },
  permit: { label: 'Permit expiration' },
  maintenance: { label: 'Maintenance follow-up' },
};

export const DATE_MODES = [
  { key: 'passed', label: 'Passed' },
  { key: 'next90', label: 'Next 90 Days' },
  { key: 'year', label: 'This Year' },
  { key: 'missing', label: 'Missing' },
];

export const kindLabel = (kind) => (DATE_KINDS[kind] || {}).label || 'Date';
export const actionFor = (item) => (item && item.yearly && item.field && !item.suspect ? (DATE_KINDS[item.kind] || {}).action || '' : '');

const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
export { plural };

/** The asset noun for a count: "properties", "vehicles", else "assets". */
export function assetNoun(items, assetsById = {}) {
  const kinds = new Set(items.map((x) => inferAssetKind(assetsById[x.id] || {})));
  const n = new Set(items.map((x) => x.id)).size;
  if (kinds.size === 1 && kinds.has('property')) return plural(n, 'property', 'properties');
  if (kinds.size === 1 && kinds.has('vehicle')) return plural(n, 'vehicle');
  if (kinds.size === 1 && kinds.has('equipment')) return plural(n, 'piece of equipment', 'pieces of equipment');
  return plural(n, 'asset');
}

/** The day an item falls on as YYYY-MM-DD ('' for a suspect date). */
export function isoOf(raw) {
  const p = parseStoredDate(raw);
  if (!p || p.suspect) return '';
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Every dated item, with the asset's view to open it on. `assets` (optional) narrows the store
 *  to the assets the screen shows. */
export function collectDates(store, assets) {
  const ids = assets ? new Set(assets.map((a) => a.id)) : null;
  return collectCriticalDates(store)
    .filter((x) => !ids || ids.has(x.id))
    .map((x) => ({ ...x, iso: isoOf(x.date), tab: CRITICAL_ITEM_TAB[x.cat] || 'property', key: `${x.id}~${x.kind}~${x.recordId}~${x.part}~${x.date}` }));
}

/** Which bucket an item is in: passed | next90 | year | later | suspect. "This Year" is the
 *  coming twelve months, so it never runs dry in November. */
export function bucketOf(item) {
  if (item.suspect) return 'suspect';
  if (item.days < 0) return 'passed';
  if (item.days <= 90) return 'next90';
  if (item.days <= 365) return 'year';
  return 'later';
}

/** The items a mode shows: Passed = passed only; Next 90 Days and This Year lead with what has
 *  passed too (it is still waiting); suspect dates show in every date mode. */
export function itemsForMode(items, mode) {
  const keep = {
    passed: ['passed', 'suspect'],
    next90: ['passed', 'suspect', 'next90'],
    year: ['passed', 'suspect', 'next90', 'year'],
  }[mode] || [];
  return items.filter((x) => keep.includes(bucketOf(x)));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "In 23 days" / "Today" / "Tomorrow" / "Yesterday" / "105 days ago". */
export function relativeDays(days) {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

/** The tone of a date's words: red passed, live within 30 days, else quiet. */
export function toneOfDays(days) {
  if (days < 0) return 'red';
  if (days <= 30) return 'live';
  return 'quiet';
}

/** One row of the Dates list: a single item, or several of one kind in one group collapsed. */
function makeRow(kind, items, assetsById) {
  const days = items.map((x) => x.days);
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  const isoDays = [...new Set(items.map((x) => x.iso))].sort();
  let when;
  if (items[0].suspect) when = items.map((x) => x.date).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  else if (isoDays.length === 1) when = formatDate(isoDays[0]);
  else if (isoDays.length === 2) when = `${formatDate(isoDays[0])} and ${formatDate(isoDays[1])}`;
  else when = `${formatDate(isoDays[0])} to ${formatDate(isoDays[isoDays.length - 1])}`;
  let stands;
  if (items[0].suspect) stands = 'Check this date';
  else if (lo === hi) stands = relativeDays(lo);
  else if (hi < 0) stands = `${-hi} to ${-lo} days ago`;
  else if (lo > 0) stands = `In ${lo} to ${hi} days`;
  else stands = `${relativeDays(lo)} to ${relativeDays(hi).toLowerCase()}`;
  return {
    key: `${kind}~${items.map((x) => x.key).join('|')}`,
    kind,
    label: kindLabel(kind),
    items,
    count: items.length,
    where: items.length === 1 ? items[0].assetName : assetNoun(items, assetsById),
    when,
    stands,
    tone: items[0].suspect ? 'orange' : toneOfDays(lo),
    action: items.every((x) => actionFor(x)) ? actionFor(items[0]) : '',
    minDays: items[0].suspect ? Infinity : lo,
  };
}

/** Collapse a group's items: one row per kind (several assets -> one expandable row). */
function rowsOf(items, assetsById) {
  const byKind = new Map();
  items.forEach((x) => {
    if (!byKind.has(x.kind)) byKind.set(x.kind, []);
    byKind.get(x.kind).push(x);
  });
  return [...byKind.entries()].map(([kind, list]) => makeRow(kind, list, assetsById)).sort((a, b) => a.minDays - b.minDays);
}

/**
 * The list a mode shows, grouped: "Passed", "Check These Dates", then one group per month
 * ("December 2026"), soonest first. Each group's rows collapse same-kind items.
 */
export function groupDates(items, assetsById = {}) {
  const groups = [];
  const passed = items.filter((x) => bucketOf(x) === 'passed');
  const suspect = items.filter((x) => x.suspect);
  if (passed.length) groups.push({ key: 'passed', label: 'Passed', rows: rowsOf(passed, assetsById) });
  if (suspect.length) groups.push({ key: 'suspect', label: 'Check These Dates', rows: rowsOf(suspect, assetsById) });
  const months = new Map();
  items.filter((x) => !x.suspect && x.days >= 0).sort((a, b) => a.days - b.days).forEach((x) => {
    const k = x.iso.slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(x);
  });
  months.forEach((list, k) => {
    const [y, m] = k.split('-').map(Number);
    groups.push({ key: k, label: `${MONTHS[m - 1]} ${y}`, rows: rowsOf(list, assetsById) });
  });
  return groups;
}

/** The assets with no date of a kind on file: tax (properties), insurance (every asset),
 *  registration (vehicles). [{ kind, label, assets }], kinds with nobody missing left out. */
export function missingByKind(assets) {
  const live = (assets || []).filter((a) => !a.deleted);
  const has = (v) => splitDates(v).length > 0;
  const lists = [
    ['tax', live.filter((a) => inferAssetKind(a) === 'property' && !has(a.taxDue || snapMap(a)['due dates']))],
    ['insurance', live.filter((a) => !has(a.insExpiration || snapMap(a)['policy expiration']))],
    ['registration', live.filter((a) => inferAssetKind(a) === 'vehicle' && !has(a.regExpiration || snapMap(a)['registration expiration']))],
  ];
  return lists.filter(([, list]) => list.length).map(([kind, list]) => ({ kind, label: DATE_KINDS[kind].missing, assets: list }));
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** One stored date a year later, in the SAME format ("12/10/2026" -> "12/10/2027",
 *  "2026-12-10" -> "2027-12-10"; February 29 -> 28). '' when it is not a real date. */
export function rollYear(raw) {
  const s = String(raw ?? '').trim();
  const p = parseStoredDate(s);
  if (!p || p.suspect) return '';
  const y = p.y + 1;
  const d = p.m === 2 && p.d === 29 && !isLeap(y) ? 28 : p.d;
  if (p.format === 'iso') return `${y}-${String(p.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const [mm, dd] = s.split('/');
  const pad = (n, like) => (like.length === 2 ? String(n).padStart(2, '0') : String(n));
  return `${pad(p.m, mm)}/${pad(d, dd)}/${y}`;
}

/**
 * Mark Paid / Mark Renewed on one item: the asset's patch (the top-level field, the whole
 * comma list for tax installments with only this one rolled on) and the log's changes.
 * Several items of one asset (a collapsed group) roll together: pass them all.
 * Returns null when nothing can be rolled.
 */
export function rollPatch(asset, items) {
  const list = (Array.isArray(items) ? items : [items]).filter((x) => x && x.id === asset.id && actionFor(x));
  if (!list.length) return null;
  const patch = {};
  const changes = [];
  const byField = new Map();
  list.forEach((x) => { if (!byField.has(x.field)) byField.set(x.field, []); byField.get(x.field).push(x); });
  byField.forEach((xs, field) => {
    const snap = snapMap(asset);
    const from = String(asset[field] || snap[(DATE_KINDS[xs[0].kind].field || '').toLowerCase()] || '');
    const parts = splitDates(from);
    let changed = false;
    xs.forEach((x) => {
      if (parts[x.part] !== x.date) return;   // the value changed under us - leave it
      const next = rollYear(x.date);
      if (next) { parts[x.part] = next; changed = true; }
    });
    if (!changed) return;
    const to = [...new Set(parts)].join(', ');
    patch[field] = to;
    changes.push({ field: DATE_KINDS[xs[0].kind].field || field, from, to });
  });
  return changes.length ? { patch, changes } : null;
}

/** Mark Paid / Mark Renewed on items (one or a collapsed group): each asset's items roll
 *  together - one onPatchAsset call, so one log entry, per asset. Returns how many assets. */
export function markItems(items, assetsById, onPatchAsset) {
  const byAsset = new Map();
  (items || []).forEach((x) => { if (!byAsset.has(x.id)) byAsset.set(x.id, []); byAsset.get(x.id).push(x); });
  let done = 0;
  byAsset.forEach((list, id) => {
    const asset = assetsById[id];
    const out = asset && rollPatch(asset, list);
    if (out && onPatchAsset) { onPatchAsset(id, out.patch, out.changes); done += 1; }
  });
  return done;
}

/** The numbers for the Dates summary: passed, due in 90 days, suspect, and how many assets
 *  have an insurance expiration on file. */
export function datesSummary(items, assets) {
  const live = (assets || []).filter((a) => !a.deleted);
  const missingIns = missingByKind(live).find((m) => m.kind === 'insurance');
  return {
    passed: items.filter((x) => bucketOf(x) === 'passed').length,
    due90: items.filter((x) => bucketOf(x) === 'next90').length,
    suspect: items.filter((x) => x.suspect).length,
    withInsurance: live.length - (missingIns ? missingIns.assets.length : 0),
    assets: live.length,
  };
}
