import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Office & contact on the People profile is kept in step with Microsoft 365
// both ways (Neil, 10/07): HR sees and edits office, mobile and office phone,
// street address, city, state, ZIP and country here, and Sync Now brings in a
// change made in the Microsoft 365 admin center straight away.

const LEO = { id: 'e2', firstName: 'Leo', lastName: 'Low', workEmail: 'leo@x.com', managerEmail: '', status: 'active',
  jobTitle: 'Tech', company: 'co1', identityType: 'internal', employmentType: 'full_time', compliance: {}, contractor: {}, personal: {},
  m365Id: 'g-leo', location: 'San Clemente', phone: '949-555-0100', officePhone: '949-555-0101',
  streetAddress: '1 Main St', city: 'San Clemente', state: 'CA', postalCode: '92672', country: 'US',
  m365Sync: { at: '2026-10-07T10:00:00+00:00', error: '' } };

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ hrTeam: false, hrScope: null, can: () => true, canAccessModule: () => true, myEmail: 'hr@x.com',
    myRole: 'administrator', myGrantedModules: new Map([['hr', 'owner']]), isExternal: false }),
}));
const sync = vi.fn(() => Promise.resolve({ ...LEO, location: 'India', m365Result: { pulled: ['location'], pushed: [], error: '', writesEnabled: false } }));
vi.mock('../api', () => {
  const data = { getEmployees: [LEO], getEntities: [{ id: 'co1', name: 'Greens Co' }] };
  const api = new Proxy({}, {
    get: (_, key) => (key === 'syncEmployeeM365' ? sync : () => Promise.resolve(key in data ? data[key] : [])),
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); sync.mockClear(); });

describe('People profile - Office & contact', () => {
  it('shows the Microsoft 365 contact fields and syncs now', async () => {
    const { default: HR } = await import('./HR');
    render(<HR activeSub="hr-people" onSubChange={() => {}} />);
    fireEvent.click((await screen.findAllByText('Leo Low'))[0]);
    expect(await screen.findByText('Office & contact')).toBeTruthy();
    expect(screen.getByText('949-555-0101')).toBeTruthy();
    expect(screen.getByText('1 Main St, San Clemente, CA 92672')).toBeTruthy();
    expect(screen.getByText(/Synced with Microsoft 365 10\/07\/2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sync Now/ }));
    await waitFor(() => expect(sync).toHaveBeenCalledWith('e2'));
    expect(await screen.findByText('Updated from Microsoft 365: office.')).toBeTruthy();
  }, 20000);
});
