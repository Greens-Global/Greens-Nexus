import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// C1 finish pass (Oct 2026): no units = an empty state with the add row in it;
// units = a compact list with a remove button each; onSave(units) unchanged.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));

const { ManageUnitsModal } = await import('./ManageUnitsModal.jsx');

afterEach(cleanup);

describe('ManageUnitsModal', () => {
  it('shows the empty state, adds a unit from it and saves the list', () => {
    const onSave = vi.fn();
    render(<ManageUnitsModal units={[]} onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByText('No units yet - add Suite 100 to start.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New unit or suite'), { target: { value: 'Suite 100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByText('No units yet - add Suite 100 to start.')).toBeNull();
    expect(screen.getByText('Suite 100')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].map((u) => u.label)).toEqual(['Suite 100']);
  });

  it('lists existing units with a remove button each', () => {
    const onSave = vi.fn();
    render(<ManageUnitsModal units={[{ id: 'u1', label: 'Suite 100' }, { id: 'u2', label: 'Suite 200' }]} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Suite 100' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0][0].map((u) => u.label)).toEqual(['Suite 200']);
  });
});
