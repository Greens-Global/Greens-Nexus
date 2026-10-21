import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// C1 finish pass (Oct 2026): sortable headers are buttons the keyboard reaches
// (aria-sort on the th), a cell whose only content is the desktop "-" is marked
// empty so the phone card drops it, and the export menu closes on Escape.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../../../api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));

const { CollectionTable } = await import('./CollectionTable.jsx');

afterEach(cleanup);

const ROWS = [
  { id: 'm1', propertyId: 'a1', date: '2026-10-02', description: 'Replaced HVAC filter', vendor: '', cost: '', status: 'done' },
  { id: 'm2', propertyId: 'a1', date: '2026-09-12', description: 'Roof patch', vendor: 'ABC Roofing', cost: '240', status: 'done' },
];
const props = { coll: 'maintenance', rows: ROWS, active: { id: 'a1', name: 'Lot 1' }, filters: {}, onEdit: vi.fn(), onAdd: vi.fn() };

describe('CollectionTable keyboard reach', () => {
  it('sorts from a button inside the header cell and reports aria-sort', () => {
    render(<CollectionTable {...props} />);
    const vendorBtn = screen.getByRole('button', { name: /^Vendor/ });
    const th = vendorBtn.closest('th');
    expect(th.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(vendorBtn);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(vendorBtn);
    expect(th.getAttribute('aria-sort')).toBe('descending');
  });

  it('marks a "-" cell empty for the phone card and leaves a filled one alone', () => {
    render(<CollectionTable {...props} />);
    const cells = document.querySelectorAll('td[data-label="Vendor"]');
    const byText = [...cells].map((td) => [td.textContent.trim(), td.getAttribute('data-empty')]);
    expect(byText).toContainEqual(['-', '1']);
    expect(byText).toContainEqual(['ABC Roofing', null]);
  });

  it('opens the export menu as menu items and closes it on Escape', () => {
    render(<CollectionTable {...props} />);
    const trigger = screen.getByRole('button', { name: /Export/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Export as CSV' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Export as PDF' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
