import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Add Person (Neil, 11/03/2026): one sheet asks who is being added, and the
// kind decides the account - no Account Type select. Employee, Independent
// Contractor and Guest go to POST /hr/employees with `on_schedule`; External
// goes to POST /external-users through the invite form.

const calls = [];
vi.mock('../api', () => {
  const answers = {
    createEmployee: { id: 'n1', firstName: 'Ana', lastName: 'Ray', workEmail: '' },
    createExternalUser: { email: 'pat@partner.com', invite: { sent: true } },
    getJobRoles: [],
    getCompanyDepartments: [],
  };
  const api = new Proxy({}, {
    get: (_, key) => (...args) => { calls.push([key, args]); return Promise.resolve(key in answers ? answers[key] : []); },
  });
  return { api, default: api };
});

const AddPersonSheet = (await import('./AddPersonSheet')).default;

afterEach(() => { cleanup(); calls.length = 0; });

function renderSheet(props = {}) {
  const onSaved = vi.fn(); const onExternalSaved = vi.fn(); const onClose = vi.fn();
  render(<AddPersonSheet isAdmin entities={[{ id: 'co1', name: 'Greens Co' }]} onClose={onClose}
    onSaved={onSaved} onExternalSaved={onExternalSaved} toastOk={vi.fn()} toastErr={vi.fn()} {...props} />);
  return { onSaved, onExternalSaved, onClose };
}
const body = (key) => calls.find(([k]) => k === key)?.[1]?.[0];

describe('Add Person', () => {
  it('asks who you are adding, with no Account Type select, and On the Schedule on by default', () => {
    renderSheet();
    expect(screen.getByText('Who Are You Adding?')).toBeTruthy();
    const kinds = screen.getAllByRole('radio').map((r) => r.textContent);
    expect(kinds).toEqual(['Employee', 'Independent Contractor', 'External', 'Guest']);
    expect(screen.queryByText(/Account Type/i)).toBeNull();
    expect(screen.getByRole('switch', { name: 'On the Schedule' }).checked).toBe(true);
    expect(screen.getByText('Employment Type')).toBeTruthy();
  });

  it('an Employee posts createEmployee as internal with on_schedule', async () => {
    const { onSaved, onClose } = renderSheet();
    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Employee/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const b = body('createEmployee');
    expect(b.identity_type).toBe('internal');
    expect(b.employment_type).toBe('full_time');
    expect(b.on_schedule).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('an Independent Contractor turned off the schedule posts contractor, on_schedule false', async () => {
    const { onSaved } = renderSheet();
    fireEvent.click(screen.getByRole('radio', { name: 'Independent Contractor' }));
    expect(screen.queryByText('Employment Type')).toBeNull();
    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('switch', { name: 'On the Schedule' }));
    fireEvent.click(screen.getByRole('button', { name: /Add Independent Contractor/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const b = body('createEmployee');
    expect(b.employment_type).toBe('contractor');
    expect(b.identity_type).toBe('internal');
    expect(b.on_schedule).toBe(false);
  });

  it('a Guest posts createEmployee with identity guest', async () => {
    const { onSaved } = renderSheet();
    fireEvent.click(screen.getByRole('radio', { name: 'Guest' }));
    fireEvent.change(screen.getByLabelText('First Name *'), { target: { value: 'Gil' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Guest/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(body('createEmployee').identity_type).toBe('guest');
    expect(calls.some(([k]) => k === 'createExternalUser')).toBe(false);
  });

  it('an External goes through the invite form to createExternalUser', async () => {
    const { onExternalSaved } = renderSheet({ initialKind: 'external' });
    expect(screen.getByRole('radio', { name: 'External' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByText('First Name').nextElementSibling, { target: { value: 'Pat' } });
    fireEvent.change(screen.getByPlaceholderText('name@partnercompany.com'), { target: { value: 'pat@partner.com' } });
    const footer = screen.getAllByRole('button').filter((b) => b.className.includes('primary-btn')).pop();
    fireEvent.click(footer);
    await waitFor(() => expect(onExternalSaved).toHaveBeenCalled());
    const b = body('createExternalUser');
    expect(b.email).toBe('pat@partner.com');
    expect(b.first_name).toBe('Pat');
    expect(calls.some(([k]) => k === 'createEmployee')).toBe(false);
  });

  it('External is not offered to someone who may not add one', () => {
    renderSheet({ canAddExternal: false });
    expect(screen.queryByRole('radio', { name: 'External' })).toBeNull();
  });
});
