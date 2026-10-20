import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Tickets <-> equipment (Oct 2026): render smoke for the drawer's Equipment
// and the create form's picker - chips with serial and assignee, Other
// Tickets for This Item, the requester's own items first, and picking one.

const LAPTOP = { id: 'i1', name: 'Dell Laptop', serialNumber: 'GG-00001', assetTag: '', makeModel: 'Dell 7440',
  assignedToEmail: 'req@x.com', assignedToName: 'Req Person', heldBy: 'req@x.com', mine: true, removed: false, deleted: false };
const DRILL = { id: 'i2', name: 'Drill', serialNumber: '', assetTag: 'AT-9', makeModel: '', assignedToEmail: '',
  assignedToName: '', heldBy: '', mine: false, removed: false, deleted: false };

vi.mock('../api', () => ({
  api: {
    getTicketItems: vi.fn(() => Promise.resolve({
      canLink: true, desk: true,
      items: [{ ...LAPTOP, canUnlink: true, otherCount: 1,
        otherTickets: [{ id: 't9', code: '000009', subject: 'Screen flicker', status: 'resolved' }] }],
    })),
    getTicketItemOptions: vi.fn(() => Promise.resolve({ items: [LAPTOP, DRILL], desk: true })),
    linkTicketItems: vi.fn(() => Promise.resolve({ canLink: true, desk: true, items: [] })),
    unlinkTicketItem: vi.fn(() => Promise.resolve({ canLink: true, desk: true, items: [] })),
  },
}));

const { api } = await import('../api');
const { TicketEquipment, TicketEquipmentIntake } = await import('./TicketEquipment');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('TicketEquipment (drawer)', () => {
  it('renders linked items with serial and assignee, and their other tickets', async () => {
    render(<TicketEquipment ticketId="t1" />);
    expect(await screen.findByText('Dell Laptop')).toBeTruthy();
    expect(screen.getByText(/GG-00001/)).toBeTruthy();
    expect(screen.getByText(/Req Person/)).toBeTruthy();
    fireEvent.click(screen.getByText('Other Tickets for This Item (1)'));
    expect(screen.getByText('Screen flicker')).toBeTruthy();
    expect(api.getTicketItems).toHaveBeenCalledWith('t1');
  });

  it('removes a link', async () => {
    render(<TicketEquipment ticketId="t1" />);
    fireEvent.click(await screen.findByLabelText('Remove Dell Laptop'));
    await waitFor(() => expect(api.unlinkTicketItem).toHaveBeenCalledWith('t1', 'i1'));
  });
});

describe('TicketEquipmentIntake (create form)', () => {
  it('lists the requester\'s items first and hands back the picked one', async () => {
    const onChange = vi.fn();
    render(<TicketEquipmentIntake value={[]} onChange={onChange} requester="req@x.com" companyId="" />);
    fireEvent.click(screen.getByText('Add Equipment'));
    const options = await screen.findAllByRole('option');
    expect(options[0].textContent).toContain('Dell Laptop');
    expect(options[0].textContent).toContain('Yours');
    expect(api.getTicketItemOptions).toHaveBeenCalledWith(expect.objectContaining({ requester: 'req@x.com' }));
    fireEvent.click(options[1]);
    expect(onChange).toHaveBeenCalledWith([DRILL]);
  });

  it('clears the picks when the requester changes, and shows the server refusal', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TicketEquipmentIntake value={[LAPTOP]} onChange={onChange} requester="req@x.com" />);
    expect(onChange).not.toHaveBeenCalled();
    rerender(<TicketEquipmentIntake value={[LAPTOP]} onChange={onChange} requester="someone@x.com" />);
    expect(onChange).toHaveBeenCalledWith([]);
    rerender(<TicketEquipmentIntake value={[]} onChange={onChange} requester="someone@x.com" />);
    expect(screen.getByText(/equipment was cleared/)).toBeTruthy();
    rerender(<TicketEquipmentIntake value={[]} onChange={onChange} requester="someone@x.com"
      error="You can only link equipment assigned to you or checked out by you" />);
    expect(screen.getByRole('alert').textContent).toContain('You can only link equipment');
  });

  it('Escape on a result row closes only the picker', async () => {
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    render(<TicketEquipmentIntake value={[]} onChange={() => {}} requester="req@x.com" />);
    fireEvent.click(screen.getByText('Add Equipment'));
    const options = await screen.findAllByRole('option');
    fireEvent.keyDown(options[0], { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Add Equipment')).toBeTruthy();
    // The modal's Escape layer skips a defaultPrevented key.
    expect(outer.mock.calls.every(([e]) => e.defaultPrevented)).toBe(true);
    window.removeEventListener('keydown', outer);
  });
});

describe('equipmentError', () => {
  it('picks out the equipment refusals only', async () => {
    const { equipmentError } = await import('./ticketEquipmentError');
    const e = (status, detail) => Object.assign(new Error(detail), { status, detail });
    expect(equipmentError(e(403, 'You can only link equipment assigned to you or checked out by you'))).toContain('equipment');
    expect(equipmentError(e(422, 'That equipment (Drill) belongs to a different company than this ticket'))).toContain('Drill');
    expect(equipmentError(e(400, 'The requester must be someone on the Nexus People list.'))).toBe('');
  });
});

describe('Other Tickets for This Item', () => {
  it('says how many more there are than it lists', async () => {
    api.getTicketItems.mockResolvedValueOnce({
      canLink: false, desk: false,
      items: [{ ...LAPTOP, canUnlink: false, otherCount: 12,
        otherTickets: Array.from({ length: 10 }, (_, n) => ({ id: `t${n}`, code: `00000${n}`, subject: `Ticket ${n}`, status: 'open' })) }],
    });
    render(<TicketEquipment ticketId="t1" />);
    fireEvent.click(await screen.findByText('Other Tickets for This Item (12)'));
    expect(screen.getByText('and 2 more')).toBeTruthy();
  });
});
