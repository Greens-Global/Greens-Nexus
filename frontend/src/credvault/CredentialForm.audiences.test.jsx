// Credentials - the credential form (Oct 29 2026, reworked 11/13/2026): Company
// first (several, or All), then Department (several, or All) from the companies
// picked - those picks are who can open it; Access Groups and people are added
// below. Fields that need fixing say so in red; Expires On follows Rotate Every.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const calls = { cvAudienceOptions: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));
vi.mock('../tasks/components', () => ({
  Modal: ({ children, footer }) => <div>{children}{footer}</div>,
  PersonSelect: ({ value, onChange, placeholder }) => <input aria-label={placeholder} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
  DateField: ({ value, onChange }) => <input aria-label="Expires On" value={value || ''} onChange={(e) => onChange(e.target.value)} />,
  // The dropdown, flattened: each option a toggle button (pressed = picked).
  ChipMultiSelect: ({ value, onChange, options }) => (
    <div>{options.map((o) => (
      <button key={o.id} type="button" aria-pressed={value.includes(o.id)}
        onClick={() => onChange(value.includes(o.id) ? value.filter((x) => x !== o.id) : [...value, o.id])}>{o.label}</button>
    ))}</div>
  ),
}));

import { CredentialForm, resetAudienceOptions } from './CredentialForm';

const PEOPLE = [{ email: 'ben@x.com', name: 'Ben Builder' }];
const COMPANIES = [{ id: 'co-a', name: 'Greens' }, { id: 'co-b', name: 'Greens Nexus' }];
const DEPTS = [{ name: 'IT', companyId: 'co-a' }, { name: 'Accounting', companyId: 'co-a' }, { name: 'IT', companyId: 'co-b' }];
const OPTIONS = { companies: COMPANIES, departments: DEPTS, groups: [{ id: 'g1', name: 'Night Crew', departments: ['IT'] }, { id: 'g2', name: 'Yard Team', departments: ['Yard'] }] };
const companiesBox = () => within(document.querySelector('[data-scope="companies"]'));
const deptsBox = () => within(document.querySelector('[data-scope="departments"]'));
const groupsBox = () => within(document.querySelector('[data-scope="groups"]'));
const form = (props = {}) => render(<CredentialForm cred={null} people={PEOPLE} myEmail="me@x.com" nameOf={(e) => e} companies={COMPANIES} onClose={() => {}} onSave={vi.fn()} {...props} />);
const fillBasics = () => {
  fireEvent.change(screen.getByPlaceholderText('e.g. Stripe Dashboard'), { target: { value: 'Wi-Fi' } });
  fireEvent.change(screen.getByPlaceholderText('Enter or generate a password'), { target: { value: 'Corr3ct-Horse!' } });
};

beforeEach(() => {
  resetAudienceOptions();
  calls.cvAudienceOptions.mockReset();
  calls.cvAudienceOptions.mockResolvedValue(OPTIONS);
});

