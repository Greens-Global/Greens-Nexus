// The Properties register's query model (Neil, 11/17/2026 - the Asset Management
// redesign): what a "view" is, how its filters apply, the faceted counts the
// Filters panel shows, the phrase rules of the smart search, the suggested
// views, the one summary sentence and the group sums. Pure functions only - the
// screen (components/portfolio/*) draws them, App.jsx keeps the state and the
// address. No AI: the phrase parser is rules, like tasks/sayTask.js.
//
// A view = { filters, groupBy, sort, mode, columns, id }. `filters`:
//   q        free text (never in the address - typing would push history)
//   stage    devStage values ('__none__' = Not Set)
//   type     deriveType buckets (Self-Storage, Retail, ...)
//   loc      place keys: 'US:CA', 'India:Maharashtra', or a whole country 'c:India'
//   city     city names (lower case) - picked from the search's Filter By
//   company  company ids ('__none__' = No Company)
//   manager  manager keys (lower case, spaces collapsed; '__none__' = Not Set)
//   owner    ownership entities (lower case keys)
//   shows    conditions, OR'd: due, passed, missing, timeline, permits, nophoto,
//            private, flagged, mistyped, changed, tickets
//   acresMin / acresMax / sfMin / sfMax   numbers as typed ('' = open)
//   dueMonth { cat, month } - "tax due in december"
// Within one facet the picks are OR'd ("Type Self-Storage or Retail"); facets AND.

import { toNumber, acresOf } from './format.js';
import { inferAssetKind } from './vehicleFields.js';
import { assetCompleteness, US_ST, cityRegion, searchHaystack } from './assetMetrics.js';
import { typeLabel, deriveType, TYPES } from './portfolioCards.js';
import { parcelAcres } from './parcelGrouping.js';
import { companyIdOf, companyName } from './companies.js';
import { baseStage } from './stages.js';
import { collectCriticalDates } from './criticalItems.js';

export const NONE = '__none__';

export const EMPTY_FILTERS = Object.freeze({
  q: '', stage: [], type: [], loc: [], city: [], company: [], manager: [], owner: [], shows: [],
  acresMin: '', acresMax: '', sfMin: '', sfMax: '', dueMonth: null,
});
const LIST_FACETS = ['stage', 'type', 'loc', 'city', 'company', 'manager', 'owner', 'shows'];

export const DEFAULT_VIEW = Object.freeze({ id: 'all', filters: EMPTY_FILTERS, groupBy: 'none', sort: 'name', columns: null });

export const GROUP_OPTIONS = [
  ['none', 'None'], ['stage', 'Stage'], ['state', 'State'], ['type', 'Type'],
  ['owner', 'Owner'], ['manager', 'Asset Manager'], ['company', 'Company'],
];
export const SORT_OPTIONS = [
  ['name', 'Name'], ['acres', 'Acres'], ['sf', 'Rentable SF'], ['units', 'Units'], ['stage', 'Stage'], ['changed', 'Recently Changed'],
];
export const COLUMN_OPTIONS = [
  ['type', 'Type'], ['stage', 'Stage'], ['owner', 'Owner'], ['manager', 'Asset Manager'], ['company', 'Company'],
  ['acres', 'Acres'], ['sf', 'Rentable SF'], ['units', 'Units'], ['occupied', 'Occupied'],
];
export const DEFAULT_COLUMNS = ['type', 'stage', 'owner', 'manager', 'acres', 'sf', 'units', 'occupied'];

// The development pipeline, in order (the Development tab's stages).
export const PIPELINE = ['In Escrow', 'Entitlement', 'Construction Drawings', 'Construction', 'Lease-Up', 'Stabilized - Renovation'];
const STAGE_ORDER = ['In Escrow', 'Entitlement', 'Construction Drawings', 'Construction', 'Lease-Up', 'Stabilized', 'On Hold'];

export const SHOW_OPTIONS = [
  ['due', 'A date passed or due in 30 days', true],
  ['missing', 'Missing key details', true],
  ['timeline', 'Has a development timeline', true],
  ['permits', 'Has open permits', true],
  ['nophoto', 'No photo', true],
  ['private', 'Private', true],
  ['passed', 'A date passed', false],
  ['mistyped', 'A date that looks mistyped', false],
  ['flagged', 'Flagged for review', false],
  ['changed', 'Changed this month', false],
  ['tickets', 'Has open tickets', false],
  ['mine', 'Managed by me', false],
];
export const SHOW_LABEL = Object.fromEntries(SHOW_OPTIONS.map(([k, l]) => [k, l]));

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_TITLE = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));

// ------------------------------------------------------------------------------------------
// Normalization: one state however it was typed, one manager however it was spaced
// ------------------------------------------------------------------------------------------

export const normSpace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lc = (s) => normSpace(s).toLowerCase();
const titleWords = (s) => normSpace(s).toLowerCase().replace(/(^|[\s-/])([a-z])/g, (m, a, b) => a + b.toUpperCase());

/** "neil  kadakia" and "Neil Kadakia" are one manager. '' = Not Set. */
export function managerKey(name) { return lc(name) || NONE; }
/** The name as people typed it, title-cased only when typed all one case. */
export function managerLabel(name) {
  const s = normSpace(name);
  if (!s) return 'Not set';
  return s === s.toLowerCase() || s === s.toUpperCase() ? titleWords(s) : s;
}

export const IN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi',
  'Chandigarh', 'Puducherry', 'Jammu and Kashmir', 'Ladakh',
];
const IN_BY_LOWER = Object.fromEntries(IN_STATES.map((s) => [s.toLowerCase(), s]));
const US_BY_NAME = Object.fromEntries(Object.entries(US_ST).map(([code, name]) => [name.toLowerCase(), code]));

/** Where an asset is: { country, state, label, key } - "CA" and "California" are one state;
 *  Indian states sit under India. key '' = no place on file. */
