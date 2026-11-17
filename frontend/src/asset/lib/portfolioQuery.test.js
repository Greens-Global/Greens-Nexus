import { describe, it, expect } from 'vitest';
import {
  buildContext, applyFilters, facetCounts, facetOptions, parsePhrase, presetView, suggestedFilters, mergeFilters,
  encodeView, decodeView, sameView, groupRows, sumsOf, summarySentence, needsOf, placeOf, managerKey, managerLabel,
  isSuspectDate, filterWords, sortRows, searchSuggestions, myNames, EMPTY_FILTERS, NONE,
} from './portfolioQuery.js';
import { portfolioSub, parsePortfolioSub } from './navigation.js';

const ASSETS = [
  { id: 'a', kind: 'property', name: 'Greens Storage, Austin', city: 'Austin', state: 'TX', assetType: 'Self-Storage', devStage: 'Stabilized', manager: 'Neil Kadakia', entity: 'Greens Austin, LLC.', acreage: '3.45', nrsf: '151620', unitsTotal: '1005', companyId: 'c1', image: 'x.jpg' },
  { id: 'b', kind: 'property', name: 'Greens Storage, Escondido', siteName: 'Escondido', city: 'Escondido', state: 'California', assetType: 'Vehicle Storage', devStage: 'Entitlement', manager: 'rajesh  kadakia', entity: 'GS Escondido, LLC.', acreage: '20', nrsf: '100000', unitsTotal: '500', companyId: '' },
  { id: 'b2', kind: 'property', name: 'Escondido Parcel 2', parentId: 'b', state: 'CA', acreage: '10.79', nrsf: '19929', unitsTotal: '302' },
  { id: 'c', kind: 'property', name: 'Taco Bell', city: 'San Clemente', state: 'CA', assetType: 'Retail', devStage: 'Stabilized - Renovation', manager: '', entity: 'Oversite', acreage: '0.21', companyId: 'c1', taxDue: '12/32/3232' },
  { id: 'd', kind: 'property', name: 'Innopolis', address: 'Pune, Maharashtra, India', state: 'Maharashtra', assetType: 'Land', devStage: 'In Escrow', manager: 'Rajesh Kadakia', companyId: 'c2', private: true },
  { id: 'v', kind: 'vehicle', name: 'Ford Transit', devStage: 'In Service' },
];
const COMPANIES = [{ id: 'c1', name: 'Greens Storage', assignable: true }, { id: 'c2', name: 'Greens India', assignable: true }];
const store = { properties: ASSETS, warranties: [{ propertyId: 'a', expiration: '2020-01-01', scope: 'Roof' }], inspections: [], vendors: [], ahj: [], maintenance: [], logs: [] };
const ctx = buildContext({ assets: ASSETS, store, companies: COMPANIES, me: { name: 'Neil Kadakia', email: 'neil.kadakia@x.com' } });
const ids = (rows) => rows.map((a) => a.id).sort();

describe('normalization', () => {
  it('reads CA and California as one state, and Indian states under India', () => {
    expect(placeOf({ state: 'CA' }).key).toBe('US:CA');
    expect(placeOf({ state: 'california' }).key).toBe('US:CA');
    expect(placeOf({ state: 'California' }).label).toBe('California');
    expect(placeOf({ state: 'Maharashtra' })).toMatchObject({ country: 'India', key: 'India:Maharashtra' });
    expect(placeOf({ address: '1 Main St, Austin, TX 78729' }).key).toBe('US:TX');
    expect(placeOf({}).key).toBe('');
  });
  it('one manager however it was spaced or cased', () => {
    expect(managerKey('rajesh  kadakia')).toBe(managerKey('Rajesh Kadakia'));
    expect(managerKey('  ')).toBe(NONE);
    expect(managerLabel('rajesh  kadakia')).toBe('Rajesh Kadakia');
    expect(managerLabel('')).toBe('Not set');
  });
  it('a date that cannot be real is suspect, in both stored formats', () => {
    expect(isSuspectDate('12/32/3232')).toBe(true);
    expect(isSuspectDate('12/12/1212')).toBe(true);
    expect(isSuspectDate('2026-02-30')).toBe(true);
    expect(isSuspectDate('2026-12-10')).toBe(false);
    expect(isSuspectDate('12/10/2026')).toBe(false);
    expect(isSuspectDate('')).toBe(false);
  });
  it('knows the signed-in person by name and by email', () => {
    const n = myNames({ name: 'Neil  Kadakia', email: 'Neil.Kadakia@x.com' });
    expect(n.has('neil kadakia')).toBe(true);
    expect(n.has('neil.kadakia@x.com')).toBe(true);
  });
});

