import { describe, it, expect, vi } from 'vitest';

vi.mock('../api', () => ({ api: {} }));
const { defaultSendEntityId } = await import('./ESign');

// A new signature request's Company defaults to the sender's own company (from
// People), else Greens Global - never just the first entity in the list.

const ENTITIES = [
  { id: 'aarav', name: 'Aarav Construction' },
  { id: 'gg', name: 'Greens Global' },
  { id: 'gs', name: 'Greens Storage' },
];
const EMPLOYEES = [
  { workEmail: 'Sagar.Shoundik@greensglobal.com', company: 'gs' },
  { workEmail: 'nobody@greensglobal.com', company: 'gone' },
];

describe('defaultSendEntityId', () => {
  it("uses the sender's company from People", () => {
    expect(defaultSendEntityId(ENTITIES, EMPLOYEES, 'sagar.shoundik@greensglobal.com')).toBe('gs');
  });
  it('falls back to Greens Global when the sender has no company on file', () => {
    expect(defaultSendEntityId(ENTITIES, EMPLOYEES, 'someone.else@greensglobal.com')).toBe('gg');
    expect(defaultSendEntityId(ENTITIES, [], '')).toBe('gg');
  });
  it("ignores a company id that isn't in the entity list", () => {
    expect(defaultSendEntityId(ENTITIES, EMPLOYEES, 'nobody@greensglobal.com')).toBe('gg');
  });
  it('first entity only when there is no Greens Global at all', () => {
    expect(defaultSendEntityId([{ id: 'x', name: 'X Corp' }], [], '')).toBe('x');
    expect(defaultSendEntityId([], [], '')).toBe('');
  });
});