export function placeOf(asset) {
  let raw = normSpace(asset?.state);
  const address = String(asset?.address || '');
  if (!raw) { const m = address.match(/,\s*([A-Za-z]{2})\s+\d{5}/); if (m) raw = m[1]; }
  const india = /\bindia\b/i.test(`${asset?.country || ''} ${address}`) || !!IN_BY_LOWER[raw.toLowerCase()];
  if (india) {
    const name = IN_BY_LOWER[raw.toLowerCase()] || (raw ? titleWords(raw) : '');
    return { country: 'India', state: name, label: name || 'India', key: name ? `India:${name}` : 'c:India' };
  }
  const code = US_ST[raw.toUpperCase()] ? raw.toUpperCase() : US_BY_NAME[raw.toLowerCase()] || '';
  if (code) return { country: 'United States', state: code, label: US_ST[code], key: `US:${code}` };
  const country = normSpace(asset?.country);
  if (!raw && !country) return { country: '', state: '', label: '', key: '' };
  const c = country || 'Other';
  return { country: c, state: raw, label: raw || c, key: raw ? `${c}:${raw}` : `c:${c}` };
}

export const cityOf = (asset) => normSpace(String(cityRegion(asset) || '').split(',')[0]);

// ------------------------------------------------------------------------------------------
// Measures: a parcel group is one property, its numbers the SUM of its parcels
// ------------------------------------------------------------------------------------------

const unitsOf = (m) => toNumber(m.unitsTotal) || toNumber(m.unitsClimate) + toNumber(m.unitsNonClimate) + toNumber(m.unitsRV);
const memberAcres = (m) => acresOf(m.acreage, m.acreageUnit) || parcelAcres(m);

/** { acres, sf, units, parcels } for a property and its linked parcels. */
export function measuresOf(asset, all = []) {
  const members = asset.parentId ? [asset] : [asset, ...all.filter((x) => x.parentId === asset.id && !x.deleted)];
  return {
    acres: members.reduce((n, m) => n + memberAcres(m), 0),
    sf: members.reduce((n, m) => n + toNumber(m.nrsf), 0),
    units: members.reduce((n, m) => n + unitsOf(m), 0),
    parcels: members.length,
    members,
  };
}

export const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
export const fmtAcres = (n) => (n ? n.toFixed(2) : '');

/** One facts line, the same measures in the same order for every property. */
export function factsLine(m) {
  const out = [];
  if (m.acres) out.push(`${fmtAcres(m.acres)} acres`);
  if (m.sf) out.push(`${fmtInt(m.sf)} rentable sf`);
  if (m.units) out.push(`${fmtInt(m.units)} units`);
  return out.join(' · ');
}

// ------------------------------------------------------------------------------------------
// Dates: a date that cannot be real is "Check this date", never overdue
// ------------------------------------------------------------------------------------------

/** True for a date that is on file but cannot be meant: year before 1900 or after 2100, or a
 *  day that does not exist (12/32/3232, 02/30/2026). Both stored formats are read. */
export function isSuspectDate(v) {
  const s = String(v ?? '').trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const us = iso ? null : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!iso && !us) return false;
  const [y, mo, d] = iso ? [+iso[1], +iso[2], +iso[3]] : [+us[3], +us[1], +us[2]];
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1) return true;
  return d > new Date(y, mo, 0).getDate();
}
const monthOf = (v) => {
  const s = String(v ?? '').trim();
  const iso = /^(\d{4})-(\d{1,2})-/.exec(s);
  if (iso) return +iso[2];
  const us = /^(\d{1,2})\//.exec(s);
  return us ? +us[1] : 0;
};

const OPEN_PERMIT = (status) => !/closed|approved|permitted|issued|final|n\/a|^na$/i.test(String(status || '').trim());
export const openPermitCount = (asset) => (asset.permits || []).filter((p) => OPEN_PERMIT(p.status || p.Status || p['Status'])).length;

// ------------------------------------------------------------------------------------------
// The context: everything per asset worked out once per store
// ------------------------------------------------------------------------------------------

/**
 * ctx = { byId: { [id]: facts }, rows, all, companies, metrics, me }
 * facts = { measures, place, city, type, stage, company, manager, owner, shows:Set, months:[{cat,month}],
 *           passed, mistyped, changedAt, haystack }
 */
export function buildContext({ assets = [], store = {}, companies = [], metrics = {}, openTickets = null, me = null, now = new Date() } = {}) {
  const mine = myNames(me);
  const all = assets;
  const live = all.filter((a) => !a.deleted);
  const rows = live.filter((a) => inferAssetKind(a) === 'property' && !a.parentId);
  const leadOf = {};
  live.forEach((a) => { leadOf[a.id] = a.parentId && live.some((x) => x.id === a.parentId) ? a.parentId : a.id; });

  const crit = collectCriticalDates({ ...store, properties: live });
  const dates = {};
  crit.forEach((c) => {
    const lead = leadOf[c.id] || c.id;
    (dates[lead] ||= []).push({ ...c, suspect: !!c.suspect || isSuspectDate(c.date) });
  });
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const changed = {};
  (store.logs || []).forEach((l) => {
    const lead = leadOf[l.propertyId];
    if (!lead || !l.ts) return;
    if (!changed[lead] || l.ts > changed[lead]) changed[lead] = l.ts;
  });

  const byId = {};
  rows.forEach((a) => {
    const m = measuresOf(a, live);
    const own = dates[a.id] || [];
    const real = own.filter((d) => !d.suspect);
    const shows = new Set();
    const passed = real.filter((d) => d.days < 0);
    const mistyped = own.filter((d) => d.suspect);
    if (real.some((d) => Number.isFinite(d.days) && d.days <= 30)) shows.add('due');
    if (passed.length) shows.add('passed');
    if (mistyped.length) shows.add('mistyped');
    if (m.members.some((x) => assetCompleteness(x).pct < 100)) shows.add('missing');
    if ((a.timeline || []).length) shows.add('timeline');
    if (openPermitCount(a)) shows.add('permits');
    if (!((a.images && a.images.length) || a.image)) shows.add('nophoto');
    if (a.private) shows.add('private');
    if (m.members.some((x) => (x.reviewFlags || []).length)) shows.add('flagged');
    if (String(changed[a.id] || '').slice(0, 7) === monthKey) shows.add('changed');
    if (openTickets && m.members.some((x) => openTickets.has(x.id))) shows.add('tickets');
    if (mine.size && mine.has(lc(a.manager))) shows.add('mine');
    const place = placeOf(a);
    const companyId = companyIdOf(a);
    byId[a.id] = {
      measures: m,
      place,
      city: cityOf(a),
      type: deriveType(a) || 'Other',
      typeText: typeLabel(a),
      stage: normSpace(a.devStage) || NONE,
      company: companyId || NONE,
      companyName: companyName(companies, companyId),
      manager: managerKey(a.manager),
      managerName: managerLabel(a.manager),
      owner: lc(a.entity) || NONE,
      ownerName: normSpace(a.entity),
      shows,
      months: real.map((d) => ({ cat: d.cat, month: monthOf(d.date) })),
      dates: own,
      passed: passed.length,
      mistyped: mistyped.length,
      changedAt: changed[a.id] || '',
      occupancy: metrics?.[a.id]?.occupancy,
      haystack: [a.name, a.siteName, a.entity, companyName(companies, companyId), a.manager, cityRegion(a), typeLabel(a), a.address, searchHaystack(a), a.devStage]
        .filter(Boolean).join(' ').toLowerCase(),
    };
  });
  return { byId, rows, all: live, companies, metrics, hasTickets: !!openTickets };
}

