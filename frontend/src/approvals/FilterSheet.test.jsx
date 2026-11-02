import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// The phone's one Filter sheet (approvals/FilterSheet.jsx): search, sort,
// group, priority, waiting, and the department / company lists when the
// person sees more than one. Every control saves on tap - the same state
// the desktop tools row writes.

vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => true }));
const { default: FilterSheet } = await import('./FilterSheet');
const group = (name) => within(screen.getByRole('group', { name }));

const props = () => ({
  filters: { query: '', prioFilter: 'all', ageFilter: 0, dept: '', company: '' },
  setFilters: vi.fn(), clearFilters: vi.fn(), onClose: vi.fn(),
  sortKey: 'oldest', setSortKey: vi.fn(), groupBy: 'kind', setGroupBy: vi.fn(),
  deptCounts: [['Admin', 2], ['Operations', 5]], companyCounts: [['Greens Global', 7]], seesAll: false,
});

describe('FilterSheet', () => {
  it('saves each choice on tap and closes on Done', () => {
    const p = props();
    render(<FilterSheet {...p} />);
    const box = screen.getByRole('searchbox');
    expect(box.style.fontSize).toBe('16px');
    fireEvent.change(box, { target: { value: 'priya' } });
    expect(p.setFilters).toHaveBeenCalledWith({ query: 'priya' });
    fireEvent.click(group('Sort').getByRole('button', { name: 'Newest' }));
    expect(p.setSortKey).toHaveBeenCalledWith('newest');
    fireEvent.click(group('Group By').getByRole('button', { name: 'Person' }));
    expect(p.setGroupBy).toHaveBeenCalledWith('person');
    fireEvent.click(group('Priority').getByRole('button', { name: 'Urgent' }));
    expect(p.setFilters).toHaveBeenCalledWith({ prioFilter: 'urgent' });
    fireEvent.click(group('Priority').getByRole('button', { name: 'High And Up' }));
    expect(p.setFilters).toHaveBeenCalledWith({ prioFilter: 'high' });
    fireEvent.click(group('Waiting').getByRole('button', { name: '7+ Days' }));
    expect(p.setFilters).toHaveBeenCalledWith({ ageFilter: 7 });
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
    expect(p.clearFilters).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(p.onClose).toHaveBeenCalled();
    // The current choices read as pressed.
    expect(group('Sort').getByRole('button', { name: 'Oldest' }).getAttribute('aria-pressed')).toBe('true');
    expect(group('Group By').getByRole('button', { name: 'Type' }).getAttribute('aria-pressed')).toBe('true');
    expect(group('Waiting').getByRole('button', { name: 'Any' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('lists departments when there is more than one, companies only when there are several', () => {
    const p = props();
    render(<FilterSheet {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Operations 5' }));
    expect(p.setFilters).toHaveBeenCalledWith({ dept: 'Operations' });
    expect(screen.queryByRole('group', { name: 'Company' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Greens Global/ })).toBeNull();
  });

  it('hides the department list for one department, shows companies for two, and a picked one toggles off', () => {
    const p = { ...props(), deptCounts: [['Admin', 2]], companyCounts: [['Greens Global', 5], ['Greens India', 2]], filters: { query: '', prioFilter: 'all', ageFilter: 0, dept: '', company: 'Greens India' } };
    render(<FilterSheet {...p} />);
    expect(screen.queryByRole('button', { name: /^Admin/ })).toBeNull();
    const india = screen.getByRole('button', { name: 'Greens India 2' });
    expect(india.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(india);
    expect(p.setFilters).toHaveBeenCalledWith({ company: '' });
    // Only Group By grows a Company choice when there are several.
    expect(group('Group By').getByRole('button', { name: 'Company' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Company' })).toBeTruthy();
  });

  it('shows a sort, a grouping or a priority picked on a computer, pressed, instead of pretending it is another', () => {
    const p = { ...props(), sortKey: 'kind', groupBy: 'company', filters: { query: '', prioFilter: 'medium', ageFilter: 0, dept: '', company: '' } };
    render(<FilterSheet {...p} />);
    expect(group('Sort').getByRole('button', { name: 'Kind' }).getAttribute('aria-pressed')).toBe('true');
    expect(group('Sort').getByRole('button', { name: 'Oldest' }).getAttribute('aria-pressed')).toBe('false');
    expect(group('Group By').getByRole('button', { name: 'Company' }).getAttribute('aria-pressed')).toBe('true');
    expect(group('Group By').getByRole('button', { name: 'Type' }).getAttribute('aria-pressed')).toBe('false');
    expect(group('Priority').getByRole('button', { name: 'Medium' }).getAttribute('aria-pressed')).toBe('true');
    // A phone choice is still one tap away.
    fireEvent.click(group('Sort').getByRole('button', { name: 'Oldest' }));
    expect(p.setSortKey).toHaveBeenCalledWith('oldest');
  });
});
