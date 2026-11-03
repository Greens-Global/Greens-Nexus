import { describe, it, expect, vi } from 'vitest';
import { resolveScannedCode, findLocalItem, searchItems, ggSerial } from './resolve';

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

  it('an item link from another host is looked up by its id alone (review M1)', async () => {
    const fetchByCode = vi.fn(async () => { throw notFound(); });
    expect((await resolveScannedCode('https://dev.nexus.example.com/itemmanagement/item/it-a', { items: ITEMS, fetchByCode })).item.id).toBe('it-a');
    expect(await resolveScannedCode('https://elsewhere.example/itemmanagement/item/x9', { items: ITEMS, fetchByCode })).toEqual({ status: 'denied', id: 'x9' });
    expect(fetchByCode).toHaveBeenCalledWith('x9');
  });

  it('a loose serial that fits several items asks the person to pick (review L6)', async () => {
    const twins = [...ITEMS, { id: 'it-old2', name: 'Old Ladder Two', serialNumber: 'AT-7781X' }];
    const fetchByCode = vi.fn();
    const r = await resolveScannedCode('at7781x', { items: twins, fetchByCode });
    expect(r.status).toBe('several');
    expect(r.items.map((i) => i.id)).toEqual(['it-old', 'it-old2']);
    expect(fetchByCode).not.toHaveBeenCalled();
    // ...and the server's 409 with its choices reads the same.
    const choices = [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }];
    const r2 = await resolveScannedCode('zz 1', { items: ITEMS, fetchByCode: async () => { throw Object.assign(new Error('Several items match - pick one'), { status: 409, body: { message: 'x', choices } }); } });
    expect(r2).toEqual({ status: 'several', items: choices, code: 'zz 1' });
  });

  it('the GG-digits expansion wins over a loose match (review L6)', async () => {
    expect(ggSerial('gg 42')).toBe('GG-00042');
    expect(ggSerial('42')).toBe('GG-00042');
    expect(ggSerial('AT-1')).toBe('');
    const odd = [...ITEMS, { id: 'it-42', name: 'Odd Tag', serialNumber: '4-2' }];
    expect((await resolveScannedCode('42', { items: odd })).item.id).toBe('it-a');
  });

  it('a page that is not an item link and an empty code never reach the server', async () => {
    const fetchByCode = vi.fn();
    expect((await resolveScannedCode('https://evil.example/some/page', { items: ITEMS, origin: ORIGIN, fetchByCode })).status).toBe('foreign');
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
