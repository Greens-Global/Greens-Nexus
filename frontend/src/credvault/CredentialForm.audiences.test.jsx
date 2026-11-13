// Credentials - the "Who Can Open It" picker on the credential form (Oct 29 2026):
// companies and departments are picked many at a time, departments follow the
// companies, and the rows save with their level.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const calls = { cvAudienceOptions: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));
vi.mock('../tasks/components', () => ({
  Modal: ({ children, footer }) => <div>{children}{footer}</div>,
  PersonSelect: ({ value, onChange, placeholder }) => <input aria-label={placeholder} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
  DateField: ({ value, onChange }) => <input aria-label="Expires On" value={value || ''} onChange={(e) => onChange(e.target.value)} />,
}));

import { CredentialForm } from './CredentialForm';

const PEOPLE = [{ email: 'ben@x.com', name: 'Ben Builder' }];
const COMPANIES = [{ id: 'co-a', name: 'Greens' }, { id: 'co-b', name: 'Greens Nexus' }];
const DEPTS = [{ name: 'IT', companyId: 'co-a' }, { name: 'Accounting', companyId: 'co-a' }, { name: 'IT', companyId: 'co-b' }];
const chip = (name) => screen.getByRole('button', { name, pressed: undefined });

beforeEach(() => {
  calls.cvAudienceOptions.mockResolvedValue({ companies: COMPANIES, departments: DEPTS, groups: [{ id: 'g1', name: 'Night Crew', departments: ['IT'] }, { id: 'g2', name: 'Yard Team', departments: ['Yard'] }] });
});

describe('Who Can Open It', () => {
  it('picks several companies and departments at once, departments follow the companies, and saves the rows', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<CredentialForm cred={null} depts={['IT', 'Accounting']} people={PEOPLE} myEmail="me@x.com" nameOf={(e) => e} companies={COMPANIES} deptRows={DEPTS} onClose={() => {}} onSave={onSave} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Greens Nexus' })).toBeTruthy());
    // Two companies in Nexus: department chips say which company; the credential's own company (Greens) scopes them by default.
    expect(screen.getAllByRole('button', { name: /^IT/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Greens Nexus' }));                  // + a company
    expect(screen.getAllByRole('button', { name: /^IT/ })).toHaveLength(1);                   // scoped to the picked company now
    fireEvent.click(screen.getByRole('button', { name: 'Greens' }));                        // two companies
    expect(screen.getAllByRole('button', { name: /^IT/ })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: /^IT · Greens Nexus/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Accounting/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Can open: Everyone at Greens Nexus' }));   // view only
    // Access Groups follow the departments picked (11/13/2026): Yard Team has nobody in IT or Accounting.
    expect(screen.queryByRole('button', { name: 'Yard Team' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show All Groups (2)' }));
    expect(screen.getByRole('button', { name: 'Yard Team' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Night Crew' }));
    fireEvent.change(screen.getByLabelText('Add a person'), { target: { value: 'ben@x.com' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Stripe Dashboard'), { target: { value: 'Wi-Fi' } });
    fireEvent.change(screen.getByPlaceholderText('Enter or generate a password'), { target: { value: 'Corr3ct-Horse!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    expect(saved.companyId).toBe('co-a');
    expect(saved.audiences).toEqual([
      { kind: 'department', value: 'co-a:IT', level: 'open' },            // the starting row, keyed like its chip
      { kind: 'company', value: 'co-b', level: 'view' },
      { kind: 'company', value: 'co-a', level: 'open' },
      { kind: 'department', value: 'co-b:IT', level: 'open' },
      { kind: 'department', value: 'co-a:Accounting', level: 'open' },
      { kind: 'group', value: 'g1', level: 'open' },
      { kind: 'person', value: 'ben@x.com', level: 'open' },
    ]);
  });

  it('an older plain department row is its own company chip, never listed twice', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    const cred = { id: 'c2', name: 'Gate', dept: 'IT', type: 'Password', tier: 'Standard', username: 'x', owner: 'me@x.com', backupOwner: '', rotationMax: 90, companyId: 'co-a',
      audiences: [{ kind: 'department', value: 'IT', level: 'open', label: 'Everyone in IT' }] };
    render(<CredentialForm cred={cred} depts={['IT']} people={PEOPLE} myEmail="me@x.com" nameOf={(e) => e} companies={COMPANIES} deptRows={DEPTS} onClose={() => {}} onSave={onSave} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^IT/ }).getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: /^IT/ }));                            // off: the plain row goes
    expect(screen.queryByText('Everyone in IT')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^IT/ }));                            // on again: one row, company-keyed
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].audiences).toEqual([{ kind: 'department', value: 'co-a:IT', level: 'open' }]);
  });

  it('a login can be site specific: Location lists its company sites', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    const SITES = [{ id: 's1', name: 'Fresno Storage', companyIds: ['co-a'] }, { id: 's2', name: 'Delhi Office', companyIds: ['co-b'] }];
    render(<CredentialForm cred={null} depts={['IT']} people={PEOPLE} myEmail="me@x.com" nameOf={(e) => e} companies={COMPANIES} deptRows={DEPTS} sites={SITES} onClose={() => {}} onSave={onSave} />);
    const box = await screen.findByRole('combobox', { name: 'Location' });
    expect([...box.options].map((o) => o.textContent)).toEqual(['Not Site Specific', 'Fresno Storage']);
    fireEvent.change(box, { target: { value: 's1' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Company' }), { target: { value: 'co-b' } });   // another company: its sites, the pick cleared
    expect(screen.getByRole('combobox', { name: 'Location' }).value).toBe('');
    fireEvent.change(screen.getByRole('combobox', { name: 'Location' }), { target: { value: 's2' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Stripe Dashboard'), { target: { value: 'Gate' } });
    fireEvent.change(screen.getByPlaceholderText('Enter or generate a password'), { target: { value: 'Corr3ct-Horse!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ companyId: 'co-b', siteId: 's2' });
  });

  it('All Companies is one row, a second click removes a row, and Critical warns about broad rows', async () => {
    const cred = { id: 'c1', name: 'AWS', dept: 'IT', type: 'Password', tier: 'Critical', username: 'root', owner: 'me@x.com', backupOwner: '', rotationMax: 90, companyId: 'co-a',
      audiences: [{ kind: 'person', value: 'ben@x.com', level: 'open', label: 'ben@x.com' }] };
    render(<CredentialForm cred={cred} depts={['IT']} people={PEOPLE} myEmail="me@x.com" nameOf={(e) => (e === 'ben@x.com' ? 'Ben Builder' : e)} companies={COMPANIES} deptRows={DEPTS} onClose={() => {}} onSave={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('All Companies')).toBeTruthy());
    fireEvent.click(screen.getByText('All Companies'));
    expect(screen.getByText('Everyone, every company')).toBeTruthy();
    expect(screen.getAllByText('Ignored for Critical')).toHaveLength(1);
    expect(screen.getByText('Ben Builder')).toBeTruthy();
    fireEvent.click(screen.getByText('All Companies'));
    expect(screen.queryByText('Everyone, every company')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove ben@x.com' }));
    expect(screen.queryByText('Ben Builder')).toBeNull();
  });
});
