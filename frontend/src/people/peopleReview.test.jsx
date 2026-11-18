import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

// People review fixes (11/16/2026), one test per bug:
//   1. Compliance: ticking one consent never drops the others.
//   2. Add Person: a contractor's rate is set only with the Pay & Benefits grant.
//   3. Time: someone the viewer cannot see in Shifts is not "No usual hours".
//   4. Pay: pay that saved is never reported as unsaved, and it is re-read.
//   5. Time: a failed Work Mode read is an error with Retry, never "On-Site".
//   6. Overview: an emergency contact edit sends only the fields that changed.
//   7. A full timestamp shows the viewer's own day, not the UTC day.

// A US evening: 01:00Z on 11/17 is still 11/16 here.
vi.hoisted(() => { process.env.TZ = 'America/Los_Angeles'; });

const calls = [];
const answers = {};
const fails = {};
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (...args) => {
      calls.push([key, args]);
      if (fails[key]) return Promise.reject(new Error(fails[key]));
      return Promise.resolve(key in answers ? (typeof answers[key] === 'function' ? answers[key](...args) : answers[key]) : []);
    },
  });
  return { api, default: api };
});
vi.mock('../stepup/StepUp', () => ({
  ensureStepUp: () => Promise.resolve({ ok: true }),
  isStepUpRequired: () => false,
  StepUpNeeded: () => null,
}));
vi.mock('../lib/useNameResolver', () => ({ useNameResolver: () => (x) => x }));
vi.mock('../components/MealWaiverCard', () => ({ default: () => null }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ hrTeam: false, canAccessModule: () => true, can: () => true, myEmail: 'hr@x.com' }),
}));

afterEach(() => {
  cleanup(); calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  for (const k of Object.keys(fails)) delete fails[k];
});
const sent = (key) => calls.filter(([k]) => k === key).map(([, a]) => a);
const saveBtn = () => screen.getAllByRole('button').find((b) => /^Save$/.test(b.textContent.trim()));

const ANA = { id: 'e1', firstName: 'Ana', lastName: 'Ray', workEmail: 'ana@x.com', identityType: 'internal',
  compliance: { consents: { bgCheck: true, dataProcessing: true } }, personal: {}, contractor: {} };

