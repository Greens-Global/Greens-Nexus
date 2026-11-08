import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Workday's My Tickets tile (Neil, 11/04/2026; a pill in the action row since
// 11/08/2026): the count on its line, shown when there is work - and always,
// at 0, for a maintenance team.
const getMyMaintenanceWork = vi.fn();
vi.mock('../api', () => ({ api: { getMyMaintenanceWork: (...a) => getMyMaintenanceWork(...a) } }));

const { default: MyWorkTile, useMyMaintenanceWork } = await import('./MyWorkTile');

function Page() {
  const w = useMyMaintenanceWork();
  return <div data-grid={w.show ? 'tickets' : 'plain'}><MyWorkTile {...w} /></div>;
}

beforeEach(() => getMyMaintenanceWork.mockReset());

describe('My Tickets tile', () => {
  it('is an action pill with the count and the overdue words when there is work', async () => {
    getMyMaintenanceWork.mockResolvedValue({ tickets: [{ id: 't1' }, { id: 't2' }, { id: 't3' }], overdue: 1, preventive: 2 });
    render(<Page />);
    const tile = await screen.findByRole('button', { name: 'My Tickets, 3 open, 1 overdue' });
    expect(tile.classList.contains('dk-stat')).toBe(true);
    expect(tile.classList.contains('wd-askhr')).toBe(true);           // the same pill as Ask HR (11/08/2026)
    expect(tile.querySelector('.wd-askhr-title').textContent).toBe('My Tickets');
    expect(tile.querySelector('.wd-askhr-sub').textContent).toBe('3 open · 1 overdue');
    expect(tile.querySelector('.wd-askhr-dot')).toBeTruthy();
    expect(document.querySelector('[data-grid]').getAttribute('data-grid')).toBe('tickets');
  });
  it('stays up at 0 with "Nothing open" for someone on a maintenance team', async () => {
    getMyMaintenanceWork.mockResolvedValue({ tickets: [], onTeam: true });
    render(<Page />);
    const tile = await screen.findByRole('button', { name: 'My Tickets, 0 open' });
    expect(tile.querySelector('.wd-askhr-sub').textContent).toBe('Nothing open');
    expect(tile.querySelector('.wd-askhr-dot')).toBeNull();
    expect(document.querySelector('[data-grid]').getAttribute('data-grid')).toBe('tickets');
  });
  it('is not there with no work for anyone else', async () => {
    getMyMaintenanceWork.mockResolvedValue({ tickets: [] });
    render(<Page />);
    await waitFor(() => expect(getMyMaintenanceWork).toHaveBeenCalled());
    expect(document.querySelector('[data-my-tickets]')).toBeNull();
    expect(document.querySelector('[data-grid]').getAttribute('data-grid')).toBe('plain');
  });
});
