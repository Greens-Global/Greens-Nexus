import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Preventive schedules on the Maintenance tab (review, 11/03/2026): what a
// schedule needs from a person is said on it, Confirm Reading and Stop carry
// the revision the schedule was read with.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const updateMaintenanceService = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../../api.js', () => {
  const named = { updateMaintenanceService: (...a) => updateMaintenanceService(...a) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve([])) }) };
});
const { RecurringServicesPanel } = await import('./MaintenanceReview.jsx');

const SVC = {
  id: 's1', kind: 'meter', kindLabel: 'By Meter', subject: 'Oil Change', system: 'General Repair', active: true,
  scheduleLabel: 'Every 5,000 mi', meterNextLabel: '50,000 mi', meterLastLabel: '45,250 mi', openCount: 0, overdueCount: 0,
  attention: 'reading', attentionLabel: 'Reading Needs Confirmation (95,000 mi)', rev: 'r-1', tickets: [], totals: [],
};
const DATA = { services: [SVC], open: [], history: [], canManage: true, preventive: { open: 0, overdue: 0 } };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('RecurringServicesPanel - preventive', () => {
  it('says a held reading and confirms it with the revision', async () => {
    const onChanged = vi.fn();
    render(<RecurringServicesPanel propertyId="gst" data={DATA} onOpen={() => {}} onChanged={onChanged} />);
    expect(screen.getByText('Reading Needs Confirmation (95,000 mi)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Reading' }));
    await waitFor(() => expect(updateMaintenanceService).toHaveBeenCalledWith('gst', 's1', { confirm_reading: true, rev: 'r-1' }));
    expect(onChanged).toHaveBeenCalled();
  });

  it('stops a schedule with the revision it was read with', async () => {
    render(<RecurringServicesPanel propertyId="gst" data={{ ...DATA, services: [{ ...SVC, attention: '', attentionLabel: '' }] }} onOpen={() => {}} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Confirm Reading' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(updateMaintenanceService).toHaveBeenCalledWith('gst', 's1', { active: false, rev: 'r-1' }));
  });
});
