import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Workday > Fill a Form (Neil, 11/02/2026): the tile lists the forms this
// person may fill, grouped by category, and opens one in the fill sheet.
// A deep link opens a form (or the picker) straight away.

const formsMine = vi.fn();
vi.mock('../api', () => ({ api: { formsMine: (...a) => formsMine(...a) } }));
vi.mock('./FillForm', () => ({ default: ({ templateId, onClose }) => <div>Filling {templateId}<button type="button" onClick={onClose}>Done</button></div> }));

const FormsTile = (await import('./FormsTile')).default;

const FORMS = [
  { id: 't1', title: 'Vehicle Check', category: 'vehicle', description: 'Before you drive', workSiteId: '', showOnShifts: true, audience: 'company' },
  { id: 't2', title: 'Opening Checklist', category: 'checklist', description: '', workSiteId: 's1', showOnShifts: true, audience: 'site' },
  { id: 't3', title: 'Incident Report', category: 'incident', description: '', workSiteId: '', showOnShifts: false, audience: 'company' },
];

beforeEach(() => { formsMine.mockReset().mockResolvedValue(FORMS); });   // GET /forms/mine is a bare array

describe('FormsTile', () => {
  it('renders nothing when there is nothing to fill', async () => {
    formsMine.mockResolvedValue([]);
    const { container } = render(<FormsTile />);
    await waitFor(() => expect(formsMine).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('shows the tile with the count, opens the picker grouped by category, and opens a form', async () => {
    render(<FormsTile />);
    const tile = await screen.findByRole('button', { name: /Fill a Form/ });
    expect(tile.textContent).toMatch(/3 forms/);
    fireEvent.click(tile);
    expect(await screen.findByText('Vehicle Checks')).toBeTruthy();
    expect(screen.getByText('Checklists')).toBeTruthy();
    expect(screen.getByText('Incident Reports')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Opening Checklist/ }));
    expect(await screen.findByText('Filling t2')).toBeTruthy();
  });

  it('a deep link opens that form at once, and "pick" opens the picker', async () => {
    const { rerender } = render(<FormsTile autoOpen={{ id: 't3', n: 1 }} />);
    expect(await screen.findByText('Filling t3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    rerender(<FormsTile autoOpen={{ id: 'pick', n: 2 }} />);
    expect(await screen.findByText('Vehicle Checks')).toBeTruthy();
  });

  it('one form only opens straight from the tile', async () => {
    formsMine.mockResolvedValue([FORMS[0]]);
    render(<FormsTile />);
    const tile = await screen.findByRole('button', { name: /Fill a Form/ });
    expect(tile.textContent).toMatch(/Vehicle Check/);
    fireEvent.click(tile);
    expect(await screen.findByText('Filling t1')).toBeTruthy();
  });

  it('a picker opened before the list arrives says it is loading, never "no forms"', async () => {
    let answer;
    formsMine.mockReturnValue(new Promise((r) => { answer = r; }));
    render(<FormsTile autoOpen={{ id: 'pick', n: 1 }} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Loading your forms');
    expect(screen.queryByText('There are no forms for you to fill yet.')).toBeNull();
    answer(FORMS);
    expect(await screen.findByText('Vehicle Checks')).toBeTruthy();
  });
});
