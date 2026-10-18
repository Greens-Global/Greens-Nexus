import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Delegate My Approvals (Oct 17 2026): the Workday card (pick a stand-in,
// dates, note; current/upcoming with Revoke; who you cover), the HR admin list
// and the "For <delegator>" chip.

const mine = vi.fn();
const create = vi.fn();
const revoke = vi.fn();
const all = vi.fn();
const createFor = vi.fn();
const people = vi.fn();
vi.mock('../api', () => ({
  api: {
    approvalDelegationsMine: (...a) => mine(...a),
    approvalDelegationCreate: (...a) => create(...a),
    approvalDelegationRevoke: (...a) => revoke(...a),
    approvalDelegationsAll: (...a) => all(...a),
    approvalDelegationCreateFor: (...a) => createFor(...a),
    getPeopleDirectory: (...a) => people(...a),
  },
}));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'max@x.com' }) }));

const { default: DelegateApprovalsCard, ApprovalDelegationsAdmin, ForChip } = await import('./DelegateApprovals');

const deleg = (over) => ({
  id: 'd1', delegatorEmail: 'max@x.com', delegatorName: 'Max Test', delegateEmail: 'dee@x.com', delegateName: 'Dee Test',
  startDate: '2026-10-20', endDate: '2026-10-27', note: 'Vacation', state: 'upcoming', ...over,
});

beforeEach(() => {
  mine.mockReset().mockResolvedValue({ canDelegate: true, delegations: [], covering: [] });
  create.mockReset().mockResolvedValue({});
  revoke.mockReset().mockResolvedValue({});
  all.mockReset().mockResolvedValue([]);
  createFor.mockReset().mockResolvedValue({});
  people.mockReset().mockResolvedValue([
    { email: 'max@x.com', name: 'Max Test' }, { email: 'dee@x.com', name: 'Dee Test' }, { email: 'pia@x.com', name: 'Pia Test' },
  ]);
});

describe('DelegateApprovalsCard', () => {
  it('renders nothing for someone with nothing to approve', async () => {
    mine.mockResolvedValue({ canDelegate: false, delegations: [], covering: [] });
    const { container } = render(<DelegateApprovalsCard />);
    await waitFor(() => expect(mine).toHaveBeenCalled());
    expect(container.querySelector('[data-card="delegate-approvals"]')).toBeNull();
  });

  it('picks a person from Nexus People, sets the dates and delegates', async () => {
    render(<DelegateApprovalsCard />);
    expect(await screen.findByText('Delegate My Approvals')).toBeTruthy();
    const box = await screen.findByRole('combobox');
    fireEvent.focus(box);
    // The caller is never offered as their own stand-in.
    expect(screen.queryByRole('option', { name: /Max Test/ })).toBeNull();
    fireEvent.mouseDown(screen.getByRole('option', { name: /Dee Test/ }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-27' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Vacation' } });
    fireEvent.click(screen.getByRole('button', { name: /Delegate/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      delegate_email: 'dee@x.com', start_date: '2026-10-20', end_date: '2026-10-27', note: 'Vacation',
    }));
    expect(mine).toHaveBeenCalledTimes(2);   // reloaded after saving
  });

  it('keeps Delegate off until the range makes sense', async () => {
    render(<DelegateApprovalsCard />);
    const box = await screen.findByRole('combobox');
    fireEvent.focus(box);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Dee Test/ }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-27' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-20' } });
    expect(screen.getByRole('button', { name: /Delegate/ }).disabled).toBe(true);
    expect(screen.getByText('The last day is before the first day.')).toBeTruthy();
  });

  it("shows the server's refusal as is", async () => {
    create.mockRejectedValue(new Error('Dee Test already covers 10/20/2026 - 10/27/2026. Revoke that first, or pick days that don\'t overlap.'));
    render(<DelegateApprovalsCard />);
    fireEvent.focus(await screen.findByRole('combobox'));
    fireEvent.mouseDown(screen.getByRole('option', { name: /Dee Test/ }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2099-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: /Delegate/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already covers/);
  });

  it('lists current and upcoming delegations with Revoke, and who you cover', async () => {
    mine.mockResolvedValue({
      canDelegate: true, delegations: [deleg()],
      covering: [deleg({ id: 'd2', delegatorEmail: 'olive@x.com', delegatorName: 'Olive Test', delegateEmail: 'max@x.com', state: 'active' })],
    });
    render(<DelegateApprovalsCard />);
    expect(await screen.findByText('Dee Test')).toBeTruthy();
    expect(screen.getByText(/10\/20\/2026 - 10\/27\/2026/, { selector: '[data-delegation="d1"] *' })).toBeTruthy();
    expect(screen.getByText('Upcoming')).toBeTruthy();
    expect(screen.getByText('You Are Covering')).toBeTruthy();
    expect(screen.getByText('Olive Test')).toBeTruthy();
    // Revoke on mine only - a covering row is not theirs to revoke.
    const buttons = screen.getAllByRole('button', { name: 'Revoke' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('d1'));
  });

  it('a stand-in with nothing of their own to approve still sees who they cover', async () => {
    mine.mockResolvedValue({ canDelegate: false, delegations: [], covering: [deleg({ state: 'active' })] });
    render(<DelegateApprovalsCard />);
    expect(await screen.findByText('You Are Covering')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('ApprovalDelegationsAdmin', () => {
  it('lists everyone and sets one for someone', async () => {
    all.mockResolvedValue([deleg({ state: 'active' })]);
    render(<ApprovalDelegationsAdmin />);
    expect(await screen.findByText('Max Test - covered by Dee Test')).toBeTruthy();
    const [whose, by] = await screen.findAllByRole('combobox');
    fireEvent.focus(whose);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Pia Test/ }));
    fireEvent.focus(by);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Dee Test/ }));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2099-01-02' } });
    fireEvent.click(screen.getByRole('button', { name: /Delegate/ }));
    await waitFor(() => expect(createFor).toHaveBeenCalledWith(expect.objectContaining({
      delegator_email: 'pia@x.com', delegate_email: 'dee@x.com', end_date: '2099-01-02',
    })));
  });

  it('hides itself from someone who is not HR', async () => {
    all.mockRejectedValue(Object.assign(new Error('Only HR'), { status: 403 }));
    const { container } = render(<ApprovalDelegationsAdmin />);
    await waitFor(() => expect(all).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-card="delegations-admin"]')).toBeNull());
  });
});

describe('ForChip', () => {
  it('names the delegator', () => {
    render(<ForChip name="Max Test" email="max@x.com" />);
    expect(screen.getByText('For Max Test')).toBeTruthy();
  });
});
