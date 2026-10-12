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
vi.mock('../api', () => ({ api: {
  getContactDirectory: () => Promise.resolve(payload),
  getTeamsPresence: () => Promise.resolve({ enabled: true, presence: { 'bo@x.com': { availability: 'Busy', activity: 'InACall' } } }),
} }));

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
    // Teams presence from Graph shows on the manager's pill dot and, once
    // his card is open, as a chip.
    fireEvent.click(document.querySelectorAll('.dir-row')[0]);
    expect(await screen.findByText('In a Call')).toBeTruthy();
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

  it('draws the Org Chart lens as cards, folds deeper teams, and opens the card beside it', async () => {
    const kim = { ...PEOPLE[1], email: 'kim@x.com', name: 'Kim Kay', firstName: 'Kim', lastName: 'Kay', managerEmail: 'sam@x.com', managerName: 'Sam Staff', availability: null, division: '' };
    const solo = { ...PEOPLE[1], email: 'solo@x.com', name: 'Sol Solo', firstName: 'Sol', lastName: 'Solo', managerEmail: '', managerName: '', availability: null };
    payload = { ...payload, people: [{ ...PEOPLE[0], division: 'Finance' }, PEOPLE[1], PEOPLE[2], kim, solo] };
    render(<Directory />);
    fireEvent.click(await screen.findByRole('tab', { name: /Org Chart/ }));
    await screen.findByText(/on the chart/);
    // The canvas holds Bo and his direct reports; Kim (two levels down) is
    // folded behind Sam's pill until it is opened.
    const canvas = screen.getByRole('region', { name: 'Organization chart' });
    const onChart = () => [...canvas.querySelectorAll('[data-orgkey]')].map((n) => n.getAttribute('data-orgkey'));
    expect(onChart().sort()).toEqual(['bo@x.com', 'lee@x.com', 'sam@x.com']);
    expect(screen.getByText(/5 people · 4 on the chart/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Show Sam Staff's team (1)" }));
    expect(onChart()).toContain('kim@x.com');
    // Division legend from Bo's tag; Lee's Off Today chip is on his card;
    // Sol, with no manager, is listed as not connected rather than drawn.
    expect(screen.getByRole('button', { name: /Finance/ })).toBeTruthy();
    expect(screen.getByText('Finance Lead')).toBeTruthy();
    expect(screen.getByText('Not Connected')).toBeTruthy();
    expect(document.querySelector('[data-orgkey="solo@x.com"]')).toBeTruthy();
    expect(canvas.querySelector('[data-orgkey="solo@x.com"]')).toBeNull();
    // A card opens the same contact card, Teams first, with a close control.
    fireEvent.click(screen.getByRole('button', { name: 'Lee Leave, Tech' }));
    expect(screen.getByText('Chat').closest('a').getAttribute('href')).toContain('users=lee%40x.com');
    expect(screen.getByText('Reports To')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close contact card' }));
    expect(screen.queryByText('Reports To')).toBeNull();
    // Teams chat sits on the card itself, so reaching someone never needs the card first.
    expect(screen.getByRole('link', { name: 'Chat with Bo Boss on Teams' }).getAttribute('href')).toContain('users=bo%40x.com');
    // Collapse All folds Bo's team too.
    fireEvent.click(screen.getByText('Collapse All'));
    expect(onChart()).toEqual(['bo@x.com']);
    payload = { ...payload, people: PEOPLE };
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