describe('filters', () => {
  it('lists top-level properties only - parcels ride their lead, vehicles live in Fleet', () => {
    expect(ids(ctx.rows)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('ORs picks inside a facet and ANDs facets', () => {
    expect(ids(applyFilters(ctx, { type: ['Self-Storage', 'Vehicle Storage'] }))).toEqual(['a', 'b']);
    expect(ids(applyFilters(ctx, { type: ['Self-Storage', 'Vehicle Storage'], loc: ['US:CA'] }))).toEqual(['b']);
    expect(ids(applyFilters(ctx, { loc: ['c:India'] }))).toEqual(['d']);
    expect(ids(applyFilters(ctx, { manager: [NONE] }))).toEqual(['c']);
    expect(ids(applyFilters(ctx, { manager: ['rajesh kadakia'] }))).toEqual(['b', 'd']);
    expect(ids(applyFilters(ctx, { company: [NONE] }))).toEqual(['b']);
  });
  it('sizes use the parcel group SUM', () => {
    expect(ids(applyFilters(ctx, { acresMin: '25' }))).toEqual(['b']);   // 20 + 10.79
    expect(ids(applyFilters(ctx, { sfMax: '1000' }))).toEqual(['c', 'd']);
  });
  it('text search needs every word', () => {
    expect(ids(applyFilters(ctx, { q: 'greens austin' }))).toEqual(['a']);
    expect(ids(applyFilters(ctx, { q: 'texas' }))).toEqual(['a']);
  });
  it('shows: passed dates, mistyped dates, private, mine', () => {
    expect(ids(applyFilters(ctx, { shows: ['passed'] }))).toEqual(['a']);
    expect(ids(applyFilters(ctx, { shows: ['mistyped'] }))).toEqual(['c']);
    expect(ids(applyFilters(ctx, { shows: ['private'] }))).toEqual(['d']);
    expect(ids(applyFilters(ctx, { shows: ['mine'] }))).toEqual(['a']);
    expect(ids(applyFilters(ctx, { shows: ['nophoto'] }))).toEqual(['b', 'c', 'd']);
  });
  it('counts are faceted: a facet counts what the OTHER picks leave', () => {
    const f = { type: ['Self-Storage'], loc: ['US:CA'] };
    const counts = facetCounts(ctx, f);
    // Type ignores its own pick: CA has Vehicle Storage (b) and Retail (c).
    expect(counts.type.get('Vehicle Storage')).toBe(1);
    expect(counts.type.get('Retail')).toBe(1);
    expect(counts.type.get('Self-Storage') || 0).toBe(0);
    // Location ignores its own pick: Self-Storage is only in Texas.
    expect(counts.loc.get('US:TX')).toBe(1);
    expect(counts.loc.get('US:CA') || 0).toBe(0);
  });
  it('options list every value, None last, the stages in pipeline order', () => {
    const o = facetOptions(ctx);
    expect(o.stage.map((x) => x.key)).toEqual(['In Escrow', 'Entitlement', 'Stabilized', 'Stabilized - Renovation']);
    expect(o.manager.at(-1).key).toBe(NONE);
    expect(o.loc.map((c) => c.label)).toEqual(['United States', 'India']);
    expect(o.loc[0].states.map((s) => s.label)).toEqual(['California', 'Texas']);
  });
  it('words say the picks', () => {
    const w = filterWords({ type: ['Self-Storage', 'Vehicle Storage'], loc: ['US:CA'], acresMin: '3' }, facetOptions(ctx));
    expect(w.map((x) => `${x.title} ${x.words}`)).toEqual(['Type Self-Storage or Vehicle Storage', 'State California', 'Size over 3 acres']);
    expect(w[0].clear({ ...EMPTY_FILTERS, type: ['x'] }).type).toEqual([]);
  });
});

describe('the phrase parser (rules, no AI)', () => {
  const o = facetOptions(ctx);
  it('stabilized in TX over 3 acres', () => {
    const r = parsePhrase('stabilized in TX over 3 acres', o);
    expect(r.patch).toMatchObject({ stage: ['Stabilized'], loc: ['US:TX'], acresMin: '3' });
    expect(r.rest).toBe('');
  });
  it('no manager / self storage CA / tax due in december', () => {
    expect(parsePhrase('no manager', o).patch).toEqual({ manager: [NONE] });
    expect(parsePhrase('self storage CA', o).patch).toEqual({ type: ['Self-Storage'], loc: ['US:CA'] });
    expect(parsePhrase('tax due in december', o).patch).toEqual({ dueMonth: { cat: 'Property Tax', month: 12 } });
  });
  it('a city, a manager or an owner on file', () => {
    expect(parsePhrase('austin', o).patch).toEqual({ city: ['austin'] });
    expect(parsePhrase('neil kadakia', o).patch).toEqual({ manager: ['neil kadakia'] });
  });
  it('reads nothing from plain words', () => {
    expect(parsePhrase('greens', o)).toBeNull();
  });
  it('suggests Filter By, Properties and Inside Records', () => {
    const s = searchSuggestions('austin', ctx, o, { ...store, utilities: [{ propertyId: 'a', provider: 'Austin Energy', service: 'Electric' }] });
    expect(s.filterBy[0]).toMatchObject({ label: 'City is', value: 'Austin', count: 1 });
    expect(s.properties.map((a) => a.id)).toEqual(['a']);
    expect(s.records[0]).toMatchObject({ coll: 'utilities', title: 'Austin Energy', group: 'Utilities' });
  });
});

describe('views, presets and the address', () => {
  it('presets the other tabs open', () => {
    expect(presetView('no-manager').filters.manager).toEqual([NONE]);
    expect(presetView('mistyped-dates').filters.shows).toEqual(['mistyped']);
    expect(presetView('in-development').groupBy).toBe('stage');
    expect(presetView('nope')).toBeNull();
    expect(applyFilters(ctx, suggestedFilters('development')).map((a) => a.id).sort()).toEqual(['b', 'c', 'd']);
  });
  it('merges picks without losing the ones there', () => {
    const m = mergeFilters({ type: ['Retail'], q: 'x' }, { type: ['Land'], acresMin: '2' });
    expect(m.type).toEqual(['Retail', 'Land']);
    expect(m.acresMin).toBe('2');
    expect(m.q).toBe('x');
  });
  it('a view goes into the address and comes back the same', () => {
    const v = { id: 'u1', name: 'CA, Self Storage', filters: { ...EMPTY_FILTERS, q: 'not kept', type: ['Self-Storage', 'Office / Medical'], loc: ['US:CA'], acresMin: '3', dueMonth: { cat: 'Property Tax', month: 12 } }, groupBy: 'stage', sort: 'acres', mode: 'gallery' };
    const str = encodeView(v);
    expect(str).not.toMatch(/[/?#\s]/);
    const back = decodeView(str);
    expect(back).toMatchObject({ id: 'u1', name: 'CA, Self Storage', groupBy: 'stage', sort: 'acres', mode: 'gallery' });
    expect(back.filters).toMatchObject({ q: '', type: ['Self-Storage', 'Office / Medical'], loc: ['US:CA'], acresMin: '3', dueMonth: { cat: 'Property Tax', month: 12 } });
    expect(sameView(v, back)).toBe(true);
    expect(encodeView({ id: 'all', filters: EMPTY_FILTERS, groupBy: 'none', sort: 'name' })).toBe('');
    const sub = portfolioSub('properties', str);
    expect(parsePortfolioSub(sub)).toEqual({ tab: 'properties', view: str });
    expect(parsePortfolioSub('asset-portfolio')).toEqual({ tab: 'properties', view: '' });
    expect(parsePortfolioSub('asset-dates')).toEqual({ tab: 'dates', view: '' });
    expect(parsePortfolioSub('a:x:property')).toBeNull();
    expect(decodeView('junk;g=nope;zz')).toMatchObject({ groupBy: 'none', id: 'all' });
  });
});

describe('groups, sums and the summary', () => {
  it('a parcel group sums its parcels, and so do the groups', () => {
    expect(ctx.byId.b.measures).toMatchObject({ parcels: 2, sf: 119929, units: 802 });
    expect(ctx.byId.b.measures.acres).toBeCloseTo(30.79);
    const groups = groupRows(sortRows(ctx.rows, ctx, 'name'), ctx, 'stage');
    expect(groups.map((g) => g.label)).toEqual(['In Escrow', 'Entitlement', 'Stabilized', 'Stabilized - Renovation']);
    expect(groups[1].sums.units).toBe(802);
    expect(sumsOf(ctx.rows, ctx).units).toBe(1807);
  });
  it('sorts by size, biggest first', () => {
    expect(sortRows(ctx.rows, ctx, 'acres').map((a) => a.id)).toEqual(['b', 'a', 'c', 'd']);
  });
  it('one sentence, counts as words', () => {
    expect(summarySentence(ctx.rows, ctx)).toBe('4 properties in 3 states - 34 acres and 272,000 rentable square feet.');
    expect(summarySentence([ASSETS[0]], ctx)).toBe('1 property in Texas - 3 acres and 152,000 rentable square feet.');
  });
  it('what needs you: passed, no manager, mistyped - a mistyped date never counts as passed', () => {
    const n = needsOf(ctx.rows, ctx);
    expect(n).toMatchObject({ passed: 1, noManager: 1, mistyped: 1 });
    expect(n.items.map((d) => !!d.suspect)).toEqual([false, true]);
  });
});