// ------------------------------------------------------------------------------------------
// Applying filters, faceted counts
// ------------------------------------------------------------------------------------------

export function normalizeFilters(f) {
  const out = { ...EMPTY_FILTERS, ...(f || {}) };
  LIST_FACETS.forEach((k) => { out[k] = Array.isArray(out[k]) ? out[k] : []; });
  return out;
}

const num = (v) => (String(v ?? '').trim() === '' ? null : toNumber(v));

function matchFacet(facet, picks, f) {
  if (!picks.length) return true;
  switch (facet) {
    case 'stage': return picks.includes(f.stage);
    case 'type': return picks.includes(f.type);
    case 'loc': return picks.some((p) => p === f.place.key || (p.startsWith('c:') && p.slice(2) === f.place.country));
    case 'city': return picks.includes(f.city.toLowerCase());
    case 'company': return picks.includes(f.company);
    case 'manager': return picks.includes(f.manager);
    case 'owner': return picks.includes(f.owner);
    case 'shows': return picks.some((p) => f.shows.has(p));
    default: return true;
  }
}

/** Does one row's facts pass the filters? `skip` leaves one facet out (for its own counts). */
export function passes(f, filters, skip = '') {
  if (!f) return false;
  const q = lc(filters.q);
  if (q && !q.split(' ').every((w) => f.haystack.includes(w))) return false;
  for (const facet of LIST_FACETS) {
    if (facet !== skip && !matchFacet(facet, filters[facet] || [], f)) return false;
  }
  if (skip !== 'size') {
    const { acres, sf } = f.measures;
    const [a0, a1, s0, s1] = [num(filters.acresMin), num(filters.acresMax), num(filters.sfMin), num(filters.sfMax)];
    if (a0 != null && acres < a0) return false;
    if (a1 != null && acres > a1) return false;
    if (s0 != null && sf < s0) return false;
    if (s1 != null && sf > s1) return false;
  }
  const dm = filters.dueMonth;
  if (dm && dm.month && !f.months.some((x) => x.month === dm.month && (!dm.cat || x.cat === dm.cat))) return false;
  return true;
}

export function applyFilters(ctx, filters) {
  const fl = normalizeFilters(filters);
  return ctx.rows.filter((a) => passes(ctx.byId[a.id], fl));
}

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

/** Faceted counts: each facet counts what remains after the OTHER facets' picks. */
export function facetCounts(ctx, filters) {
  const fl = normalizeFilters(filters);
  const out = {};
  for (const facet of [...LIST_FACETS, 'size']) {
    const base = ctx.rows.filter((a) => passes(ctx.byId[a.id], fl, facet));
    const m = new Map();
    base.forEach((a) => {
      const f = ctx.byId[a.id];
      if (facet === 'loc') { if (f.place.key) { bump(m, f.place.key); bump(m, `c:${f.place.country}`); } }
      else if (facet === 'shows') f.shows.forEach((s) => bump(m, s));
      else if (facet === 'city') bump(m, f.city.toLowerCase());
      else if (facet === 'size') bump(m, 'all');
      else bump(m, f[facet]);
    });
    out[facet] = m;
  }
  return out;
}

/** The options each facet offers (from every row, so a zero still shows, gray). */
export function facetOptions(ctx) {
  const seen = { stage: new Map(), type: new Map(), loc: new Map(), company: new Map(), manager: new Map(), owner: new Map(), city: new Map() };
  ctx.rows.forEach((a) => {
    const f = ctx.byId[a.id];
    seen.stage.set(f.stage, f.stage === NONE ? 'Not set' : f.stage);
    seen.type.set(f.type, f.type);
    if (f.place.key) seen.loc.set(f.place.key, { label: f.place.label, country: f.place.country });
    seen.company.set(f.company, f.company === NONE ? 'No Company' : (f.companyName || 'Unknown Company'));
    if (!seen.manager.has(f.manager)) seen.manager.set(f.manager, f.managerName);
    if (!seen.owner.has(f.owner)) seen.owner.set(f.owner, f.owner === NONE ? 'Not set' : f.ownerName);
    if (f.city) seen.city.set(f.city.toLowerCase(), f.city);
  });
  const byLabel = (a, b) => String(a.label).localeCompare(String(b.label));
  const noneLast = (list) => [...list.filter((o) => o.key !== NONE).sort(byLabel), ...list.filter((o) => o.key === NONE)];
  const stageRank = (k) => { const i = STAGE_ORDER.indexOf(baseStage(k)); return i < 0 ? 99 : i; };
  const countries = {};
  seen.loc.forEach((v, key) => { (countries[v.country] ||= []).push({ key, label: v.label }); });
  const countryOrder = Object.keys(countries).sort((a, b) => (a === 'United States' ? -1 : b === 'United States' ? 1 : a.localeCompare(b)));
  return {
    stage: [...seen.stage].map(([key, label]) => ({ key, label })).sort((a, b) => stageRank(a.key) - stageRank(b.key) || a.label.localeCompare(b.label)),
    type: [...seen.type].map(([key, label]) => ({ key, label })).sort((a, b) => TYPES.indexOf(a.key) - TYPES.indexOf(b.key)),
    loc: countryOrder.map((c) => ({ key: `c:${c}`, label: c, states: countries[c].filter((s) => !s.key.startsWith('c:')).sort(byLabel) })),
    company: noneLast([...seen.company].map(([key, label]) => ({ key, label }))),
    manager: noneLast([...seen.manager].map(([key, label]) => ({ key, label }))),
    owner: noneLast([...seen.owner].map(([key, label]) => ({ key, label }))),
    city: [...seen.city].map(([key, label]) => ({ key, label })).sort(byLabel),
  };
}

