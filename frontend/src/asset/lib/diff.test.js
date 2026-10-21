import { describe, it, expect } from 'vitest';
import { diffStore, mergeOps, opsEmpty } from './diff.js';

const base = { properties: [{ id: 'a', name: 'A', _rev: 'r1' }, { id: 'b', name: 'B', _rev: 'r1' }], warranties: [{ id: 'w1', propertyId: 'a', item: 'Roof' }], logs: [{ id: 'l1' }] };

describe('diffStore', () => {
  it('is null when nothing changed', () => {
    expect(diffStore(base, { ...base })).toBeNull();
  });
  it('sends only the rows that changed, keeping the _rev they were read with', () => {
    const next = { ...base, properties: [{ id: 'a', name: 'A2', _rev: 'r1' }, base.properties[1]], warranties: [], logs: [...base.logs, { id: 'l2' }] };
    const ops = diffStore(base, next);
    expect(ops.properties).toEqual({ upsert: [{ id: 'a', name: 'A2', _rev: 'r1' }], delete: [] });
    expect(ops.warranties).toEqual({ upsert: [], delete: ['w1'] });
    expect(ops.logs).toEqual({ append: [{ id: 'l2' }] });
    expect(ops.inspections).toBeUndefined();
  });
  it('ignores a rev-only refresh', () => {
    expect(diffStore(base, { ...base, properties: [{ ...base.properties[0], _rev: 'r2' }, base.properties[1]] })).toBeNull();
  });
  it('sees a new row as an upsert', () => {
    const ops = diffStore(base, { ...base, inspections: [{ id: 'i1', propertyId: 'a' }] });
    expect(ops.inspections.upsert).toHaveLength(1);
  });
});

describe('mergeOps', () => {
  it('lets a later upsert replace an earlier one and a delete cancel an upsert', () => {
    let q = mergeOps(null, { properties: { upsert: [{ id: 'a', name: 'A1' }], delete: [] } });
    q = mergeOps(q, { properties: { upsert: [{ id: 'a', name: 'A2' }, { id: 'c', name: 'C' }], delete: [] } });
    q = mergeOps(q, { properties: { upsert: [], delete: ['c'] }, logs: { append: [{ id: 'l1' }] } });
    expect(q.properties.upsert).toEqual([{ id: 'a', name: 'A2' }]);
    expect(q.properties.delete).toEqual(['c']);
    q = mergeOps(q, { properties: { upsert: [{ id: 'c', name: 'C back' }], delete: [] }, logs: { append: [{ id: 'l1' }, { id: 'l2' }] } });
    expect(q.properties.delete).toEqual([]);
    expect(q.properties.upsert.map((r) => r.id)).toEqual(['a', 'c']);
    expect(q.logs.append.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(opsEmpty(q)).toBe(false);
    expect(opsEmpty(null)).toBe(true);
    expect(opsEmpty({ properties: { upsert: [], delete: [] } })).toBe(true);
  });
});
