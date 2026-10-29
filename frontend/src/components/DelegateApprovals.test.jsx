import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Delegate My Approvals (Oct 17 2026): the Workday card (pick a stand-in,
// dates, note; current/upcoming with Revoke; who you cover), the HR admin list
// and the "For <delegator>" chip. Oct 20 (Neil): collapsed by default, open
// only for the days you are off, and the picker lists only who may cover (up
// or across - the server's list), never the whole directory.

const mine = vi.fn();
const create = vi.fn();
const revoke = vi.fn();
const all = vi.fn();
const createFor = vi.fn();
const people = vi.fn();
const options = vi.fn();
vi.mock('../api', () => ({
  api: {
    approvalDelegationsMine: (...a) => mine(...a),
    approvalDelegationCreate: (...a) => create(...a),
    approvalDelegationRevoke: (...a) => revoke(...a),
    approvalDelegationsAll: (...a) => all(...a),
    approvalDelegationCreateFor: (...a) => createFor(...a),
    approvalDelegationOptions: (...a) => options(...a),
    getPeopleDirectory: (...a) => people(...a),
  },
}));

const { default: DelegateApprovalsCard, ApprovalDelegationsAdmin, ForChip } = await import('./DelegateApprovals');
const { offRangeProblem } = await import('../lib/delegationDays');

const deleg = (over) => ({
  id: 'd1', delegatorEmail: 'max@x.com', delegatorName: 'Max Test', delegateEmail: 'dee@x.com', delegateName: 'Dee Test',
  startDate: '2026-10-20', endDate: '2026-10-27', note: 'Vacation', state: 'upcoming', warnings: [], ...over,
});

// Mon 10/26/2026 - Fri 10/30/2026 off.
const OFF = [{ start: '2026-10-26', end: '2026-10-30', kind: 'timeoff', label: 'Approved Time Off' }];
const DELEGATES = [
  { email: 'boss@x.com', name: 'Bo Boss', relation: 'above', relationLabel: 'Up Your Reporting Line' },
  { email: 'dee@x.com', name: 'Dee Test', relation: 'peer', relationLabel: 'Same Manager' },
];

beforeEach(() => {
  mine.mockReset().mockResolvedValue({ canDelegate: true, delegations: [], covering: [] });
  create.mockReset().mockResolvedValue({});
  revoke.mockReset().mockResolvedValue({});
  all.mockReset().mockResolvedValue([]);
  createFor.mockReset().mockResolvedValue({});
  options.mockReset().mockResolvedValue({ delegates: DELEGATES, offRanges: OFF });
  people.mockReset().mockResolvedValue([
    { email: 'max@x.com', name: 'Max Test' }, { email: 'dee@x.com', name: 'Dee Test' }, { email: 'pia@x.com', name: 'Pia Test' },
    { email: 'erin@x.com', name: 'Erin Report' },
  ]);
});

async function openCard() {
  const head = await screen.findByRole('button', { name: /Delegate My Approvals/ });
  fireEvent.click(head);
  return head;
}

describe('DelegateApprovalsCard', () => {
  it('renders nothing for someone with nothing to approve', async () => {
    mine.mockResolvedValue({ canDelegate: false, delegations: [], covering: [] });
    const { container } = render(<DelegateApprovalsCard />);
    await waitFor(() => expect(mine).toHaveBeenCalled());
    expect(container.querySelector('[data-card="delegate-approvals"]')).toBeNull();
  });

  it('is collapsed by default, with a one-line explanation', async () => {
    render(<DelegateApprovalsCard />);
    const head = await screen.findByRole('button', { name: /Delegate My Approvals/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/on the days you are off/)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(options).not.toHaveBeenCalled();     // nothing loads until it opens
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByRole('combobox')).toBeTruthy();
  });

  it('is disabled with the reason when you have no approved time off', async () => {
    options.mockResolvedValue({ delegates: DELEGATES, offRanges: [] });
    const { container } = render(<DelegateApprovalsCard />);
    await openCard();
    expect(await screen.findByText(/Available when you have approved time off/)).toBeTruthy();
    expect(container.querySelector('fieldset').disabled).toBe(true);
    expect(screen.getByRole('button', { name: /^Delegate$/ }).disabled).toBe(true);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('lists only the people who may cover - never the whole directory', async () => {
    render(<DelegateApprovalsCard />);
    await openCard();
    fireEvent.focus(await screen.findByRole('combobox'));
    expect(screen.getByRole('option', { name: /Bo Boss/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Dee Test/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Erin Report/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Pia Test/ })).toBeNull();
    expect(screen.getByText('Up Your Reporting Line')).toBeTruthy();
    expect(people).not.toHaveBeenCalled();
  });

  it('picks the time off, a person who may cover, and delegates', async () => {
    render(<DelegateApprovalsCard />);
    await openCard();
    fireEvent.click(await screen.findByRole('button', { name: /10\/26\/2026 - 10\/30\/2026/ }));
    expect(screen.getByLabelText('From').value).toBe('2026-10-26');
    expect(screen.getByLabelText('To').value).toBe('2026-10-30');
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.mouseDown(screen.getByRole('option', { name: /Bo Boss/ }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Vacation' } });
    fireEvent.click(screen.getByRole('button', { name: /^Delegate$/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      delegate_email: 'boss@x.com', start_date: '2026-10-26', end_date: '2026-10-30', note: 'Vacation',
    }));
    expect(mine).toHaveBeenCalledTimes(2);   // reloaded after saving
  });

  it('keeps Delegate off for days outside the time off, or a backwards range', async () => {
    render(<DelegateApprovalsCard />);
    await openCard();
    fireEvent.focus(await screen.findByRole('combobox'));
    fireEvent.mouseDown(screen.getByRole('option', { name: /Dee Test/ }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-28' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-03' } });
    expect(screen.getByRole('button', { name: /^Delegate$/ }).disabled).toBe(true);
    expect(screen.getByText('11/02/2026 is not inside your approved time off.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-27' } });
    expect(screen.getByRole('button', { name: /^Delegate$/ }).disabled).toBe(true);
    expect(screen.getByText('The last day is before the first day.')).toBeTruthy();
  });

  it("shows the server's refusal as is", async () => {
    create.mockRejectedValue(new Error('Erin Report is below Max Test in the reporting line.'));
    render(<DelegateApprovalsCard />);
    await openCard();
    fireEvent.click(await screen.findByRole('button', { name: /10\/26\/2026 - 10\/30\/2026/ }));
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.mouseDown(screen.getByRole('option', { name: /Dee Test/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delegate$/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/below Max Test/);
  });

  it('lists current and upcoming delegations with Revoke, who you cover, and old-rule warnings', async () => {
    mine.mockResolvedValue({
      canDelegate: true,
      delegations: [deleg({ warnings: ['Dee Test is below Max Test in the reporting line - new delegations go only up or across. This one keeps working until it ends.'] })],
      covering: [deleg({ id: 'd2', delegatorEmail: 'olive@x.com', delegatorName: 'Olive Test', delegateEmail: 'max@x.com', state: 'active' })],
    });
    const { container } = render(<DelegateApprovalsCard />);
    expect(await screen.findByText('2 Current')).toBeTruthy();
    await openCard();
    expect(await screen.findByText('Dee Test')).toBeTruthy();
    expect(screen.getByText(/10\/20\/2026 - 10\/27\/2026/, { selector: '[data-delegation="d1"] *' })).toBeTruthy();
    expect(screen.getByText('Upcoming')).toBeTruthy();
    expect(container.querySelector('[data-delegation="d1"] [data-delegation-warning]').textContent).toMatch(/keeps working until it ends/);
    expect(container.querySelector('[data-delegation="d2"] [data-delegation-warning]')).toBeNull();
    expect(screen.getByText('You Are Covering')).toBeTruthy();
    expect(screen.getByText('Olive Test')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Revoke' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('d1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop Covering' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('d2'));
  });

  it('a stand-in with nothing of their own to approve still sees who they cover', async () => {
    mine.mockResolvedValue({ canDelegate: false, delegations: [], covering: [deleg({ state: 'active' })] });
    render(<DelegateApprovalsCard />);
    await openCard();
    expect(await screen.findByText('You Are Covering')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('offRangeProblem', () => {
  it('lets weekends between days off through, but not a working day', () => {
    const off = [{ start: '2026-10-23', end: '2026-10-23' }, { start: '2026-10-26', end: '2026-10-26' }];
    expect(offRangeProblem('2026-10-23', '2026-10-26', off)).toBe('');           // Fri, Sat, Sun, Mon
    expect(offRangeProblem('2026-10-24', '2026-10-25', off)).toMatch(/inside your approved time off/);  // a weekend alone
    expect(offRangeProblem('2026-10-26', '2026-10-27', off)).toMatch(/10\/27\/2026/);
  });
});

// The words a reader sees, without the avatars' initials in between.
const said = (el) => { const c = el.cloneNode(true); c.querySelectorAll('[data-avatar]').forEach((n) => n.remove()); return c.textContent.replace(/\s+/g, ' '); };

describe('ApprovalDelegationsAdmin', () => {
  it('lists everyone and sets one for someone, picking from that person\'s allowed list', async () => {
    all.mockResolvedValue([deleg({ state: 'active' })]);
    render(<ApprovalDelegationsAdmin />);
    const row = (await screen.findByText('- covered by')).closest('[data-delegation]');
    // Three flex pieces (face + name, the words, face + name), gap-spaced.
    expect(said(row)).toMatch(/Max Test\s*- covered by\s*Dee Test/);
    const [whose] = await screen.findAllByRole('combobox');
    fireEvent.focus(whose);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Pia Test/ }));
    await waitFor(() => expect(options).toHaveBeenCalledWith('pia@x.com'));
    fireEvent.click(await screen.findByRole('button', { name: /10\/26\/2026 - 10\/30\/2026/ }));
    fireEvent.focus(screen.getByRole('combobox'));
    expect(screen.queryByRole('option', { name: /Erin Report/ })).toBeNull();
    fireEvent.mouseDown(screen.getByRole('option', { name: /Dee Test/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delegate$/ }));
    await waitFor(() => expect(createFor).toHaveBeenCalledWith(expect.objectContaining({
      delegator_email: 'pia@x.com', delegate_email: 'dee@x.com', start_date: '2026-10-26', end_date: '2026-10-30',
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