export const activeCount = (filters) => {
  const fl = normalizeFilters(filters);
  return LIST_FACETS.reduce((n, k) => n + (fl[k].length ? 1 : 0), 0)
    + ((fl.acresMin !== '' || fl.acresMax !== '') ? 1 : 0) + ((fl.sfMin !== '' || fl.sfMax !== '') ? 1 : 0) + (fl.dueMonth ? 1 : 0);
};
export const hasFilters = (filters) => activeCount(filters) > 0 || !!lc(filters?.q);

// ------------------------------------------------------------------------------------------
// Words: the active filters as a sentence part each
// ------------------------------------------------------------------------------------------

const FACET_TITLE = { stage: 'Stage', type: 'Type', loc: 'Location', city: 'City', company: 'Company', manager: 'Asset Manager', owner: 'Owner', shows: 'Shows' };

/** [{ key, title, words, clear: (filters) => filters }] for every active filter. */
export function filterWords(filters, options) {
  const fl = normalizeFilters(filters);
  const label = (facet, key) => {
    if (facet === 'shows') return SHOW_LABEL[key] || key;
    if (facet === 'loc') {
      if (key.startsWith('c:')) return key.slice(2);
      for (const c of options?.loc || []) { const s = c.states.find((x) => x.key === key); if (s) return s.label; }
      return key.split(':').slice(1).join(':');
    }
    const hit = (options?.[facet] || []).find((o) => o.key === key);
    if (hit) return hit.label;
    return key === NONE ? 'Not set' : titleWords(key);
  };
  const out = [];
  LIST_FACETS.forEach((facet) => {
    if (!fl[facet].length) return;
    const title = facet === 'loc' ? (fl.loc.every((k) => k.startsWith('c:')) ? 'Country' : 'State') : FACET_TITLE[facet];
    out.push({ key: facet, title, words: fl[facet].map((k) => label(facet, k)).join(' or '), clear: (f) => ({ ...f, [facet]: [] }) });
  });
  const range = (min, max, unit) => (min !== '' && max !== '' ? `${min} to ${max} ${unit}` : min !== '' ? `over ${min} ${unit}` : `under ${max} ${unit}`);
  if (fl.acresMin !== '' || fl.acresMax !== '') out.push({ key: 'acres', title: 'Size', words: range(fl.acresMin, fl.acresMax, 'acres'), clear: (f) => ({ ...f, acresMin: '', acresMax: '' }) });
  if (fl.sfMin !== '' || fl.sfMax !== '') out.push({ key: 'sf', title: 'Size', words: range(fl.sfMin, fl.sfMax, 'rentable sf'), clear: (f) => ({ ...f, sfMin: '', sfMax: '' }) });
  if (fl.dueMonth) out.push({ key: 'due', title: 'Due', words: `${fl.dueMonth.cat ? fl.dueMonth.cat.toLowerCase() + ' ' : ''}in ${MONTH_TITLE[fl.dueMonth.month - 1]}`.replace(/^./, (c) => c.toUpperCase()), clear: (f) => ({ ...f, dueMonth: null }) });
  return out;
}

// ------------------------------------------------------------------------------------------
// Sort, group, sums
// ------------------------------------------------------------------------------------------

const nameOf = (a) => normSpace(a.siteName || a.name);

export function sortRows(rows, ctx, sort = 'name') {
  const f = (a) => ctx.byId[a.id] || { measures: {} };
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b));
  const list = rows.slice();
  if (sort === 'acres') return list.sort((a, b) => f(b).measures.acres - f(a).measures.acres || byName(a, b));
  if (sort === 'sf') return list.sort((a, b) => f(b).measures.sf - f(a).measures.sf || byName(a, b));
  if (sort === 'units') return list.sort((a, b) => f(b).measures.units - f(a).measures.units || byName(a, b));
  if (sort === 'changed') return list.sort((a, b) => String(f(b).changedAt).localeCompare(String(f(a).changedAt)) || byName(a, b));
  if (sort === 'stage') {
    const r = (a) => { const i = STAGE_ORDER.indexOf(baseStage(a.devStage)); return i < 0 ? 99 : i; };
    return list.sort((a, b) => r(a) - r(b) || byName(a, b));
  }
  return list.sort(byName);
}

export function sumsOf(rows, ctx) {
  return rows.reduce((s, a) => {
    const m = ctx.byId[a.id]?.measures || {};
    return { acres: s.acres + (m.acres || 0), sf: s.sf + (m.sf || 0), units: s.units + (m.units || 0) };
  }, { acres: 0, sf: 0, units: 0 });
}

