import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

// The person record rebuilt (Neil, 11/03/2026): each tab edits its own fields
// in place - Edit turns them on, one Save row at the foot saves them through
// the existing routes, Discard Changes puts the record back - and leaving a
// tab with unsaved edits asks first. Time & Scheduling carries the On the
// Schedule switch; the PAN is read only on Pay (Compliance, on Documents, is its
// one editable home). A manager sees the same read-only strip as before.

const LEO = { id: 'e2', firstName: 'Leo', lastName: 'Low', workEmail: 'leo@x.com', managerEmail: 'mia@x.com', status: 'active',
  jobTitle: 'Tech', company: 'co1', department: 'Ops', identityType: 'internal', employmentType: 'full_time', startDate: '2025-01-06',
  compliance: { workAuth: 'citizen', pan: 'ABCDE1234F' }, contractor: {}, personal: {}, onSchedule: true };
const MIA = { id: 'e1', firstName: 'Mia', lastName: 'Mid', workEmail: 'mia@x.com', managerEmail: 'val@x.com', status: 'active',
  jobTitle: 'Lead', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {} };

const role = { team: false };
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => (role.team
    ? { hrTeam: true, hrScope: [], can: () => false, canAccessModule: () => true, myEmail: 'val@x.com',
      myRole: 'supervisor', myGrantedModules: new Map([['hr', 'editor']]), isExternal: false }
    : { hrTeam: false, hrScope: null, can: () => true, canAccessModule: () => true, myEmail: 'hr@x.com',
      myRole: 'administrator', myGrantedModules: new Map([['hr', 'owner']]), isExternal: false }),
}));
const confirm = vi.fn(() => Promise.resolve(true));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), alert: () => Promise.resolve(), prompt: () => Promise.resolve(null), undo: () => {} } }));

const updateEmployee = vi.fn((id, body) => Promise.resolve({ ...LEO, ...(body.job_title ? { jobTitle: body.job_title } : {}) }));
const setOnSchedule = vi.fn((email, on) => Promise.resolve({ email, on, openedShiftIds: ['s1', 's2'], openedCount: 2 }));
vi.mock('../api', () => {
  const data = {
    getEmployees: [LEO, MIA], getEntities: [{ id: 'co1', name: 'Greens Co' }],
    getCompensation: { compensation: { base: 5200, currency: 'USD', payBasis: 'salary', frequency: 'monthly', benefits: [] },
      bank: [], payroll: {}, rateHistory: [], gstin: '', pan: 'ABCDE1234F' },
    getWorkersCompRates: { rates: [], history: [] },
    getGeofence: { geofence: { mode: 'onsite' }, lastPunchLocation: null, workSites: [] },
    timeSchedule: { usual: {}, shifts: [], groups: [] },
  };
  const api = new Proxy({}, {
    get: (_, key) => {
      if (key === 'updateEmployee') return updateEmployee;
      if (key === 'setOnSchedule') return setOnSchedule;
      return () => Promise.resolve(key in data ? data[key] : []);
    },
  });
  return { api, default: api };
});

beforeEach(() => { role.team = false; });
afterEach(() => { cleanup(); updateEmployee.mockClear(); setOnSchedule.mockClear(); confirm.mockClear(); confirm.mockImplementation(() => Promise.resolve(true)); });

async function openLeo() {
  const { default: HR } = await import('../views/HR');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  render(<QueryClientProvider client={new QueryClient()}><HR activeSub="hr-people" onSubChange={() => {}} /></QueryClientProvider>);
  fireEvent.click((await screen.findAllByText('Leo Low'))[0]);
  await screen.findByRole('button', { name: 'Time & Scheduling' });
}
const tabNames = () => [...screen.getByRole('button', { name: 'Time & Scheduling' }).parentElement.querySelectorAll(':scope > button')].map(b => b.textContent.trim());
const tab = (name) => fireEvent.click(screen.getByRole('button', { name }));

