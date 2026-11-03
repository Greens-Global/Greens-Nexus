import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

// Items redesign (Neil, 11/02/2026) - one test per fixed bug and new rule:
// one cart, return dates, lost returns, force return conditions, the bell /
// dashboard handover sheet, Act As identity, the Activity Log on the server,
// Undo's own refusal, the Recycle Bin purge, import conflicts.

const NOW = new Date('2026-11-02T12:00:00');
const inv = {
  items: [], checkouts: [], itemsLoading: false, checkoutsLoading: false,
  submitCartCheckouts: vi.fn(), allocateItem: vi.fn(async () => ({})), initiateHandover: vi.fn(async () => ({})),
  refreshItems: vi.fn(), refreshCheckouts: vi.fn(), returnItem: vi.fn(async () => ({})),
};
vi.mock('../contexts/InventoryContext', () => ({ useInventory: () => inv }));
const role = { myEmail: 'erin@greensglobal.com', actingAs: null, manager: false };
vi.mock('../contexts/RoleContext', () => ({
  useRole: () => ({ can: () => role.manager, canAccessModule: () => role.manager, loading: false, myGrantedModules: new Map(), myEmail: role.myEmail, actingAs: role.actingAs }),
}));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }), useItemApprovers: () => ({ data: [] }) }));
const calls = {
  getItemCart: vi.fn(async () => []),
  addItemToCart: vi.fn(async (d) => ({ id: `srv-${d.item_id}` })),
  removeItemFromCart: vi.fn(async () => ({})),
  getItemTypeSettings: vi.fn(async () => [{ name: 'Tools', borrowable: true, loanCapDays: 5 }]),
  getItemApproversFor: vi.fn(async () => [{ email: 'mia@greensglobal.com', name: 'Mia Boss' }]),
  getItemsAuditLog: vi.fn(async () => ({ rows: [], total: 0 })),
  undoAuditEntry: vi.fn(),
  getDeletedItems: vi.fn(async () => []),
  deleteExpiredItems: vi.fn(async () => ({ deleted: 2, kept: 1 })),
};
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => calls[k] || vi.fn(async () => []) });
  return { api, default: api };
});

const cart = await import('./cart/useItemCart');
const { CartSheet } = await import('./borrow/CartSheet');
const { ReturnModal } = await import('./checkout/ReturnModal');
const { ExtendRequestModal } = await import('./checkout/ExtendRequestModal');
const { ForceReturnModal } = await import('./checkout/ForceReturnModal');
const HandOverSheet = (await import('./checkout/HandOverSheet')).default;
const { useItemsIdentity } = await import('./model/identity');
const { AuditLogPanel, localDayStart } = await import('./audit/AuditLogPanel');
const { DeletedItemsModal } = await import('./manage/DeletedItemsModal');
const { destinationFor } = await import('../components/NotificationBell');
const { HOLD_RECORD_MS, HOLD_MAJOR_MS } = await import('../ui/HoldButton');

const hold = async (el, ms) => {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1 });
  await act(async () => { vi.advanceTimersByTime(ms); });
};

beforeEach(() => { cart._resetCart(); });
afterEach(() => { cleanup(); vi.useRealTimers(); Object.values(calls).forEach(f => f.mockClear?.()); role.actingAs = null; role.myEmail = 'erin@greensglobal.com'; inv.checkouts = []; inv.items = []; });

function CartProbe() {
  const { cart: rows } = cart.useItemCart();
  return <div data-testid="cart">{rows.map(r => `${r.item.id}:${r.dueDate || '-'}`).join(',')}</div>;
}

