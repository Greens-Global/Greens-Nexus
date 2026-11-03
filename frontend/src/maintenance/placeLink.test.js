import { describe, it, expect } from 'vitest';
import { parsePlacePath, parsePlaceSub, placeSub, placePath, placeUrl } from './placeLink';
import { parseScannedCode } from '../inventory/scan/itemLink';
import { resolveScannedCode } from '../inventory/scan/resolve';
import { ticketPlaceSub } from '../lib/routes';
import { queueMatches, queueCounts, preventiveOverdue, QUEUES } from '../tickets/queues';
import { presetDue } from '../asset/lib/pmSchedule';

// Scan to Request (11/03/2026): a site or equipment tag is a place link, and
// the ONE Items scanner recognizes it; the address bar turns it into the
// Tickets sub and back. The desk's Preventive queue counts what is overdue.
describe('place links', () => {
  it('builds and reads a site and an equipment link', () => {
    expect(placePath('gst')).toBe('/tickets/place/gst');
    expect(placePath('gst', 'truck 1')).toBe('/tickets/place/gst/truck%201');
    expect(placeUrl('gst', 'lift', 'https://nexus.example.com/')).toBe('https://nexus.example.com/tickets/place/gst/lift');
    expect(parsePlacePath('/tickets/place/gst/truck%201')).toEqual({ propertyId: 'gst', assetId: 'truck 1' });
    expect(parsePlacePath('/tickets/place/gst')).toEqual({ propertyId: 'gst', assetId: '' });
    expect(parsePlacePath('/tickets')).toBeNull();
    expect(parsePlaceSub(placeSub('gst', 'lift'))).toEqual({ propertyId: 'gst', assetId: 'lift' });
    expect(parsePlaceSub('item/x')).toBeNull();
  });

  it('turns the address into the Tickets sub', () => {
    expect(ticketPlaceSub('tickets', ['tickets', 'place', 'gst', 'lift'])).toBe('place/gst/lift');
    expect(ticketPlaceSub('tickets', ['tickets', 'place', 'gst'])).toBe('place/gst');
    expect(ticketPlaceSub('tickets', ['tickets', 'place'])).toBeNull();
    expect(ticketPlaceSub('inventory', ['inventory', 'place', 'gst'])).toBeNull();
  });

  it('is recognized by the Items scanner on any host, an item link still an item', async () => {
    expect(parseScannedCode('https://dev.nexus.example.com/tickets/place/gst/lift')).toEqual({ kind: 'place', propertyId: 'gst', assetId: 'lift' });
    expect(parseScannedCode('https://nexus.example.com/itemmanagement/item/abc').kind).toBe('item');
    expect(parseScannedCode('https://example.com/somewhere').kind).toBe('foreign');
    const r = await resolveScannedCode('https://nexus.example.com/tickets/place/gst', { items: [], fetchByCode: () => { throw new Error('never asked'); } });
    expect(r).toEqual({ status: 'place', propertyId: 'gst', assetId: '' });
  });
});

describe('the Preventive queue', () => {
  const now = new Date(2026, 10, 3, 12).getTime();
  const live = { status: 'open', serviceId: 'svc', pmDueOn: '2026-11-01' };
  it('holds live preventive tickets and counts the overdue ones', () => {
    expect(QUEUES.find((q) => q.key === 'preventive').hideWhenEmpty).toBe(true);
    expect(queueMatches('preventive', live, { now })).toBe(true);
    expect(queueMatches('preventive', { ...live, status: 'resolved' }, { now })).toBe(false);
    expect(queueMatches('preventive', { status: 'open' }, { now })).toBe(false);
    expect(preventiveOverdue(live, now)).toBe(true);
    expect(preventiveOverdue({ ...live, pmDueOn: '2026-11-03' }, now)).toBe(false);
    const counts = queueCounts([live, { ...live, pmDueOn: '2026-12-01' }, { status: 'open' }], { now, me: '' });
    expect(counts.preventive).toBe(2);
    expect(counts.preventiveOverdue).toBe(1);
  });
});

describe('schedule presets', () => {
  it('finds the next 1st, Monday and quarter start', () => {
    const tue = new Date(2026, 10, 3);   // Tuesday 11/03/2026
    expect(presetDue('monthly1', tue)).toEqual({ unit: 'month', every: 1, nextDue: '2026-12-01' });
    expect(presetDue('mondays', tue)).toEqual({ unit: 'week', every: 1, nextDue: '2026-11-09' });
    expect(presetDue('quarterly', tue)).toEqual({ unit: 'month', every: 3, nextDue: '2027-01-01' });
    expect(presetDue('mondays', new Date(2026, 10, 9)).nextDue).toBe('2026-11-16');   // a Monday: the next one
  });
});