/** [{ key, label, rows, sums }] - one group of everything when groupBy is 'none'. */
export function groupRows(rows, ctx, groupBy = 'none') {
  if (!groupBy || groupBy === 'none') return [{ key: 'all', label: '', rows, sums: sumsOf(rows, ctx) }];
  const keyOf = (a) => {
    const f = ctx.byId[a.id];
    switch (groupBy) {
      case 'stage': return [f.stage, f.stage === NONE ? 'No Stage' : f.stage];
      case 'state': return [f.place.key || NONE, f.place.key ? f.place.label : 'No Location'];
      case 'type': return [f.type, f.type];
      case 'owner': return [f.owner, f.owner === NONE ? 'No Owner' : f.ownerName];
      case 'manager': return [f.manager, f.manager === NONE ? 'No Asset Manager' : f.managerName];
      case 'company': return [f.company, f.company === NONE ? 'No Company' : (f.companyName || 'Unknown Company')];
      default: return ['all', ''];
    }
  };
  const groups = new Map();
  rows.forEach((a) => {
    const [key, label] = keyOf(a);
    if (!groups.has(key)) groups.set(key, { key, label, rows: [] });
    groups.get(key).rows.push(a);
  });
  const list = [...groups.values()];
  const rank = (g) => {
    if (g.key === NONE) return 1e6;
    if (groupBy === 'stage') { const i = STAGE_ORDER.indexOf(baseStage(g.key)); return (i < 0 ? 99 : i) * 10 + (g.key.includes(' - ') ? 1 : 0); }
    if (groupBy === 'type') return TYPES.indexOf(g.key);
    return 0;
  };
  return list.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)).map((g) => ({ ...g, sums: sumsOf(g.rows, ctx) }));
}

// ------------------------------------------------------------------------------------------
// The summary sentence and the needs line
// ------------------------------------------------------------------------------------------

const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** "23 properties in 8 states - 131 acres and 664,000 rentable square feet." */
export function summarySentence(rows, ctx) {
  if (!rows.length) return 'No properties match.';
  const places = new Set(rows.map((a) => ctx.byId[a.id]?.place).filter((p) => p && p.state).map((p) => p.key));
  const s = sumsOf(rows, ctx);
  let where = '';
  if (places.size === 1) where = ` in ${ctx.byId[rows.find((a) => ctx.byId[a.id]?.place?.state).id].place.label}`;
  else if (places.size > 1) where = ` in ${places.size} states`;
  const sf = s.sf >= 10000 ? Math.round(s.sf / 1000) * 1000 : Math.round(s.sf);
  const size = [s.acres ? `${fmtInt(s.acres)} ${Math.round(s.acres) === 1 ? 'acre' : 'acres'}` : '', sf ? `${fmtInt(sf)} rentable square feet` : ''].filter(Boolean).join(' and ');
  return `${plural(rows.length, 'property', 'properties')}${where}${size ? ` - ${size}` : ''}.`;
}

/** What needs you on the current list: { passed, noManager, mistyped, items } (zeros left to the caller). */
export function needsOf(rows, ctx) {
  let passed = 0; let mistyped = 0; let noManager = 0;
  const items = [];
  rows.forEach((a) => {
    const f = ctx.byId[a.id];
    if (!f) return;
    passed += f.passed;
    mistyped += f.mistyped;
    if (f.manager === NONE) noManager += 1;
    f.dates.forEach((d) => { if (d.suspect || d.days < 0) items.push({ ...d, assetId: a.id, assetName: nameOf(a) }); });
  });
  // Real dates first, most overdue first; a date that cannot be real has no day count.
  items.sort((x, y) => (x.suspect === y.suspect ? (x.suspect ? 0 : x.days - y.days) : x.suspect ? 1 : -1));
  return { passed, mistyped, noManager, items };
}

// ------------------------------------------------------------------------------------------
// Suggested views and the presets other tabs open
// ------------------------------------------------------------------------------------------

/** The ways the signed-in person may be written in an asset's free-text manager field: their
 *  name, their email, their email's name part ("neil.kadakia" -> "neil kadakia"). The same rule
 *  as the Overview tab's Mine. */
export function myNames(me) {
  const out = new Set();
  const m = me || {};
  [m.name, m.displayName, m.userName, m.fullName].forEach((v) => { const k = lc(v); if (k && k !== 'you') out.add(k); });
  const email = String(m.email || m.username || '').trim().toLowerCase();
  if (email) {
    out.add(email);
    const local = email.split('@')[0];
    if (local) out.add(local.replace(/[._-]+/g, ' ').trim());
  }
  return out;
}

export const SUGGESTED_VIEWS = [
  ['all', 'All Properties'],
  ['mine', 'My Properties'],
  ['attention', 'Needs Attention'],
  ['missing', 'Missing Key Details'],
  ['development', 'In Development'],
  ['stabilized', 'Stabilized'],
  ['changed', 'Changed This Month'],
];

/** The filters a suggested view stands for (with the person, for My Properties). */
export function suggestedFilters(id) {
  const f = { ...EMPTY_FILTERS };
  switch (id) {
    case 'mine': return { ...f, shows: ['mine'] };
    case 'attention': return { ...f, shows: ['due', 'flagged'] };
    case 'missing': return { ...f, shows: ['missing'] };
    case 'development': return { ...f, stage: PIPELINE.slice() };
    case 'stabilized': return { ...f, stage: ['Stabilized'] };
    case 'changed': return { ...f, shows: ['changed'] };
    default: return f;
  }
}

// goTab('properties', { preset }) from the other tabs.
const PRESET_VIEW = {
  'no-manager': () => ({ id: 'preset', name: 'No Asset Manager', filters: { ...EMPTY_FILTERS, manager: [NONE] } }),
  'needs-attention': (me) => ({ id: 'attention', filters: suggestedFilters('attention', me) }),
  'missing-details': (me) => ({ id: 'missing', filters: suggestedFilters('missing', me) }),
  'in-development': (me) => ({ id: 'development', filters: suggestedFilters('development', me), groupBy: 'stage' }),
  'mistyped-dates': () => ({ id: 'preset', name: 'Dates That Look Mistyped', filters: { ...EMPTY_FILTERS, shows: ['mistyped'] } }),
  'passed-dates': () => ({ id: 'preset', name: 'Dates Passed', filters: { ...EMPTY_FILTERS, shows: ['passed'] } }),
  'no-company': () => ({ id: 'preset', name: 'No Company', filters: { ...EMPTY_FILTERS, company: [NONE] } }),
  'open-tickets': () => ({ id: 'preset', name: 'Open Tickets', filters: { ...EMPTY_FILTERS, shows: ['tickets'] } }),
};
export const PRESETS = Object.keys(PRESET_VIEW);

