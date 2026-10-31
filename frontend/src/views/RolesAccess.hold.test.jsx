import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Hold to confirm on Access (Neil, Oct 30 2026): deleting one group and taking
// one person out of a group are single records - held on the button with no
// dialog, Remove offering Undo through the same add call; setting the
// approver for a whole role overwrites everyone's manager, so its dialog says
// so and its button is a 1.8 s hold that waits for the server.

const dir = [{ email: 'p1@example.com', display_name: 'Person 01' }, { email: 'p2@example.com', display_name: 'Person 02' }];
vi.mock('../lib/queries', () => ({ usePeopleDirectory: () => ({ data: dir }) }));
const GROUP = { id: 'g1', name: 'Payroll Viewers', members: ['p1@example.com'], member_count: 1, allowed_modules: [] };
const calls = {
  getGroups: vi.fn(() => Promise.resolve([GROUP])),
  getEffectiveAccess: vi.fn(() => Promise.resolve({ email: 'p1@example.com', job_role: null, extra_groups: [{ id: 'g1', name: 'Payroll Viewers' }], modules: [] })),
  deleteGroup: vi.fn(() => Promise.resolve({})),
  removeGroupMember: vi.fn(() => Promise.resolve({})),
  addGroupMembers: vi.fn(() => Promise.resolve({})),
  applyJobRoleManager: vi.fn(() => Promise.resolve({ updated: 3 })),
};
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => calls[k] || vi.fn(() => Promise.resolve([])) }),
}));
vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));
vi.mock('../contexts/RoleContext', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useRole: () => ({ can: () => true, myRole: 'owner', myEmail: 'me@example.com' }) };
});

const { default: RolesAccess, ApproverPicker } = await import('./RolesAccess');
const { DialogHost } = await import('../ui/dialog');
const { HOLD_MAJOR_MS, HOLD_RECORD_MS } = await import('../ui/HoldButton');

// The person panel scrolls itself into view; jsdom has no layout.
window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || function scrollIntoView() {};

afterEach(() => { cleanup(); vi.useRealTimers(); Object.values(calls).forEach((f) => f.mockClear()); });

const hold = async (el, ms) => {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1 });
  await act(async () => { vi.advanceTimersByTime(ms); });
};

describe('Access holds', () => {
  it('Delete group is held on the card, with no dialog', async () => {
    render(<><DialogHost /><RolesAccess embedded /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Groups' }));
    const btn = await screen.findByRole('button', { name: 'Delete group Payroll Viewers, press and hold' });
    vi.useFakeTimers();
    await hold(btn, HOLD_RECORD_MS);
    expect(calls.deleteGroup).toHaveBeenCalledWith('g1');
    expect(screen.queryByRole('dialog')).toBeNull();
    const reads = calls.getGroups.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(calls.getGroups.mock.calls.length).toBe(reads + 1);
  });

  it('Remove from group is held on the chip, and Undo adds them back', async () => {
    render(<><DialogHost /><RolesAccess embedded /></>);
    fireEvent.click(await screen.findByText('Person 01'));
    const btn = await screen.findByRole('button', { name: 'Remove from Payroll Viewers, press and hold' });
    vi.useFakeTimers();
    await hold(btn, HOLD_RECORD_MS);
    await act(async () => {});
    expect(calls.removeGroupMember).toHaveBeenCalledWith('g1', 'p1@example.com');
    vi.useRealTimers();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.addGroupMembers).toHaveBeenCalledWith('g1', ['p1@example.com']));
  });

  it('Apply to all members opens a held dialog that waits for the server', async () => {
    const onSaved = vi.fn(); const toastOk = vi.fn();
    const role = { id: 'r1', name: 'Cashier', default_manager_email: 'sai@x.com', member_count: 3 };
    render(<><DialogHost /><ApproverPicker role={role} people={[{ email: 'sai@x.com', name: 'Sai Patel' }]} nameOf={() => 'Sai Patel'} onSaved={onSaved} toastOk={toastOk} toastErr={() => {}} /></>);
    fireEvent.click(screen.getByRole('button', { name: /Apply to all 3 members/ }));
    expect(await screen.findByText(/This overwrites their current manager/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'Set For All, press and hold' });
    vi.useFakeTimers();
    await hold(btn, HOLD_MAJOR_MS - 300);
    expect(calls.applyJobRoleManager).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(calls.applyJobRoleManager).toHaveBeenCalledTimes(1);
    expect(calls.applyJobRoleManager).toHaveBeenCalledWith('r1', 'sai@x.com');
    expect(toastOk).toHaveBeenCalledWith('Sai Patel is now the approver for 3 people in “Cashier”.');
    expect(onSaved).toHaveBeenCalled();
  });
});
