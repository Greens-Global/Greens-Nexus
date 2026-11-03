import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// My Work (11/03/2026): a technician's tickets, preventive first; Start and
// Done, and Done on a preventive ticket waits for a photo of the finished work.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const PM = { id: 't1', codeLabel: 'Ticket #12', subject: 'HVAC Filter Change', status: 'open', priority: 'medium', preventive: true, pmDueOn: '2026-11-05', overdue: false, propertyName: 'Greens Storage Temecula', equipmentName: '', unit: '', canOpen: true, mine: true, checklist: [{ label: 'Change the filter', done: false }, { label: 'Check the drain', done: false }] };
const PLAIN = { ...PM, id: 't2', codeLabel: 'Ticket #13', subject: 'Gate stuck', preventive: false, pmDueOn: '', checklist: [], status: 'in_progress' };
const WORK = { tickets: [PM, PLAIN], canStart: true, overdue: 0, preventive: 1 };
const finishMaintenanceWork = vi.fn(() => Promise.resolve({}));
const startMaintenanceWork = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => {
  const named = { getMyMaintenanceWork: () => Promise.resolve(WORK), finishMaintenanceWork: (...a) => finishMaintenanceWork(...a), startMaintenanceWork: (...a) => startMaintenanceWork(...a) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve([])) }) };
});
const URL1 = 'https://x.supabase.co/storage/v1/object/public/ticket-evidence/after.jpg';
vi.mock('../tickets/evidenceUpload', () => ({ uploadTicketEvidence: vi.fn(() => Promise.resolve(URL1)) }));

const { default: MyWorkSheet } = await import('./MyWorkSheet');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('My Work', () => {
  it('lists preventive work first with its steps and starts it', async () => {
    render(<MyWorkSheet onClose={() => {}} />);
    const lines = await screen.findAllByText(/HVAC Filter Change|Gate stuck/);
    expect(lines[0].textContent).toBe('HVAC Filter Change');
    expect(screen.getByText('0 of 2 Steps')).toBeTruthy();
    expect(screen.getByText('2 open · 1 preventive')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Start$/ }));
    await waitFor(() => expect(startMaintenanceWork).toHaveBeenCalledWith('t1'));
  });

  it('marks a preventive ticket done only with a note and a photo', async () => {
    const { container } = render(<MyWorkSheet onClose={() => {}} />);
    await screen.findByText('HVAC Filter Change');
    fireEvent.click(screen.getAllByRole('button', { name: /Done/ })[0]);
    const done = await screen.findByRole('button', { name: 'Mark Done' });
    fireEvent.change(screen.getByPlaceholderText(/Replaced the filter/), { target: { value: 'Swapped the filter' } });
    fireEvent.click(screen.getByLabelText('Change the filter'));
    expect(done.disabled).toBe(true);                                 // no photo yet
    const input = document.body.querySelector('input[type="file"]') || container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(['x'], 'after.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark Done' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Done' }));
    await waitFor(() => expect(finishMaintenanceWork).toHaveBeenCalledWith('t1', {
      note: 'Swapped the filter', photos: [URL1],
      checklist: [{ label: 'Change the filter', done: true }, { label: 'Check the drain', done: false }],
    }));
  });
});