describe('Person record - HR', () => {
  it('shows the tabs in the new order, with no More Details or Work Mode tab', async () => {
    await openLeo();
    // Seven tabs (Neil, 11/08/2026): Checklist rides on Job, Work Logs on Time, Reimbursements on Pay, Compliance on Documents.
    expect(tabNames()).toEqual(['Overview', 'Job', 'Time & Scheduling', 'Pay', 'Documents', 'Access', 'Assets']);
    // More Details is Overview's last section now; the header has no Edit popup.
    expect(screen.getByText('More Details')).toBeTruthy();
    expect(screen.queryByText('Office & contact')).toBeNull();
    expect(screen.getByText('Office & Contact')).toBeTruthy();
  }, 30000);

  it('Job: Edit, change a field, Save calls the update once with only that field', async () => {
    await openLeo();
    tab('Job');
    expect(screen.getByRole('button', { name: 'Change Status' })).toBeTruthy();   // status is read, not typed
    expect(screen.queryByLabelText('Status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Job Title'), { target: { value: 'Senior Tech' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1));
    expect(updateEmployee).toHaveBeenCalledWith('e2', { job_title: 'Senior Tech' });
    await waitFor(() => expect(screen.queryByLabelText('Job Title')).toBeNull());   // back to reading
  }, 30000);

  it('Discard Changes puts the record back and saves nothing', async () => {
    await openLeo();
    // Overview edits per section (11/08/2026): the first Edit is Profile's.
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit$/ })[0]);
    fireEvent.change(screen.getByLabelText('Personal Email'), { target: { value: 'leo.new@gmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }));
    expect(screen.queryByLabelText('Personal Email')).toBeNull();
    expect(screen.queryByText('leo.new@gmail.com')).toBeNull();
    expect(updateEmployee).not.toHaveBeenCalled();
  }, 30000);

  it('asks before leaving a tab with unsaved edits, and stays when told to', async () => {
    await openLeo();
    tab('Job');
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(screen.getByLabelText('Designation'), { target: { value: 'Field' } });
    confirm.mockImplementation(() => Promise.resolve(false));
    tab('Overview');
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toMatch(/unsaved changes on Job/);
    expect(screen.getByLabelText('Designation').value).toBe('Field');
  }, 30000);

  it('On the Schedule: turning it off asks, calls setOnSchedule and says how many shifts opened', async () => {
    await openLeo();
    tab('Time & Scheduling');
    const sw = screen.getByRole('switch', { name: 'On the Schedule' });
    expect(sw.checked).toBe(true);
    expect(screen.getByText('Shows on the shift planner, can be given shifts and is checked for Late.')).toBeTruthy();
    fireEvent.click(sw);
    await waitFor(() => expect(setOnSchedule).toHaveBeenCalledWith('leo@x.com', false));
    expect(confirm.mock.calls[0][0]).toBe('Take Leo Low off the schedule? Their upcoming shifts become open slots. You can put them back any time.');
    expect(await screen.findByText('Leo Low is off the schedule - 2 shifts are now open slots')).toBeTruthy();
    expect(screen.getByText('Off the Schedule')).toBeTruthy();   // the header says so, plain text
    expect(screen.getByRole('switch', { name: 'On the Schedule' }).checked).toBe(false);
  }, 30000);

  it('Pay shows the PAN read only, with Edit in Compliance', async () => {
    await openLeo();
    tab('Pay');
    const pan = await screen.findByTestId('pay-pan');
    expect(within(pan).getByText('••••••234F')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.queryByLabelText(/^PAN/)).toBeNull();   // no PAN box on Pay
    fireEvent.click(within(pan).getByRole('button', { name: 'Edit in Compliance' }));
    // Untouched edit: no question, straight to Compliance.
    fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }));
    expect(screen.getByLabelText('PAN (India)').value).toBe('ABCDE1234F');
  }, 30000);
});

describe('Person record - a manager on their team', () => {
  it('sees the same read-only strip, Job read only, the switch off limits', async () => {
    role.team = true;
    await openLeo();
    expect(tabNames()).toEqual(['Overview', 'Job', 'Time & Scheduling', 'Access', 'Assets']);
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    tab('Job');
    expect(screen.getAllByText('Tech').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change Status' })).toBeNull();
    tab('Time & Scheduling');
    expect(screen.getByRole('switch', { name: 'On the Schedule' }).disabled).toBe(true);
  }, 30000);
});