describe('Company, then Department', () => {
  it('opens Department once a company is picked, lists its departments, and saves the picks as who can open it', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    form({ onSave });
    await waitFor(() => expect(companiesBox().getByRole('button', { name: 'Greens Nexus' })).toBeTruthy());
    expect(document.querySelector('[data-scope="departments"]')).toBeNull();                   // no company yet
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens' }));
    expect(deptsBox().getAllByRole('button').map((b) => b.textContent)).toEqual(['All Departments', 'IT', 'Accounting']);
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens Nexus' }));          // several companies
    expect(deptsBox().getAllByRole('button').map((b) => b.textContent)).toEqual(['All Departments', 'IT · Greens', 'Accounting · Greens', 'IT · Greens Nexus']);
    fireEvent.click(deptsBox().getByRole('button', { name: 'IT · Greens' }));
    fireEvent.click(deptsBox().getByRole('button', { name: 'IT · Greens Nexus' }));
    // Access Groups (optional) follow the departments: Yard Team has nobody in IT.
    expect(groupsBox().getAllByRole('button').map((b) => b.textContent)).toEqual(['Night Crew']);
    expect(screen.getByText(/None picked = everyone in the departments above/)).toBeTruthy();
    fireEvent.click(groupsBox().getByRole('button', { name: 'Night Crew' }));         // keep it to the Night Crew
    fireEvent.change(screen.getByLabelText('Add a person'), { target: { value: 'ben@x.com' } });
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    expect(saved).toMatchObject({ dept: 'IT', companyId: 'co-a' });                          // the first ones picked
    expect(saved.audiences).toEqual([
      { kind: 'department', value: 'co-a:IT', level: 'open' },
      { kind: 'department', value: 'co-b:IT', level: 'open' },
      { kind: 'only_group', value: 'g1', level: 'open' },
      { kind: 'person', value: 'ben@x.com', level: 'open' },
    ]);
  });

  it('All departments = everyone at each company picked; All companies picks every company', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    form({ onSave });
    await waitFor(() => expect(companiesBox().getByRole('button', { name: 'Greens' })).toBeTruthy());
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens' }));
    fireEvent.click(deptsBox().getByRole('button', { name: 'All Departments' }));
    expect(deptsBox().getByRole('button', { name: 'All Departments' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(companiesBox().getByRole('button', { name: 'All Companies' }));        // + Greens Nexus, still All
    expect(companiesBox().getByRole('button', { name: 'All Companies' }).getAttribute('aria-pressed')).toBe('true');
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].audiences).toEqual([
      { kind: 'company', value: 'co-a', level: 'open' },
      { kind: 'company', value: 'co-b', level: 'open' },
    ]);
  });

  it('an older plain department row is its own company chip, never listed twice', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    const cred = { id: 'c2', name: 'Gate', dept: 'IT', type: 'Password', tier: 'Standard', username: 'x', url: '', owner: 'me@x.com', backupOwner: '', rotationMax: 90, companyId: 'co-a',
      audiences: [{ kind: 'department', value: 'IT', level: 'open', label: 'Everyone in IT' }] };
    form({ cred, onSave });
    await waitFor(() => expect(deptsBox().getByRole('button', { name: 'IT' }).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(deptsBox().getByRole('button', { name: 'IT' }));                        // off: the plain row goes
    expect(screen.queryByText('Everyone in IT')).toBeNull();
    fireEvent.click(deptsBox().getByRole('button', { name: 'IT' }));                        // on again: one row, company-keyed
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].audiences).toEqual([{ kind: 'department', value: 'co-a:IT', level: 'open' }]);
  });

  it('a new login starts on the person\'s own company and department', async () => {
    calls.cvAudienceOptions.mockResolvedValue({ ...OPTIONS, me: { companyId: 'co-b', dept: 'IT' } });
    const onSave = vi.fn().mockResolvedValue({});
    form({ onSave });
    await waitFor(() => expect(companiesBox().getByRole('button', { name: 'Greens Nexus' }).getAttribute('aria-pressed')).toBe('true'));
    expect(deptsBox().getByRole('button', { name: 'IT' }).getAttribute('aria-pressed')).toBe('true');
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ companyId: 'co-b', dept: 'IT', audiences: [{ kind: 'department', value: 'co-b:IT', level: 'open' }] });
  });

  it('a failed load says so and Retry loads again, never "No departments set up"', async () => {
    calls.cvAudienceOptions.mockRejectedValueOnce(new Error('502'));
    form();
    expect((await screen.findAllByText('Could not load the companies and departments.')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No departments set up/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(await screen.findByRole('button', { name: 'Greens Nexus' })).toBeTruthy();
  });
});