/** A preset as a view patch ({ id, filters, groupBy?, name? }), or null for an unknown key. */
export function presetView(key, me) {
  const make = PRESET_VIEW[key];
  return make ? make(me) : null;
}

// ------------------------------------------------------------------------------------------
// The view in the address: asset-portfolio~st=Entitlement,Construction;g=stage
// ------------------------------------------------------------------------------------------

const CODE = { stage: 'st', type: 'ty', loc: 'lo', city: 'ci', company: 'co', manager: 'ma', owner: 'ow', shows: 'sh' };
const enc = (v) => encodeURIComponent(String(v));
const dec = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

/** A view as a short, path-safe string ('' for the default view). `q` is never written. */
export function encodeView(view) {
  if (!view) return '';
  const fl = normalizeFilters(view.filters);
  const parts = [];
  if (view.id && view.id !== 'all') parts.push(`v=${enc(view.id)}`);
  if (view.name && view.id && !SUGGESTED_VIEWS.some(([k]) => k === view.id)) parts.push(`n=${enc(view.name)}`);
  LIST_FACETS.forEach((k) => { if (fl[k].length) parts.push(`${CODE[k]}=${fl[k].map(enc).join(',')}`); });
  if (fl.acresMin !== '' || fl.acresMax !== '') parts.push(`a=${enc(fl.acresMin)},${enc(fl.acresMax)}`);
  if (fl.sfMin !== '' || fl.sfMax !== '') parts.push(`sf=${enc(fl.sfMin)},${enc(fl.sfMax)}`);
  if (fl.dueMonth) parts.push(`dm=${enc(fl.dueMonth.cat || '')},${fl.dueMonth.month}`);
  if (view.groupBy && view.groupBy !== 'none') parts.push(`g=${enc(view.groupBy)}`);
  if (view.sort && view.sort !== 'name') parts.push(`s=${enc(view.sort)}`);
  if (view.mode) parts.push(`m=${enc(view.mode)}`);
  return parts.join(';');
}

/** The other way; unknown parts are ignored, so an old or hand-edited link still opens. */
export function decodeView(str) {
  const view = { id: 'all', filters: { ...EMPTY_FILTERS }, groupBy: 'none', sort: 'name', mode: '' };
  if (!str) return view;
  const byCode = Object.fromEntries(Object.entries(CODE).map(([k, c]) => [c, k]));
  String(str).split(';').forEach((part) => {
    const at = part.indexOf('=');
    if (at < 1) return;
    const k = part.slice(0, at);
    const vals = part.slice(at + 1).split(',').map(dec);
    if (byCode[k]) view.filters[byCode[k]] = vals.filter(Boolean);
    else if (k === 'v') view.id = vals[0] || 'all';
    else if (k === 'n') view.name = part.slice(at + 1).split(',').map(dec).join(',');
    else if (k === 'a') { view.filters.acresMin = vals[0] || ''; view.filters.acresMax = vals[1] || ''; }
    else if (k === 'sf') { view.filters.sfMin = vals[0] || ''; view.filters.sfMax = vals[1] || ''; }
    else if (k === 'dm') { const m = Number(vals[1]); if (m >= 1 && m <= 12) view.filters.dueMonth = { cat: vals[0] || '', month: m }; }
    else if (k === 'g' && GROUP_OPTIONS.some(([g]) => g === vals[0])) view.groupBy = vals[0];
    else if (k === 's' && SORT_OPTIONS.some(([s]) => s === vals[0])) view.sort = vals[0];
    else if (k === 'm' && ['list', 'gallery', 'map'].includes(vals[0])) view.mode = vals[0];
  });
  return view;
}

/** Same filters, grouping and sort (what "edited" compares; q and mode aside). */
export function sameView(a, b) {
  const strip = (v) => encodeView({ ...v, id: 'all', name: '', mode: '' });
  return strip(a || DEFAULT_VIEW) === strip(b || DEFAULT_VIEW);
}

// ------------------------------------------------------------------------------------------
// The smart search: Filter By suggestions, by RULES
// ------------------------------------------------------------------------------------------

const STAGE_WORDS = [
  [/\bin escrow\b|\bescrow\b/, 'In Escrow'], [/\bentitlements?\b/, 'Entitlement'], [/\bconstruction drawings?\b|\bdrawings\b/, 'Construction Drawings'],
  [/\bunder construction\b|\bconstruction\b/, 'Construction'], [/\blease[- ]?up\b/, 'Lease-Up'], [/\bstabili[sz]ed\b/, 'Stabilized'],
  [/\bon hold\b/, 'On Hold'], [/\brenovations?\b/, 'Stabilized - Renovation'],
];
const TYPE_WORDS = [
  [/\bself[- ]?storage\b|\bmini[- ]?storage\b/, 'Self-Storage'], [/\b(vehicle|rv|boat) storage\b|\brv\b/, 'Vehicle Storage'],
  [/\bretail\b/, 'Retail'], [/\boffice\b|\bmedical\b/, 'Office / Medical'], [/\bresidential\b|\bhomes?\b/, 'Residential'],
  [/\bmixed[- ]?use\b/, 'Mixed-Use'], [/\bland\b|\blots?\b/, 'Land'],
];
const DATE_CATS = [[/\b(property )?tax(es)?\b/, 'Property Tax'], [/\binsurance\b|\bpolicy\b/, 'Insurance'], [/\bregistration\b/, 'Registration'], [/\bwarrant(y|ies)\b/, 'Warranty'], [/\binspections?\b/, 'Inspection']];