describe('ONE cart', () => {
  it('every screen reads the same rows; a failed add rolls back and says so', async () => {
    render(<><CartProbe /><CartProbe /></>);
    await act(async () => { cart.addToCart({ id: 'a', name: 'Drill', itemType: 'Tools' }); });
    await waitFor(() => expect(screen.getAllByTestId('cart').map(n => n.textContent)).toEqual(['a:-', 'a:-']));
    act(() => cart.setCartDue('a', '2026-11-05'));
    expect(screen.getAllByTestId('cart')[0].textContent).toBe('a:2026-11-05');
    const onError = vi.fn();
    calls.addItemToCart.mockRejectedValueOnce(new Error('"Saw" is not currently available'));
    await act(async () => { cart.addToCart({ id: 'b', name: 'Saw' }, { onError }); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('"Saw" is not currently available'));
    expect(screen.getAllByTestId('cart')[1].textContent).toBe('a:2026-11-05');
  });
});

describe('Borrow asks for a return date', () => {
  it('each item needs a date inside its type cap, and the date goes to the server', async () => {
    inv.items = [{ id: 'a', name: 'Drill', itemType: 'Tools', department: 'Construction' }];
    inv.submitCartCheckouts = vi.fn(async (rows) => rows.map(() => ({ status: 'fulfilled' })));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    calls.getItemCart.mockResolvedValueOnce([{ id: 'srv-a', itemId: 'a', itemName: 'Drill', itemType: 'Tools' }]);
    render(<CartSheet onClose={() => {}} />);
    expect(await screen.findByText(/up to 11\/07\/2026/)).toBeTruthy();       // the Tools cap: 5 days
    const send = screen.getByRole('button', { name: /Request 1 Item/ });
    fireEvent.change(screen.getByLabelText('Why Do You Need It?'), { target: { value: 'Austin job' } });
    await screen.findByRole('option', { name: 'Mia Boss' });
    fireEvent.change(screen.getByLabelText('Who Approves It?'), { target: { value: 'mia@greensglobal.com' } });
    expect(send).toBeDisabled();                                                // no date yet
    act(() => cart.setCartDue('a', '2026-11-09'));                               // past the cap
    expect(screen.getByRole('button', { name: /Request 1 Item/ })).toBeDisabled();
    act(() => cart.setCartDue('a', '2026-11-06'));
    const ok = screen.getByRole('button', { name: /Request 1 Item/ });
    expect(ok).not.toBeDisabled();
    await act(async () => { fireEvent.click(ok); });
    expect(inv.submitCartCheckouts).toHaveBeenCalledTimes(1);
    const [rows, opts] = inv.submitCartCheckouts.mock.calls[0];
    expect(rows[0].dueDate).toBe('2026-11-06');
    expect(opts).toMatchObject({ reason: 'Austin job', approverEmail: 'mia@greensglobal.com', raisedByEmail: 'erin@greensglobal.com' });
    expect(calls.getItemApproversFor).toHaveBeenCalledWith('a');                // narrowed to the item's company
  });
});

describe('returns', () => {
  it('a lost temporary item is reported with no photo', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<ReturnModal checkout={{ id: 'c', itemName: 'Drill' }} onSubmit={onSubmit} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /Confirm Return/ })).toBeDisabled();   // Good needs the photo
    fireEvent.click(screen.getByRole('radio', { name: 'Lost' }));
    expect(screen.queryByText('Return Photo')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Where Was It Last Seen/), { target: { value: 'Austin site' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Report Lost/ })); });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ condition: 'lost', file: null, conditionNote: 'Austin site' }));
  });

  it('an extension picks a new date after the current due date', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<ExtendRequestModal checkout={{ id: 'c', itemName: 'Drill', status: 'allocated', dueDate: '2026-11-05', handedOverAt: '2026-11-01T10:00:00' }} onSubmit={onSubmit} onClose={() => {}} />);
    expect(screen.getByText(/is due 11\/05\/2026/)).toBeTruthy();
    expect(screen.getByText(/latest is 01\/30\/2027/)).toBeTruthy();             // the 90-day ceiling from the handover
  });

  it('Force Return asks the condition and is held to confirm', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ForceReturnModal checkout={{ id: 'c', itemName: 'Drill', requestedBy: 'Amy' }} onConfirm={onConfirm} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Lost' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Never came back' } });
    const btn = screen.getByRole('button', { name: /Hold to Check In/ });
    vi.useFakeTimers();
    await hold(btn, HOLD_RECORD_MS);
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledWith('Never came back', 'lost');
  });
});

