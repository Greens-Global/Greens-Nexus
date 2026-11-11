import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Licenses & Certifications and Work Limits on the person record (Neil,
// 11/11/2026, Deputy parity): the records read with their state words, HR
// adds one (the type's length fills the expiry), a manager reads without an
// Add; Work Limits read "No limit" and save whole numbers.

const PERSON = { id: 'e1', firstName: 'Erin', lastName: 'Emp', workEmail: 'erin@x.com' };
const TYPES = [{ id: 't1', name: 'Forklift Certification', expires: true, validityMonths: 36 },
  { id: 't2', name: 'CPR / First Aid', expires: true, validityMonths: 0 }];
const REC = { id: 'c1', typeId: 't2', name: 'CPR / First Aid', state: 'expiring', expiresOn: '2026-11-20', issuedOn: '2024-11-20',
  issuer: 'Red Cross', numberLast4: '1234', documentId: '', verifiedAt: '' };

const calls = { add: vi.fn(), limits: vi.fn() };
let payload = { credentials: [REC], types: TYPES, canEdit: true };
vi.mock('../api', () => {
  const api = {
    hrPersonCredentials: () => Promise.resolve(payload),
    getEmployeeDocs: () => Promise.resolve([]),
    addHrCredential: (eid, body) => { calls.add(eid, body); return Promise.resolve({ ...payload, credentials: [...payload.credentials, { ...REC, id: 'c2', typeId: body.typeId, name: 'Forklift Certification', state: 'valid', expiresOn: body.expiresOn }] }); },
    hrWorkLimits: () => Promise.resolve({ limits: { maxHoursDay: 0, maxHoursWeek: 20, maxShiftsWeek: 0, minRestHours: 0, maxDaysInRow: 0 }, canEdit: true }),
    saveHrWorkLimits: (eid, limits) => { calls.limits(eid, limits); return Promise.resolve({ limits, canEdit: true }); },
  };
  return { api, default: api };
});
vi.mock('../ui/dialog', () => ({ dialog: { confirm: () => Promise.resolve(true), undo: () => {} } }));

afterEach(() => { cleanup(); calls.add.mockClear(); calls.limits.mockClear(); payload = { credentials: [REC], types: TYPES, canEdit: true }; });

describe('Licenses & Certifications', () => {
  it('lists each record with its state, and HR adds one with the expiry filled from the type', async () => {
    const { default: CredentialsSection } = await import('./CredentialsSection');
    render(<CredentialsSection employee={PERSON} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('CPR / First Aid')).toBeTruthy();
    expect(screen.getByText('Expiring Soon')).toBeTruthy();
    expect(screen.getByText(/ending 1234/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 't1' } });
    // No issue date yet: the expiry is asked for.
    expect(screen.getByText('Give the expiry date.')).toBeTruthy();
  });

  it('a manager reads the records and gets no Add', async () => {
    payload = { credentials: [REC], types: TYPES, canEdit: false };
    const { default: CredentialsSection } = await import('./CredentialsSection');
    render(<CredentialsSection employee={PERSON} />);
    expect(await screen.findByText('CPR / First Aid')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('says where to set the list up when there is none', async () => {
    payload = { credentials: [], types: [], canEdit: true };
    const { default: CredentialsSection } = await import('./CredentialsSection');
    render(<CredentialsSection employee={PERSON} />);
    expect(await screen.findByText(/Settings > People & Access/)).toBeTruthy();
  });
});

describe('Work Limits', () => {
  it('reads each limit and saves whole numbers', async () => {
    const { default: WorkLimitsSection } = await import('./WorkLimitsSection');
    render(<WorkLimitsSection employee={PERSON} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('20 hours')).toBeTruthy();
    expect(screen.getAllByText('No limit').length).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Shifts a Week'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(calls.limits).toHaveBeenCalled());
    expect(calls.limits.mock.calls[0][1]).toEqual({ maxHoursDay: 0, maxHoursWeek: 20, maxShiftsWeek: 3, minRestHours: 0, maxDaysInRow: 0 });
  });
});
