import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Contact Directory (Oct 2026) render smoke: the list groups by department
// with the lead first, a click opens the person's card with Teams first and
// the reporting line, the Reporting Line lens nests reports under managers,
// and the HR completeness chip only shows when the server sent gaps.

const PEOPLE = [
  { email: 'bo@x.com', name: 'Bo Boss', firstName: 'Bo', lastName: 'Boss', jobTitle: 'Controller', department: 'Accounting',
    departmentRole: 'lead', company: 'co1', companyName: 'Greens Co', managerEmail: '', managerName: '', mobile: '(760) 555-0101',
    officePhone: '(760) 555-0100', photoUrl: '', status: 'active', timeZone: 'America/Los_Angeles', availability: null, location: 'Escondido Office' },
  { email: 'sam@x.com', name: 'Sam Staff', firstName: 'Sam', lastName: 'Staff', jobTitle: 'Analyst', department: 'Accounting',
    departmentRole: '', company: 'co1', companyName: 'Greens Co', managerEmail: 'bo@x.com', managerName: 'Bo Boss', mobile: '', officePhone: '',
    photoUrl: '', status: 'active', timeZone: 'America/Los_Angeles', availability: { state: 'in', label: 'Clocked In', detail: 'since 8:02 AM' }, location: 'Escondido Office' },
  { email: 'lee@x.com', name: 'Lee Leave', firstName: 'Lee', lastName: 'Leave', jobTitle: 'Tech', department: 'IT',
    departmentRole: '', company: 'co1', companyName: 'Greens Co', managerEmail: 'bo@x.com', managerName: 'Bo Boss', mobile: '', officePhone: '',
    photoUrl: '', status: 'active', timeZone: 'Asia/Kolkata', availability: { state: 'off', label: 'Off Today', detail: 'through 10/12/2026' }, location: 'Hyderabad Office' },
];
let payload = { people: PEOPLE, departments: [], companies: [{ id: 'co1', name: 'Greens Co' }], me: 'sam@x.com' };

vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myGrantedModules: new Set(), myEmail: 'sam@x.com', isExternal: false }),
}));
vi.mock('../api', () => ({ api: { getContactDirectory: () => Promise.resolve(payload) } }));

const { default: Directory } = await import('./Directory');

afterEach(() => { cleanup(); payload = { ...payload, gaps: undefined }; });

describe('Contact Directory', () => {
  it('groups by department with the lead first and opens a card with Teams actions', async () => {
    render(<Directory />);
    expect(await screen.findByText('Accounting')).toBeTruthy();
    const rows = document.querySelectorAll('.dir-row');
    expect(rows[0].textContent).toContain('Bo Boss');
    expect(rows[0].textContent).toContain('Lead');
    expect(rows[2].textContent).toContain('Off Today');           // Lee's chip on the row

    fireEvent.click(rows[1]);                                     // Sam
    expect(screen.getAllByText('Sam Staff').length).toBeGreaterThan(1);
    expect(screen.getByText('Chat').closest('a').getAttribute('href')).toContain('teams.microsoft.com/l/chat/0/0?users=sam%40x.com');
    expect(screen.getByText('Video').closest('a').getAttribute('href')).toContain('withVideo=true');
    expect(screen.getByText('Clocked In')).toBeTruthy();
    expect(screen.getByText('Reports To')).toBeTruthy();
    // No HR chip for a plain employee.
    expect(screen.queryByText(/to complete/)).toBeNull();
  });

  it('nests reports under their manager in the Reporting Line lens', async () => {
    render(<Directory />);
    await screen.findByText('Accounting');
    fireEvent.click(screen.getByRole('tab', { name: /Reporting Line/ }));
    const rows = [...document.querySelectorAll('.dir-row')].map((r) => r.textContent);
    expect(rows[0]).toContain('Bo Boss');
    expect(rows.slice(1).join(' ')).toContain('Lee Leave');
    expect(rows.slice(1).join(' ')).toContain('Sam Staff');
  });

  it('shows the completeness chip when the server sends gaps', async () => {
    payload = { ...payload, gaps: { manager: ['bo@x.com'], department: [], jobTitle: [], photo: ['bo@x.com', 'sam@x.com', 'lee@x.com'], officePhone: [], departmentLead: ['IT'] } };
    render(<Directory />);
    expect(await screen.findByText('5 to complete')).toBeTruthy();
    fireEvent.click(screen.getByText('5 to complete'));
    expect(screen.getByText('Directory Completeness')).toBeTruthy();
    expect(screen.getByText('Department without a lead')).toBeTruthy();
  });
});