describe('the bell and the dashboard hand over through the sheet', () => {
  it('opens the photo step instead of handing over with no photo', async () => {
    inv.checkouts = [{ id: 'c9', itemId: 'i9', itemName: 'Drill', status: 'approved', requestedBy: 'Amy Lee' }];
    inv.items = [{ id: 'i9', name: 'Drill', pictureRequired: true }];
    render(<HandOverSheet checkoutId="c9" onClose={() => {}} />);
    expect(await screen.findByText('Photos by You')).toBeTruthy();
    expect(inv.allocateItem).not.toHaveBeenCalled();
  });
  it('a request that moved on says so', async () => {
    inv.checkouts = [{ id: 'c9', status: 'allocated', itemName: 'Drill' }];
    render(<HandOverSheet checkoutId="c9" onClose={() => {}} />);
    expect(await screen.findByText(/nothing to hand over/)).toBeTruthy();
  });
  it('item bells deep-link to the new tabs; Pick a New Allocator opens the checkout', () => {
    expect(destinationFor({ type: 'checkout_pending' })).toEqual(['inventory', 'requests:approve']);
    expect(destinationFor({ type: 'allocate_request' })).toEqual(['inventory', 'requests:handover']);
    expect(destinationFor({ type: 'allocator_needed', refId: 'ICHK-1' })).toEqual(['inventory', 'requests:handover@co:ICHK-1']);
    expect(destinationFor({ type: 'perm_assign' })).toEqual(['inventory', 'mystuff']);
    expect(destinationFor({ type: 'perm_return' })).toEqual(['inventory', 'requests:returns']);
  });
});

describe('Act As', () => {
  function Who() { const { myEmail, myName } = useItemsIdentity(); return <span>{myEmail}|{myName}</span>; }
  it('is the person acted as, never the signed-in MSAL account', () => {
    role.myEmail = 'pranshu@greensglobal.com';
    role.actingAs = { targetEmail: 'pranshu@greensglobal.com', targetName: 'Pranshu Shah' };
    render(<Who />);
    expect(screen.getByText('pranshu@greensglobal.com|Pranshu Shah')).toBeTruthy();
  });
});

describe('the Activity Log', () => {
  it('sends the date range and the page to the server', async () => {
    render(<AuditLogPanel items={[]} />);
    await waitFor(() => expect(calls.getItemsAuditLog).toHaveBeenCalled());
    expect(calls.getItemsAuditLog.mock.calls[0][0]).toMatchObject({ limit: 100, offset: 0 });
    expect(localDayStart('2026-11-01')).toBe(new Date(2026, 10, 1).toISOString());
    expect(localDayStart('2026-11-01', 1)).toBe(new Date(2026, 10, 2).toISOString());
  });
  it("Undo shows the server's own refusal on the entry", async () => {
    const row = { id: 7, timestamp: '2026-11-01T10:00:00', user_email: 'mia@greensglobal.com', action: 'Updated item', resource_type: 'items', resource_id: 'i1',
      details: JSON.stringify({ path: '/items/i1', name: 'Drill 2' }) };
    const base = { id: 6, timestamp: '2026-10-01T10:00:00', user_email: 'mia@greensglobal.com', action: 'Added item', resource_type: 'items', resource_id: 'i1',
      details: JSON.stringify({ path: '/items', name: 'Drill' }) };
    calls.getItemsAuditLog.mockResolvedValue({ rows: [row, base], total: 2 });
    calls.undoAuditEntry.mockRejectedValueOnce(new Error('This item was changed again since - undo the newer change first'));
    render(<AuditLogPanel items={[{ id: 'i1', name: 'Drill 2' }]} />);
    const undo = (await screen.findAllByTitle('Undo this change'))[0];
    fireEvent.click(undo);
    const bar = (await screen.findByRole('button', { name: 'Cancel' })).parentElement;
    await act(async () => { fireEvent.click(within(bar).getByRole('button', { name: /Undo/ })); });
    await waitFor(() => expect(calls.undoAuditEntry).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveTextContent('This item was changed again since - undo the newer change first');
    expect(screen.queryByText('Could not load the activity log.')).toBeNull();
  });
});

describe('the Recycle Bin', () => {
  it('Delete Expired Forever is held (many records) and calls the purge', async () => {
    calls.getDeletedItems.mockResolvedValueOnce([{ id: 'x', name: 'Old Saw', deletedAt: '2026-09-01T00:00:00Z' }]);
    const toast = vi.fn();
    render(<DeletedItemsModal onClose={() => {}} onRestored={() => {}} toast={toast} />);
    const btn = await screen.findByRole('button', { name: /Delete Expired Forever/ });
    vi.useFakeTimers();
    await hold(btn, HOLD_MAJOR_MS);
    await act(async () => {});
    expect(calls.deleteExpiredItems).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('1 kept'));
  });

});
