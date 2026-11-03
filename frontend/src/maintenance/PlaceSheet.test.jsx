import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Scan to Request (11/03/2026): a scanned tag's sheet - the open tickets at
// the place, Report a Problem with the property and equipment set, Start Work
// for the team, and the access-denied state for a place the person cannot see.
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const PLACE = {
  property: { id: 'gst', name: 'Greens Storage Temecula', city: 'Temecula' },
  asset: { id: 'truck', name: 'F-250', kind: 'vehicle' },
  tickets: [
    { id: 't1', codeLabel: 'Ticket #12', subject: 'Oil change', status: 'open', priority: 'medium', preventive: true, pmDueOn: '2026-10-30', overdue: true, propertyName: 'Greens Storage Temecula', equipmentName: 'F-250', unit: '', canOpen: true, checklist: [] },
    { id: 't2', codeLabel: 'Ticket #13', subject: 'Brakes squeal', status: 'open', priority: 'high', preventive: false, pmDueOn: '', overdue: false, propertyName: 'Greens Storage Temecula', equipmentName: 'F-250', unit: '', canOpen: false },
  ],
  topics: [{ topic: 'Vehicle Repair', area: 'facilities', areaLabel: 'Buildings & Maintenance', departmentId: 'd-fac', departmentName: 'Maintenance' }],
  units: { units: [], strict: false }, canStart: true,
};
const getMaintenancePlace = vi.fn(() => Promise.resolve(PLACE));
const reportPlaceProblem = vi.fn(() => Promise.resolve({ id: 't3', code: '14' }));
const startMaintenanceWork = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => {
  const named = { getMaintenancePlace: (...a) => getMaintenancePlace(...a), reportPlaceProblem: (...a) => reportPlaceProblem(...a), startMaintenanceWork: (...a) => startMaintenanceWork(...a) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve([])) }) };
});
vi.mock('../tickets/evidenceUpload', () => ({ uploadTicketEvidence: vi.fn(() => Promise.resolve('https://x.supabase.co/storage/v1/object/public/ticket-evidence/a.jpg')) }));

const { default: PlaceSheet } = await import('./PlaceSheet');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PlaceSheet', () => {
  it('lists the open tickets at the equipment, overdue first, and starts work on one', async () => {
    render(<PlaceSheet propertyId="gst" assetId="truck" onClose={() => {}} />);
    expect(await screen.findByText('Oil change')).toBeTruthy();
    expect(getMaintenancePlace).toHaveBeenCalledWith('gst', 'truck');
    expect(screen.getByText('Vehicle at Greens Storage Temecula')).toBeTruthy();
    expect(screen.getByText(/Overdue · 10\/30\/2026/)).toBeTruthy();
    // A ticket the person cannot open is a summary - no Start Work on it.
    expect(screen.getAllByRole('button', { name: /Start Work/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Start Work/ }));
    await waitFor(() => expect(startMaintenanceWork).toHaveBeenCalledWith('t1'));
  });

  it('reports a problem with the property and equipment set', async () => {
    render(<PlaceSheet propertyId="gst" assetId="truck" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Report a Problem/ }));
    fireEvent.change(screen.getByPlaceholderText('F-250 will not start'), { target: { value: 'Check engine light' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Report' }));
    await waitFor(() => expect(reportPlaceProblem).toHaveBeenCalledWith('gst', expect.objectContaining({
      topic: 'Vehicle Repair', subject: 'Check engine light', asset_id: 'truck', unit: 'Common Area', photos: [],
    })));
    expect(await screen.findByText(/Ticket #14 is with the team/)).toBeTruthy();
  });

  it('shows a stranger only that something is open (review M4)', async () => {
    getMaintenancePlace.mockImplementationOnce(() => Promise.resolve({
      ...PLACE, asset: null, canStart: false,
      tickets: [{ id: 'open-1', codeLabel: '', subject: 'Open Request', status: 'open', priority: '', preventive: false, pmDueOn: '', overdue: false, propertyName: '', equipmentName: '', unit: '', canOpen: false, generic: true }],
    }));
    render(<PlaceSheet propertyId="gst" onClose={() => {}} />);
    expect(await screen.findByText('Open Request')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start Work/ })).toBeNull();
    expect(screen.queryByText('Oil change')).toBeNull();
  });

  it('says so when the place is not one the person may see', async () => {
    getMaintenancePlace.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('nope'), { status: 404 })));
    render(<PlaceSheet propertyId="vault" onClose={() => {}} />);
    expect(await screen.findByText('You Do Not Have Access to This Place')).toBeTruthy();
  });
});
