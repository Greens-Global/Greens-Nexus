import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The preventive schedule editor (11/03/2026): fixed dates with the quick
// picks, by meter with the equipment's reading, and editing an existing one
// sends only what it should (the run-as is whoever saves - server side).
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const OPTS = {
  property: { id: 'gst', name: 'Greens Storage Temecula' },
  departments: [{ id: 'd-fac', name: 'Maintenance', companyId: 'c1', companyName: 'Greens' }],
  topics: [{ name: 'Heating or Cooling (HVAC)', area: 'facilities' }],
  equipment: [{ id: 'truck', name: 'F-250', kind: 'vehicle', meterField: 'odometer', reading: 41000, readingLabel: '41,000 mi' }],
  units: { units: [] }, canAssign: false,
};
const createPmSchedule = vi.fn(() => Promise.resolve({ serviceId: 's1' }));
const updateMaintenanceService = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../../api.js', () => {
  const named = { getPmScheduleOptions: () => Promise.resolve(OPTS), createPmSchedule: (...a) => createPmSchedule(...a), updateMaintenanceService: (...a) => updateMaintenanceService(...a) };
  return { api: new Proxy({}, { get: (_, k) => named[k] || (() => Promise.resolve([])) }) };
});

const { default: PreventiveScheduleSheet } = await import('./PreventiveScheduleSheet.jsx');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PreventiveScheduleSheet', () => {
  it('saves a fixed-date schedule from a quick pick with its checklist', async () => {
    const onSaved = vi.fn();
    render(<PreventiveScheduleSheet propertyId="gst" onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'HVAC Filter Change' } });
    await waitFor(() => expect(screen.getByLabelText('Team').value).toBe('d-fac'));   // the only team, picked
    fireEvent.click(screen.getByRole('button', { name: 'Every Month on the 1st' }));
    fireEvent.change(screen.getByLabelText('Step 1'), { target: { value: 'Change the filter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Schedule' }));
    await waitFor(() => expect(createPmSchedule).toHaveBeenCalled());
    const [pid, body] = createPmSchedule.mock.calls[0];
    expect(pid).toBe('gst');
    expect(body).toMatchObject({ kind: 'calendar', subject: 'HVAC Filter Change', hr_department_id: 'd-fac', recurrence_unit: 'month',
      recurrence_every: 1, checklist: ['Change the filter'], lead_days: 7 });
    expect(body.next_due).toMatch(/^\d{4}-\d{2}-01$/);
    expect(body.assignee_email).toBeUndefined();     // only the desk names an assignee
    expect(onSaved).toHaveBeenCalled();
  });

  it('asks for the equipment on a meter schedule and shows its reading', async () => {
    render(<PreventiveScheduleSheet propertyId="gst" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Oil Change' } });
    fireEvent.click(screen.getByRole('radio', { name: 'By Meter' }));
    await screen.findByText('F-250 (41,000 mi)');
    fireEvent.click(screen.getByRole('button', { name: 'Save Schedule' }));
    expect(await screen.findByText('Pick the vehicle or equipment.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Equipment'), { target: { value: 'truck' } });
    fireEvent.change(screen.getByLabelText('Meter Every'), { target: { value: '5000' } });
    expect(screen.getByText('Reads 41,000 mi now, from its Asset Management record.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save Schedule' }));
    await waitFor(() => expect(createPmSchedule).toHaveBeenCalledWith('gst', expect.objectContaining({ kind: 'meter', asset_id: 'truck', meter_every: 5000 })));
  });

  it('edits an existing schedule in place', async () => {
    const svc = { id: 's1', kind: 'floating', subject: 'Roof Check', departmentId: 'd-fac', recurrenceUnit: 'day', recurrenceEvery: 90,
      nextDue: '', waitingOnCompletion: true, checklist: ['Walk the roof'], leadDays: 0, active: true, rev: '2026-11-03T10:00:00Z' };
    render(<PreventiveScheduleSheet propertyId="gst" svc={svc} onClose={() => {}} />);
    await screen.findByText('Next Due (after the open ticket)');
    fireEvent.click(screen.getByRole('button', { name: 'Save Schedule' }));
    await waitFor(() => expect(updateMaintenanceService).toHaveBeenCalled());
    const body = updateMaintenanceService.mock.calls[0][2];
    // The revision it was read with rides along - a stale editor is a 409 (review M1).
    expect(body).toMatchObject({ kind: 'floating', recurrence_unit: 'day', recurrence_every: 90, checklist: ['Walk the roof'], rev: '2026-11-03T10:00:00Z' });
    expect('next_due' in body).toBe(false);          // waiting on the open ticket: no date sent
  });
});