describe('People review fixes', () => {
  it('1. Compliance: ticking Handbook keeps the stored consents', async () => {
    const { default: ComplianceTab } = await import('./ComplianceTab');
    answers.updateEmployee = { ...ANA };
    render(<ComplianceTab e={ANA} canEdit onSaved={() => {}} toastErr={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.click(screen.getByLabelText('Handbook acknowledgment'));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(sent('updateEmployee').length).toBe(1));
    const [, body] = sent('updateEmployee')[0];
    expect(body.compliance.consents).toEqual({ bgCheck: true, dataProcessing: true, handbook: true });
    // The other compliance keys still go only when they changed.
    expect(Object.keys(body.compliance)).toEqual(['consents']);
  });

  it('2. Add Person: no pay grant = no rate fields and no rate sent', async () => {
    const { default: AddPersonSheet } = await import('./AddPersonSheet');
    answers.createEmployee = { id: 'n1', firstName: 'Cy', workEmail: '' };
    const onSaved = vi.fn();
    render(<AddPersonSheet initialKind="contractor" canSeeComp={false} onClose={() => {}} onSaved={onSaved} toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(screen.queryByLabelText('Rate')).toBeNull();
    expect(screen.queryByLabelText('Rate Type')).toBeNull();
    expect(screen.queryByLabelText('Currency')).toBeNull();
    fireEvent.change(screen.getByLabelText('SOW Reference'), { target: { value: 'SOW-9' } });
    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Cy' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Independent Contractor/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [body] = sent('createEmployee')[0];
    expect(body.contractor).toEqual({ sow_ref: 'SOW-9' });
  });

  it('2. Add Person: with the pay grant the rate is asked for and sent', async () => {
    const { default: AddPersonSheet } = await import('./AddPersonSheet');
    answers.createEmployee = { id: 'n1', firstName: 'Cy', workEmail: '' };
    const onSaved = vi.fn();
    render(<AddPersonSheet initialKind="contractor" canSeeComp onClose={() => {}} onSaved={onSaved} toastOk={vi.fn()} toastErr={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Rate'), { target: { value: '85' } });
    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Cy' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Independent Contractor/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent('createEmployee')[0][0].contractor.rate).toBe('85');
  });

  it('3. Time: a person outside the viewer\'s Shifts reach sends them to Shifts', async () => {
    const { default: TimeTab } = await import('./TimeTab');
    answers.getGeofence = { geofence: { mode: 'remote' }, lastPunchLocation: null, workSites: [] };
    answers.timeSchedule = { employees: [{ email: 'someone@x.com' }], offSchedule: [], usual: {}, shifts: [], groups: [] };
    render(<TimeTab e={ANA} toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('Open Shifts to see the usual hours.')).toBeTruthy();
    expect(screen.getByText('Open Shifts to see the teams.')).toBeTruthy();
    expect(screen.queryByText('No usual hours')).toBeNull();
    expect(screen.queryByText('Not on a shift team')).toBeNull();
  });

  it('3. Time: a person the viewer can see still reads No usual hours', async () => {
    const { default: TimeTab } = await import('./TimeTab');
    answers.getGeofence = { geofence: { mode: 'remote' }, lastPunchLocation: null, workSites: [] };
    answers.timeSchedule = { employees: [{ email: 'ana@x.com' }], offSchedule: [], usual: {}, shifts: [], groups: [] };
    render(<TimeTab e={ANA} toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('No usual hours')).toBeTruthy();
  });

  it('4. Pay: pay saved but the workers\' comp rate failed - says so and re-reads', async () => {
    const { default: PayTab } = await import('./PayTab');
    answers.getCompensation = { compensation: { base: '90000', payBasis: 'salary', currency: 'USD', frequency: 'biweekly' }, bank: [], payroll: {} };
    answers.getWorkersCompRates = { rates: [], history: [] };
    answers.saveCompensation = { ok: true };
    fails.addWorkersCompRate = 'Class code is not valid.';
    const toastErr = vi.fn();
    render(<PayTab employee={ANA} toastOk={vi.fn()} toastErr={toastErr} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }));
    fireEvent.change(screen.getByLabelText('Base Amount'), { target: { value: '95000' } });
    fireEvent.change(screen.getByLabelText('Rate Per $100 of Wages'), { target: { value: '0.84' } });
    const reads = sent('getCompensation').length;
    fireEvent.click(saveBtn());
    await waitFor(() => expect(toastErr).toHaveBeenCalled());
    expect(toastErr.mock.calls[0][0]).toBe("Pay saved, but the workers' comp rate was not: Class code is not valid.");
    expect(sent('saveCompensation').length).toBe(1);
    await waitFor(() => expect(sent('getCompensation').length).toBe(reads + 1));
  });

  it('5. Time: a failed Work Mode read is an error with Retry, not On-Site', async () => {
    const { default: TimeTab } = await import('./TimeTab');
    fails.getGeofence = 'The time clock did not answer.';
    answers.timeSchedule = { employees: [], usual: {}, shifts: [], groups: [] };
    render(<TimeTab e={ANA} toastOk={vi.fn()} toastErr={vi.fn()} />);
    expect(await screen.findByText('The time clock did not answer.')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /On-Site/ })).toBeNull();
    delete fails.getGeofence;
    answers.getGeofence = { geofence: { mode: 'remote' }, lastPunchLocation: null, workSites: [] };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const radio = await screen.findByRole('radio', { name: /Remote/ });
    expect(radio.getAttribute('aria-checked')).toBe('true');
  });

  it('6. Overview: fixing the contact name sends only the name, never the old phone', async () => {
    const { default: OverviewTab } = await import('./OverviewTab');
    const ray = { ...ANA, personal: { emergency: { name: 'Ann Old', relationship: 'Sister', phone: '555-0100', email: '' } } };
    answers.updateEmployee = { ...ray };
    render(<OverviewTab e={ray} canEdit onSaved={() => {}} toastOk={vi.fn()} toastErr={vi.fn()} />);
    // The Personal Details section's own Edit (Profile, Office, Personal).
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[2]);
    fireEvent.change(screen.getByLabelText('Emergency Contact Name'), { target: { value: 'Ann New' } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(sent('updateEmployee').length).toBe(1));
    const [, body] = sent('updateEmployee')[0];
    // The server merges these into the stored contact, so a phone the person
    // changed in My HR meanwhile is kept.
    expect(body.personal).toEqual({ emergency: { name: 'Ann New' } });
  });

  it('7. A paystub uploaded on a US evening shows that evening\'s day', async () => {
    const { default: PayTab } = await import('./PayTab');
    answers.getCompensation = { compensation: {}, bank: [], payroll: {} };
    answers.hrPaystubs = [{ id: 's1', fileName: 'stub.pdf', createdAt: '2026-11-17T01:00:00+00:00' }];
    render(<PayTab employee={ANA} readOnly toastOk={vi.fn()} toastErr={vi.fn()} />);
    const row = (await screen.findByText('stub.pdf')).parentElement;
    expect(within(row).getByText('11/16/2026')).toBeTruthy();
    expect(within(row).queryByText('11/17/2026')).toBeNull();
  });
});
