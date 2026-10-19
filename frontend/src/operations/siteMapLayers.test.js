import { describe, expect, it } from 'vitest';
import { DAYS_STOPS, MAINT, MARKET, OCC, QUIET, UNKNOWN, daysColor, hoverFact, layerColors, layerCounts, occupancyOf } from './siteMapLayers';

const units = [
  { n: 'C001', l: 1, r: 0, why: 'ACTIVE_LEASE', dvac: 0 },   // Cubby marks a leased unit unrentable: still leased
  { n: 'C002', l: 0, r: 1, dvac: 160 },
  { n: 'C003', l: 0, r: 0, why: 'DAMAGE' },
  { n: 'C004', l: 0, r: 1 },
];
const facts = {
  C002: { status: 'vacant', daysVacant: 160, rate: 9000, street: 9000, market: 'under', marketPct: -10, marketMedian: 10000, marketCount: 3 },
  C001: { status: 'rented', rent: 12000, rate: 12000, market: 'over', marketPct: 20, marketMedian: 10000, marketCount: 3 },
};

describe('layers', () => {
  it('occupancy puts a lease ahead of the rentability flag', () => {
    expect(occupancyOf(units[0])).toBe('leased');
    expect(layerColors('occupancy', units)).toEqual({ C001: OCC.leased, C002: OCC.vacant, C003: OCC.bad, C004: OCC.vacant });
  });
  it('days vacant is a gradient for vacant units only', () => {
    const c = layerColors('days', units, facts);
    expect(c.C001).toBe(QUIET);
    expect(c.C002).toBe(daysColor(160));
    expect(c.C004).toBe(UNKNOWN);
    expect(daysColor(0)).toBe(DAYS_STOPS[0][1]);
    expect(daysColor(400)).toBe(DAYS_STOPS.at(-1)[1]);
    expect(layerCounts('days', units, facts)).toEqual({ '120-179': 1, unknown: 1 });
  });
  it('market colors under, at and over', () => {
    const c = layerColors('market', units, facts);
    expect([c.C001, c.C002, c.C004]).toEqual([MARKET.over, MARKET.under, QUIET]);
    expect(hoverFact('market', units[1], facts)).toBe('$90 vs market $100 (10% under)');
  });
  it('maintenance marks units with open items, urgent ones red', () => {
    const maint = { connected: true, units: { C003: [{ id: 1, title: 'Door off track', priority: 'high' }], C004: [{ id: 2, title: 'Light out', priority: 'low' }] } };
    const c = layerColors('maintenance', units, facts, maint);
    expect([c.C001, c.C003, c.C004]).toEqual([QUIET, MAINT.urgent, MAINT.open]);
    expect(hoverFact('maintenance', units[2], facts, maint)).toBe('1 open item: Door off track');
  });
  it('says how long a unit has been empty', () => {
    expect(hoverFact('days', units[1], facts)).toBe('Vacant 160 days');
  });
});
