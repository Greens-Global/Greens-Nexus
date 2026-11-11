import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The person record when a read fails, and its one-record deletes (People
// review, 11/11/2026):
//   - Pay: a failed compensation read is an error with Retry and NO Edit - an
//     empty record used to be offered for editing, and a save from it replaced
//     the real pay and bank accounts with blanks.
//   - Documents / Assets: a failed read says so, never "No documents yet."
//   - Documents: Delete is held on the row (HoldButton) - a click alone only
//     asks (the assistive-tech fallback), never deletes.
//   - Change Status offers Offboard Instead, which opens Offboard.

const LEO = { id: 'e2', firstName: 'Leo', lastName: 'Low', workEmail: 'leo@x.com', managerEmail: 'mia@x.com', status: 'active',
  jobTitle: 'Tech', company: 'co1', department: 'Ops', identityType: 'internal', employmentType: 'full_time', startDate: '2025-01-06',
  compliance: {}, contractor: {}, personal: {}, onSchedule: true };

const mode = { docsFail: false };
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ hrTeam: false, hrScope: null, can: () => true, canAccessModule: () => true, myEmail: 'hr@x.com',
    myRole: 'administrator', myGrantedModules: new Map([['hr', 'owner']]), isExternal: false }),
}));
const confirm = vi.fn(() => Promise.resolve(false));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), alert: () => Promise.resolve(), prompt: () => Promise.resolve(null), undo: () => {} } }));

const getCompensation = vi.fn(() => Promise.reject(new Error('The pay service did not answer.')));
const deleteEmployeeDoc = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../api', () => {
  const data = {
    getEmployees: [LEO], getEntities: [{ id: 'co1', name: 'Greens Co' }],
    getWorkersCompRates: { rates: [], history: [] },
    getGeofence: { geofence: { mode: 'onsite' }, lastPunchLocation: null, workSites: [] },
    timeSchedule: { usual: {}, shifts: [], groups: [] },
  };
  const api = new Proxy({}, {
    get: (_, key) => {
      if (key === 'getCompensation') return getCompensation;
      if (key === 'deleteEmployeeDoc') return deleteEmployeeDoc;
      if (key === 'getEmployeeDocs') {
        return () => (mode.docsFail ? Promise.reject(new Error('Documents are unavailable.'))
          : Promise.resolve([{ id: 'd1', kind: 'contract', fileName: 'contract.pdf', sizeBytes: 2048 }]));
      }
      if (key === 'getEmployeeAssets') return () => Promise.reject(new Error('Items is unavailable.'));
      return () => Promise.resolve(key in data ? data[key] : []);
    },
  });
  return { api, default: api };
});

afterEach(() => {
  cleanup(); mode.docsFail = false;
  getCompensation.mockClear(); deleteEmployeeDoc.mockClear(); confirm.mockClear();
});

async function openLeo() {
  const { default: HR } = await import('../views/HR');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  render(<QueryClientProvider client={new QueryClient()}><HR activeSub="hr-people" onSubChange={() => {}} /></QueryClientProvider>);
  fireEvent.click((await screen.findAllByText('Leo Low'))[0]);
  await screen.findByRole('button', { name: 'Time & Scheduling' });
}
const tab = (name) => fireEvent.click(screen.getByRole('button', { name }));

describe('Person record - failed reads and deletes', () => {
  it('Pay: a failed read shows the error with Retry and offers no Edit', async () => {
    await openLeo();
    tab('Pay');
    expect(await screen.findByText('The pay service did not answer.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    expect(screen.queryByText('No pay recorded yet.')).toBeNull();
    const before = getCompensation.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getCompensation.mock.calls.length).toBe(before + 1));
  }, 30000);

  it('Documents: a failed read says so instead of "No documents yet."', async () => {
    mode.docsFail = true;
    await openLeo();
    tab('Documents');
    expect(await screen.findByText('Documents are unavailable.')).toBeTruthy();
    expect(screen.queryByText('No documents yet.')).toBeNull();
  }, 30000);

  it('Assets: a failed read says so instead of "No assigned equipment"', async () => {
    await openLeo();
    tab('Assets');
    expect(await screen.findByText('Items is unavailable.')).toBeTruthy();
    expect(screen.queryByText(/No assigned equipment/)).toBeNull();
  }, 30000);

  it('Documents: Delete is a hold - a click alone asks and, declined, deletes nothing', async () => {
    await openLeo();
    tab('Documents');
    const del = await screen.findByRole('button', { name: /Delete contract\.pdf/ });
    fireEvent.click(del);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(deleteEmployeeDoc).not.toHaveBeenCalled();
  }, 30000);

  it('Change Status: Offboard Instead opens Offboard', async () => {
    await openLeo();
    tab('Job');
    fireEvent.click(screen.getByRole('button', { name: 'Change Status' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Offboard Instead' }));
    expect(await screen.findByText('Offboard - Leo Low')).toBeTruthy();
  }, 30000);
});