/** The phrase's rules as one filters patch plus the words it read, or null when nothing was read. */
export function parsePhrase(text, options) {
  let s = ` ${lc(text)} `;
  const patch = {};
  const read = [];
  const take = (re) => { const m = s.match(re); if (m) s = s.replace(m[0], ' '); return m; };
  // Size: "over 3 acres", "under 50,000 sf", "between 2 and 5 acres"
  let m = take(/\b(?:between|from)\s+([\d,.]+)\s+(?:and|to)\s+([\d,.]+)\s*(acres?|ac|sf|sq ?ft|square feet)\b/);
  if (m) { const k = /ac/.test(m[3]) ? 'acres' : 'sf'; patch[`${k}Min`] = m[1].replace(/,/g, ''); patch[`${k}Max`] = m[2].replace(/,/g, ''); read.push(`${m[1]} to ${m[2]} ${k === 'acres' ? 'acres' : 'rentable sf'}`); }
  while ((m = take(/\b(over|above|more than|at least|>|under|below|less than|<)\s*([\d,.]+)\s*(acres?|ac|sf|sq ?ft|square feet)\b/))) {
    const k = /ac/.test(m[3]) ? 'acres' : 'sf';
    const low = /over|above|more|least|>/.test(m[1]);
    patch[`${k}${low ? 'Min' : 'Max'}`] = m[2].replace(/,/g, '');
    read.push(`${low ? 'over' : 'under'} ${m[2]} ${k === 'acres' ? 'acres' : 'rentable sf'}`);
  }
  // "tax due in december"
  m = take(/\b(?:([a-z ]+?)\s+)?due\s+(?:in\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (m) {
    const cat = (DATE_CATS.find(([re]) => re.test(m[1] || '')) || [])[1] || '';
    patch.dueMonth = { cat, month: MONTHS.indexOf(m[2]) + 1 };
    read.push(`${cat ? cat.toLowerCase() + ' ' : ''}due in ${MONTH_TITLE[MONTHS.indexOf(m[2])]}`);
  }
  if (take(/\b(no|without an?|missing( an?)?)\s+(asset\s+)?manager\b|\bunmanaged\b/)) { patch.manager = [NONE]; read.push('no asset manager'); }
  if (take(/\b(no|without an?|missing( an?)?)\s+company\b/)) { patch.company = [NONE]; read.push('no company'); }
  if (take(/\b(no|without an?|missing( an?)?)\s+(photos?|pictures?)\b/)) { (patch.shows ||= []).push('nophoto'); read.push('no photo'); }
  if (take(/\bmissing (key )?details\b|\bincomplete\b/)) { (patch.shows ||= []).push('missing'); read.push('missing key details'); }
  if (take(/\b(overdue|past due|passed)\b/)) { (patch.shows ||= []).push('passed'); read.push('a date passed'); }
  if (take(/\bprivate\b/)) { (patch.shows ||= []).push('private'); read.push('private'); }
  if (take(/\bopen permits?\b/)) { (patch.shows ||= []).push('permits'); read.push('open permits'); }
  if (take(/\bin development\b/)) { patch.stage = PIPELINE.slice(); read.push('in development'); }
  for (const [re, stage] of STAGE_WORDS) {
    if (take(re)) { (patch.stage ||= []).includes(stage) || patch.stage.push(stage); read.push(stage); }
  }
  for (const [re, type] of TYPE_WORDS) {
    if (take(re)) { (patch.type ||= []).includes(type) || patch.type.push(type); read.push(type); }
  }
  // Places: a state code after "in" ("in TX"), a state's name, a bare two-letter code that is a state.
  const states = (options?.loc || []).flatMap((c) => c.states);
  const tryState = (word) => {
    const w = word.toLowerCase();
    const hit = states.find((st) => st.label.toLowerCase() === w || st.key.split(':')[1]?.toLowerCase() === w);
    if (hit) return hit;
    const code = US_ST[w.toUpperCase()] ? w.toUpperCase() : US_BY_NAME[w];
    return code ? { key: `US:${code}`, label: US_ST[code] } : (IN_BY_LOWER[w] ? { key: `India:${IN_BY_LOWER[w]}`, label: IN_BY_LOWER[w] } : null);
  };
  const names = [...Object.values(US_ST), ...IN_STATES].map((n) => n.toLowerCase()).sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (new RegExp(`\\b${n}\\b`).test(s)) { const hit = tryState(n); if (hit) { take(new RegExp(`\\b(in )?${n}\\b`)); (patch.loc ||= []).push(hit.key); read.push(hit.label); } }
  }
  let mm;
  const codeRe = /\b(?:in\s+)?([a-z]{2})\b/g;
  while ((mm = codeRe.exec(s))) {
    const w = mm[1];
    if (['in', 'of', 'or', 'to', 'on', 'at', 'by', 'an', 'no', 'me', 'my', 'is', 'it', 'as', 'be', 'do', 'go', 'up', 'us', 'we', 'so', 'he', 'hi', 'ok'].includes(w) && !/^in\s/.test(mm[0])) continue;
    const hit = US_ST[w.toUpperCase()] ? tryState(w) : null;
    if (hit) { (patch.loc ||= []).includes(hit.key) || patch.loc.push(hit.key); read.push(hit.label); s = s.replace(mm[0], ' '); codeRe.lastIndex = 0; }
  }
  // Whole words that are a city, a manager or an owner on file.
  const rest = normSpace(s.replace(/\b(in|with|and|the|properties|property|sites?|all|show|me|my)\b/g, ' '));
  if (rest) {
    const hitIn = (list) => list.find((o) => o.key !== NONE && o.label && o.label.toLowerCase() === rest);
    const city = hitIn(options?.city || []);
    const mgr = !city && hitIn(options?.manager || []);
    const own = !city && !mgr && hitIn(options?.owner || []);
    if (city) { patch.city = [city.key]; read.push(city.label); }
    else if (mgr) { patch.manager = [mgr.key]; read.push(mgr.label); }
    else if (own) { patch.owner = [own.key]; read.push(own.label); }
    else if (read.length) return { patch, read, rest };
  }
  return read.length ? { patch, read, rest: '' } : null;
}

/** Merge a patch's picks into filters (lists united, single values replaced). */
export function mergeFilters(filters, patch) {
  const out = normalizeFilters(filters);
  Object.entries(patch || {}).forEach(([k, v]) => {
    if (Array.isArray(v)) out[k] = [...new Set([...(out[k] || []), ...v])];
    else out[k] = v;
  });
  return out;
}

/**
 * The search menu for `text`: { filterBy: [{ label, value, patch, count }], properties: [asset], records: [...] }.
 * filterBy leads with the whole phrase's reading, then each facet value whose name holds the
 * text ("City is Austin"). Nothing here is applied - the screen applies what is picked.
 */
export function searchSuggestions(text, ctx, options, store = {}, filters = EMPTY_FILTERS) {
  const q = lc(text);
  const out = { filterBy: [], properties: [], records: [] };
  if (q.length < 2) return out;
  const count = (patch) => applyFilters(ctx, mergeFilters({ ...filters, q: '' }, patch)).length;
  const phrase = parsePhrase(q, options);
  const keys = phrase ? Object.keys(phrase.patch) : [];
  const facetOnly = keys.length === 1 && ['city', 'manager', 'owner', 'type', 'stage', 'loc'].includes(keys[0]) && phrase.patch[keys[0]].length === 1;
  if (phrase && !phrase.rest && !facetOnly) {
    out.filterBy.push({ label: phrase.read.join(', ').replace(/^./, (c) => c.toUpperCase()), value: '', patch: phrase.patch, count: count(phrase.patch) });
  }
  const facets = [['city', 'City is'], ['loc', 'State is'], ['type', 'Type is'], ['stage', 'Stage is'], ['manager', 'Asset manager is'], ['owner', 'Owner is'], ['company', 'Company is']];
  facets.forEach(([facet, words]) => {
    const list = facet === 'loc' ? (options.loc || []).flatMap((c) => c.states) : (options[facet] || []);
    list.filter((o) => o.key !== NONE && String(o.label).toLowerCase().includes(q)).slice(0, 3).forEach((o) => {
      const patch = { [facet]: [o.key] };
      if (out.filterBy.some((x) => JSON.stringify(x.patch) === JSON.stringify(patch))) return;
      out.filterBy.push({ label: words, value: o.label, patch, count: count(patch) });
    });
  });
  out.filterBy = out.filterBy.slice(0, 6);
  out.properties = ctx.rows.filter((a) => nameOf(a).toLowerCase().includes(q) || String(a.address || '').toLowerCase().includes(q)).slice(0, 5);
  out.records = recordHits(q, ctx, store).slice(0, 6);
  return out;
}

// Inside Records: utilities, AHJ, permits, vendors, a vehicle's VIN or plate.
const RECORD_SEARCH = [
  ['utilities', 'Utilities', (r) => [r.provider, r.accountNumber, r.service], (r) => r.provider || r.accountNumber, (r) => `${r.service || 'Utility'}`],
  ['ahj', 'AHJ', (r) => [r.jurisdiction, r.authority, r.accountOrPermit], (r) => r.jurisdiction || r.authority, (r) => r.authority || 'Authority'],
  ['vendors', 'Vendors', (r) => [r.company, r.category, r.contactName], (r) => r.company, (r) => r.category || 'Vendor'],
];

/** The first-column words a record table shows for a row (what it highlights by). */
export function recordIdentity(coll, row, recordTypes) {
  const col = recordTypes?.[coll]?.cols?.[0];
  if (!col) return '';
  return (col.main ? col.main(row) : col.mono ? col.mono(row) : '') || recordTypes[coll].title;
}

function recordHits(q, ctx, store) {
  const hits = [];
  const assetName = (id) => { const a = ctx.all.find((x) => x.id === id); return a ? nameOf(a) : ''; };
  const visible = new Set(ctx.all.map((a) => a.id));
  RECORD_SEARCH.forEach(([coll, group, fields, title, what]) => {
    (store[coll] || []).forEach((r) => {
      if (!visible.has(r.propertyId)) return;
      if (!fields(r).some((v) => String(v || '').toLowerCase().includes(q))) return;
      hits.push({ coll, group, assetId: r.propertyId, row: r, title: title(r), detail: `${what(r)} at ${assetName(r.propertyId)}` });
    });
  });
  ctx.all.forEach((a) => {
    (a.permits || []).forEach((p, i) => {
      const vals = Object.values(p || {}).map((v) => String(v || ''));
      if (!vals.some((v) => v.toLowerCase().includes(q))) return;
      const first = vals.find((v) => v.trim()) || `Permit ${i + 1}`;
      hits.push({ coll: 'permit', group: 'Permits', assetId: a.id, row: p, item: first, title: p.number || p['Permit #'] || first, detail: `${p.type || p['Permit / Approval'] || 'Permit'}, ${nameOf(a)}` });
    });
    if (inferAssetKind(a) !== 'property') {
      const vin = String(a.vin || ''); const plate = String(a.plate || '');
      if (vin.toLowerCase().includes(q) || plate.toLowerCase().includes(q)) {
        hits.push({ coll: 'property', group: 'Fleet', assetId: a.id, row: a, title: plate || vin, detail: `${vin.toLowerCase().includes(q) ? 'VIN' : 'Plate'} of ${nameOf(a)}` });
      }
    }
  });
  return hits;
}

// ------------------------------------------------------------------------------------------
// Stage ink: a stage is plain colored text
// ------------------------------------------------------------------------------------------

/** The color a stage's word is drawn in: green settled, live ink while work is under way,
 *  blue in approvals, red on hold, the secondary ink otherwise. */
export function stageInk(stage) {
  const s = String(stage || '');
  if (/^on hold/i.test(s)) return 'hsl(var(--color-red))';
  if (/^stabili[sz]ed\s*[-–]/i.test(s) || /construct|escrow|drawings|lease/i.test(s)) return 'var(--wk-live-ink)';
  if (/entitle/i.test(s)) return 'hsl(var(--color-blue))';
  if (/^stabil|in service/i.test(s)) return 'hsl(var(--color-green))';
  return 'var(--text-secondary)';
}
