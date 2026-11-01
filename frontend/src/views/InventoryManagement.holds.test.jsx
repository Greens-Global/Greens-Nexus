import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Item Management, Hold to confirm (Neil, Oct 30 2026): removing an item type
// and deleting a custom field are single records - held on the row with no
// inline Cancel / Remove step; a type comes back through Undo (the same add
// call), a refusal rewinds the button with the reason.

vi.mock('../contexts/InventoryContext', () => ({ useInventory: () => ({}) }));
vi.mock('../contexts/NotificationContext', () => ({ useNotifications: () => ({ addNotification: vi.fn(), notifications: [] }) }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, canAccessModule: () => true, loading: false, myGrantedModules: new Map(), myEmail: 'erin@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [] }) }));
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: [] }), useItemApprovers: () => ({ data: [] }) }));
const calls = {
  deleteItemType: vi.fn(async () => ['Devices', 'Other']),
  addItemType: vi.fn(async () => ['Devices', 'Vehicles', 'Other']),
  deleteItemCustomField: vi.fn(async () => ({ ok: true })),
};
vi.mock('../api', () => {
  const api = new Proxy({}, { get: (_, k) => calls[k] || vi.fn(async () => []) });
  return { api, default: api };
});

const { ManageTypesModal, CustomFieldsAdminModal } = await import('./InventoryManagement');
const { DialogHost } = await import('../ui/dialog');
const { HOLD_RECORD_MS } = await import('../ui/HoldButton');

afterEach(() => { cleanup(); vi.useRealTimers(); Object.values(calls).forEach((f) => f.mockClear()); });

const hold = async (el) => {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1 });
  await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
};

describe('Manage Item Types', () => {
  it('removes a type on a full hold, and Undo adds it back', async () => {
    const onChanged = vi.fn();
    render(<><DialogHost /><ManageTypesModal types={['Devices', 'Vehicles', 'Other']} counts={{ Vehicles: 2 }} onClose={() => {}} onChanged={onChanged} toast={() => {}} /></>);
    expect(screen.queryByRole('button', { name: /Remove type Other/ })).toBeNull();     // the fallback type stays
    const btn = screen.getByRole('button', { name: 'Remove type Vehicles, press and hold' });
    vi.useFakeTimers();
    fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(calls.deleteItemType).not.toHaveBeenCalled();
    await hold(btn);
    await act(async () => {});
    expect(calls.deleteItemType).toHaveBeenCalledWith('Vehicles');
    expect(onChanged).toHaveBeenCalledWith(['Devices', 'Other']);
    vi.useRealTimers();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.addItemType).toHaveBeenCalledWith('Vehicles'));
  });
});

describe('Custom Fields', () => {
  const fields = [{ id: 'f1', label: 'Asset Tag', fieldType: 'text', appliesToType: '' }];

  it('deletes a field on a full hold, then re-reads', async () => {
    const onChanged = vi.fn();
    render(<CustomFieldsAdminModal fields={fields} onClose={() => {}} onChanged={onChanged} toast={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Delete the Asset Tag field, press and hold' });
    vi.useFakeTimers();
    await hold(btn);
    expect(calls.deleteItemCustomField).toHaveBeenCalledWith('f1');
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(onChanged).toHaveBeenCalled();
  });

  it('a refused delete rewinds with the reason', async () => {
    calls.deleteItemCustomField.mockRejectedValueOnce(new Error('Only an items admin may delete fields.'));
    const onChanged = vi.fn();
    render(<CustomFieldsAdminModal fields={fields} onClose={() => {}} onChanged={onChanged} toast={() => {}} />);
    vi.useFakeTimers();
    await hold(screen.getByRole('button', { name: 'Delete the Asset Tag field, press and hold' }));
    expect(screen.getByRole('alert').textContent).toBe('Only an items admin may delete fields.');
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
