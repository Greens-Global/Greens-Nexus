import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';

// Items redesign (11/02/2026): a refresh asked for while a fetch is in flight
// is queued and run once the fetch lands (it used to be dropped, so a save's
// own refresh lost to the poll's older snapshot) - the same rule as
// useAssignments' _asgRefetchQueued. And the cart sends the picked return date.

let resolveItems = [];
const calls = {
  getItems: vi.fn(() => new Promise((res) => { resolveItems.push(res); })),
  getItemCheckouts: vi.fn(async () => []),
  getItemsSignature: vi.fn(async () => ({ items: '', checkouts: '' })),
  createItemCheckout: vi.fn(async (d) => ({ id: 'srv', ...d })),
};
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => calls[k] || vi.fn(async () => []) });
  return { api, default: api };
});
vi.mock('../lib/supabase', () => ({ supabase: null }));

const { InventoryProvider, useInventory } = await import('./InventoryContext');

let ctx = null;
function Grab() { ctx = useInventory(); return null; }

afterEach(() => { cleanup(); resolveItems = []; Object.values(calls).forEach(f => f.mockClear()); });

describe('InventoryContext', () => {
  it('queues a refresh that arrives during a fetch and runs it once', async () => {
    render(<InventoryProvider><Grab /></InventoryProvider>);
    expect(calls.getItems).toHaveBeenCalledTimes(1);          // the mount fetch, still in flight
    act(() => { ctx.refreshItems(); ctx.refreshItems(); });   // two asks while in flight
    expect(calls.getItems).toHaveBeenCalledTimes(1);
    await act(async () => { resolveItems[0]([]); });
    expect(calls.getItems).toHaveBeenCalledTimes(2);          // exactly one follow-up
    await act(async () => { resolveItems[1]([]); });
    expect(calls.getItems).toHaveBeenCalledTimes(2);
  });

  it('a cart row sends its return date', async () => {
    render(<InventoryProvider><Grab /></InventoryProvider>);
    await act(async () => { resolveItems[0]?.([]); });
    await act(async () => {
      await ctx.submitCartCheckouts([{ item: { id: 'i1', name: 'Drill', itemType: 'Tools' }, dueDate: '2026-11-09' }],
        { reason: 'Job', raisedBy: 'Erin', raisedByEmail: 'erin@greensglobal.com' });
    });
    expect(calls.createItemCheckout).toHaveBeenCalledWith(expect.objectContaining({ due_date: '2026-11-09', item_id: 'i1', requested_by_email: 'erin@greensglobal.com' }));
  });
});
