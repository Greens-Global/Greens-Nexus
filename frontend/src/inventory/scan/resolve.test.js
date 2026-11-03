import { describe, it, expect, vi } from 'vitest';
import { resolveScannedCode, findLocalItem, searchItems } from './resolve';

// Items phase 4: a scanned or typed code is matched to the screen's own
// items first, then the server (GET /items/by-code, walled - 404 outside
// the person's companies).

const ORIGIN = 'https://nexus.example.com';
const ITEMS = [
  { id: 'it-a', name: 'Hammer Drill', serialNumber: 'GG-00042' },
  { id: 'it-b', name: 'Laser Level', serialNumber: 'GG-00043' },
  { id: 'it-old', name: 'Old Ladder', serialNumber: 'AT 7781-X' },
];
const notFound = () => Object.assign(new Error('No item you can see matches that code'), { status: 404 });

describe('code resolution', () => {
  it('matches the item link, the id and the serial from the screen first', async () => {
    const fetchByCode = vi.fn();
    const opts = { items: ITEMS, origin: ORIGIN, fetchByCode };
    expect(await resolveScannedCode(`${ORIGIN}/itemmanagement/item/it-b`, opts)).toEqual({ status: 'found', item: ITEMS[1], via: 'local' });
    expect((await resolveScannedCode('it-a', opts)).item.id).toBe('it-a');
    expect((await resolveScannedCode('gg-00042', opts)).item.id).toBe('it-a');
    expect((await resolveScannedCode('at7781x', opts)).item.id).toBe('it-old');
    expect(fetchByCode).not.toHaveBeenCalled();
  });

  it('asks the server when the screen does not hold it', async () => {
    const fetchByCode = vi.fn(async () => ({ id: 'it-z', name: 'Generator' }));
    const r = await resolveScannedCode('gg 99', { items: ITEMS, origin: ORIGIN, fetchByCode });
    expect(fetchByCode).toHaveBeenCalledWith('gg 99');
    expect(r).toEqual({ status: 'found', item: { id: 'it-z', name: 'Generator' }, via: 'server' });
  });

  it('a link the server walls off is "denied", sent as the bare id', async () => {
    const fetchByCode = vi.fn(async () => { throw notFound(); });
    const r = await resolveScannedCode(`${ORIGIN}/itemmanagement/item/other-co`, { items: ITEMS, origin: ORIGIN, fetchByCode });
    expect(fetchByCode).toHaveBeenCalledWith('other-co');
    expect(r).toEqual({ status: 'denied', id: 'other-co' });
  });

  it('any other miss is "unknown"', async () => {
    const r = await resolveScannedCode('NOPE-1', { items: ITEMS, origin: ORIGIN, fetchByCode: async () => { throw notFound(); } });
    expect(r).toEqual({ status: 'unknown', code: 'NOPE-1' });
  });

  it('a server that cannot be reached is an error, not "unknown"', async () => {
    const r = await resolveScannedCode('NOPE-1', { items: ITEMS, origin: ORIGIN, fetchByCode: async () => { throw Object.assign(new Error('Network down'), { status: 503 }); } });
    expect(r).toEqual({ status: 'error', message: 'Network down' });
  });

  it('another site\'s link and an empty code never reach the server', async () => {
    const fetchByCode = vi.fn();
    expect((await resolveScannedCode('https://evil.example/itemmanagement/item/it-a', { items: ITEMS, origin: ORIGIN, fetchByCode })).status).toBe('foreign');
    expect((await resolveScannedCode('   ', { items: ITEMS, origin: ORIGIN, fetchByCode })).status).toBe('empty');
    expect(fetchByCode).not.toHaveBeenCalled();
  });

  it('findLocalItem ignores a short loose match', () => {
    expect(findLocalItem(ITEMS, { kind: 'code', code: 'x' })).toBeNull();
    expect(findLocalItem(null, { kind: 'item', id: 'it-a' })).toBeNull();
  });
});

describe('the Type a Serial search', () => {
  it('ranks an exact serial first, then serial and name matches', () => {
    expect(searchItems(ITEMS, 'GG-00042').map((i) => i.id)).toEqual(['it-a']);
    expect(searchItems(ITEMS, 'gg000').map((i) => i.id)).toEqual(['it-a', 'it-b']);
    expect(searchItems(ITEMS, 'lad').map((i) => i.id)).toEqual(['it-old']);
    expect(searchItems(ITEMS, '')).toEqual([]);
  });
});