describe('Checks and dates', () => {
  it('Save shows each field that needs fixing in red, and sends nothing', async () => {
    const onSave = vi.fn();
    form({ onSave });
    await waitFor(() => expect(companiesBox().getByRole('button', { name: 'Greens' })).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('https://…'), { target: { value: 'portal.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Give the login a name.')).toBeTruthy();
    expect(screen.getByText('Pick at least one company.')).toBeTruthy();
    expect(screen.getByText('Enter or generate a password.')).toBeTruthy();
    expect(screen.getByText(/The link must start with http:\/\/ or https:\/\//)).toBeTruthy();
    expect(screen.getByPlaceholderText('https://…').className).toContain('cv-ipt-error');
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens' }));
    expect(screen.getByText('Pick at least one department, or All.')).toBeTruthy();
  });

  it('a weak or leaked password the server refuses shows in red under Password', async () => {
    const refusal = Object.assign(new Error('weak'), { detail: { code: 'weak_password', field: 'secret', message: 'This password is weak - use 12 or more characters.' } });
    const onSave = vi.fn().mockRejectedValue(refusal);
    form({ onSave });
    await waitFor(() => expect(companiesBox().getByRole('button', { name: 'Greens' })).toBeTruthy());
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens' }));
    fireEvent.click(deptsBox().getByRole('button', { name: 'IT' }));
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    expect(await screen.findByText('This password is weak - use 12 or more characters.')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter or generate a password').className).toContain('cv-ipt-error');
    fireEvent.change(screen.getByPlaceholderText('Enter or generate a password'), { target: { value: 'Another-Strong-1!' } });
    expect(screen.queryByText('This password is weak - use 12 or more characters.')).toBeNull();   // typing clears it
  });

  it('Expires On follows Rotate Every until a date is picked by hand', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    form({ onSave });
    await waitFor(() => expect(companiesBox().getByRole('button', { name: 'Greens' })).toBeTruthy());
    const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    expect(screen.getByLabelText('Expires On').value).toBe(inDays(90));
    fireEvent.click(screen.getByRole('button', { name: '365d' }));
    expect(screen.getByLabelText('Expires On').value).toBe(inDays(365));
    fireEvent.change(screen.getByLabelText('Expires On'), { target: { value: '2027-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: '60d' }));
    expect(screen.getByLabelText('Expires On').value).toBe('2027-01-15');                     // a date of your own stays
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens' }));
    fireEvent.click(deptsBox().getByRole('button', { name: 'IT' }));
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ rotationMax: 60, expiresAt: '2027-01-15' });
  });

  it('a login can be site specific: Location lists the sites of the companies picked', async () => {
    const SITES = [{ id: 's1', name: 'Fresno Storage', companyIds: ['co-a'] }, { id: 's2', name: 'Delhi Office', companyIds: ['co-b'] }];
    form({ sites: SITES });
    await waitFor(() => expect(companiesBox().getByRole('button', { name: 'Greens' })).toBeTruthy());
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens' }));
    const box = screen.getByRole('combobox', { name: 'Location' });
    expect([...box.options].map((o) => o.textContent)).toEqual(['Not Site Specific', 'Fresno Storage']);
    fireEvent.change(box, { target: { value: 's1' } });
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens' }));                // Greens off: its site goes too
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens Nexus' }));
    expect(screen.getByRole('combobox', { name: 'Location' }).value).toBe('');
    expect([...screen.getByRole('combobox', { name: 'Location' }).options].map((o) => o.textContent)).toEqual(['Not Site Specific', 'Delhi Office']);
  });

  it('Critical warns that department and company rows are ignored', async () => {
    const cred = { id: 'c1', name: 'AWS', dept: 'IT', type: 'Password', tier: 'Critical', username: 'root', url: '', owner: 'me@x.com', backupOwner: '', rotationMax: 90, companyId: 'co-a',
      audiences: [{ kind: 'person', value: 'ben@x.com', level: 'open', label: 'ben@x.com' }] };
    form({ cred, nameOf: (e) => (e === 'ben@x.com' ? 'Ben Builder' : e) });
    await waitFor(() => expect(companiesBox().getByRole('button', { name: 'Greens' })).toBeTruthy());
    fireEvent.click(companiesBox().getByRole('button', { name: 'Greens' }));
    fireEvent.click(deptsBox().getByRole('button', { name: 'IT' }));
    expect(screen.getAllByText('Ignored for Critical')).toHaveLength(1);
    expect(screen.getByText('Ben Builder')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove ben@x.com' }));
    expect(screen.queryByText('Ben Builder')).toBeNull();
  });
});
