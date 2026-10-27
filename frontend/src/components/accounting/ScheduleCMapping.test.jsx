import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Schedule C (Draft) -> Line Mapping (10/27): the boxes under the headings
// (columnFilters.jsx) narrow the accounts, on top of the search and Show.

vi.mock('../../api', () => ({ api: { saveAccountingTaxLines: vi.fn(async () => ({})) } }));

import ScheduleCMapping from './ScheduleCMapping';

const rows = [
  { code: '40100', title: 'Rental Income', section: 'revenue', amount: 12000, line: '1', source: 'all', suggested: '' },
  { code: '60500', title: 'Repairs and Maintenance', section: 'expense', amount: 850, line: '', source: '', suggested: '21' },
  { code: '61000', title: 'Utilities', section: 'expense', amount: 2400, line: '25', source: 'entity', suggested: '' },
];
const names = () => [...document.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td').textContent.trim());

describe('ScheduleCMapping column filter boxes (10/27)', () => {
  it('a text box and an amount box narrow the accounts, stacking with the search', () => {
    render(<ScheduleCMapping rows={rows} onClose={() => {}} />);
    const table = screen.getByRole('table');
    const box = screen.getByRole('textbox', { name: 'Filter Section' });
    expect(table.querySelector('thead').contains(box)).toBe(true);
    expect(table.classList.contains('acct-sticky-head')).toBe(true);
    fireEvent.change(box, { target: { value: 'operating' } });
    expect(names()).toEqual(['60500 Repairs and Maintenance', '61000 Utilities']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Operator for Amount' }), { target: { value: '>' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Amount' }), { target: { value: '1000' } });
    expect(names()).toEqual(['61000 Utilities']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search accounts' }), { target: { value: 'repairs' } });
    expect(screen.getByText(/Nothing matches these column filters\./)).toBeTruthy();
    // UI test 10/27: the link empties the boxes; the search stays.
    fireEvent.click(screen.getByRole('button', { name: 'Clear Column Filters' }));
    expect(names()).toEqual(['60500 Repairs and Maintenance']);
    expect(screen.getByRole('textbox', { name: 'Filter Section' }).value).toBe('');
    expect(screen.getByRole('textbox', { name: 'Search accounts' }).value).toBe('repairs');
  });

  it('the Line filter reads what the Line box in the row shows, a pick not yet saved included', () => {
    render(<ScheduleCMapping rows={rows} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Line' }), { target: { value: 'suggested' } });
    expect(names()).toEqual(['60500 Repairs and Maintenance']);
    const row = screen.getByText('Repairs and Maintenance').closest('tr');
    fireEvent.change(within(row).getByRole('combobox', { name: /Line for 60500/ }), { target: { value: '21' } });
    expect(screen.queryByText('Repairs and Maintenance')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter Line' }), { target: { value: '' } });
    expect(names()).toHaveLength(3);
  });
});
