// Credentials - the "Who Can Open It" picker on the credential form (Oct 29 2026).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const calls = { cvAudienceOptions: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_t, k) => (...a) => (calls[k] ? calls[k](...a) : Promise.resolve({})) }) }));
vi.mock('../tasks/components', () => ({
  Modal: ({ children, footer }) => <div>{children}{footer}</div>,
  PersonSelect: ({ value, onChange, placeholder }) => <input aria-label={placeholder} value={value || ''} onChange={(e) => onChange(e.target.value)} />,
  DateField: ({ value, onChange }) => <input aria-label="Expires On" value={value || ''} onChange={(e) => onChange(e.target.value)} />,
}));

import { CredentialForm } from './CredentialForm';

const PEOPLE = [{ email: 'ben@x.com', name: 'Ben Builder' }];

beforeEach(() => {
  calls.cvAudienceOptions.mockResolvedValue({
    companies: [{ id: 'co-a', name: 'Greens' }],
    departments: [{ name: 'IT', companyId: 'co-a' }, { name: 'Accounting', companyId: 'co-a' }],
    groups: [{ id: 'g1', name: 'Night Crew' }],
  });
});

describe('Who Can Open It', () => {
  it('starts with the department, follows the Department box, and saves the rows', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<CredentialForm cred={null} depts={['IT', 'Accounting']} people={PEOPLE} myEmail="me@x.com" nameOf={(e) => e} onClose={() => {}} onSave={onSave} />);
    expect(screen.getByText('Everyone in IT')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('IT'), { target: { value: 'Accounting' } });
    expect(screen.getByText('Everyone in Accounting')).toBeTruthy();
    expect(screen.queryByText('Everyone in IT')).toBeNull();
    // Add a company and a person; make the company view only.
    const adder = await screen.findByLabelText('Add a company, department or group');
    await waitFor(() => expect(within(adder).queryByText('Greens')).toBeTruthy());
    fireEvent.change(adder, { target: { value: 'company:co-a' } });
    expect(screen.getByText('Everyone at Greens')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Can open: Everyone at Greens' }));
    expect(screen.getByRole('button', { name: 'View only: Everyone at Greens' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add a person'), { target: { value: 'ben@x.com' } });
    expect(screen.getByText('ben@x.com')).toBeTruthy();
    // Once touched, the list no longer follows the Department box.
    fireEvent.change(screen.getByDisplayValue('Accounting'), { target: { value: 'IT' } });
    expect(screen.getByText('Everyone in Accounting')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('e.g. Stripe Dashboard'), { target: { value: 'Wi-Fi' } });
    fireEvent.change(screen.getByPlaceholderText('Enter or generate a password'), { target: { value: 'Corr3ct-Horse!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Credential' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].audiences).toEqual([
      { kind: 'department', value: 'Accounting', level: 'open' },
      { kind: 'company', value: 'co-a', level: 'view' },
      { kind: 'person', value: 'ben@x.com', level: 'open' },
    ]);
  });

  it('removes a row, and warns that broad rows are ignored on a Critical credential', async () => {
    const cred = { id: 'c1', name: 'AWS', dept: 'IT', type: 'Password', tier: 'Critical', username: 'root', owner: 'me@x.com', backupOwner: '', rotationMax: 90,
      audiences: [{ kind: 'department', value: 'IT', level: 'open', label: 'Everyone in IT' }, { kind: 'person', value: 'ben@x.com', level: 'open', label: 'ben@x.com' }] };
    render(<CredentialForm cred={cred} depts={['IT']} people={PEOPLE} myEmail="me@x.com" nameOf={(e) => (e === 'ben@x.com' ? 'Ben Builder' : e)} onClose={() => {}} onSave={vi.fn()} />);
    expect(screen.getAllByText('Ignored for Critical')).toHaveLength(1);           // the department row, not Ben
    expect(screen.getByText('Ben Builder')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Everyone in IT' }));
    expect(screen.queryByText('Everyone in IT')).toBeNull();
  });
});
