import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Settings > Companies > Departments: a Weather Calls switch per department
// (Neil, 10/29/2026). Rain advisories and weather calls apply only to the
// people of departments with it on - Construction by default - and the
// switch saves through the department update route.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
const DEPTS = [
  { id: 'd-con', name: 'Construction', sortOrder: 0, leadEmail: '', backupEmail: '', weather: true },
  { id: 'd-acct', name: 'Accounting', sortOrder: 1, leadEmail: '', backupEmail: '', weather: false },
];
const update = vi.fn((entityId, deptId, body) => Promise.resolve(DEPTS.map((d) => (d.id === deptId ? { ...d, ...body } : d))));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (key === 'updateCompanyDepartment' ? update
      : key === 'getCompanyDepartments' ? () => Promise.resolve(DEPTS) : () => Promise.resolve([])),
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); update.mockClear(); });

describe('Company departments - Weather Calls', () => {
  it('shows the switch per department and saves it', async () => {
    const { CompanyDepartments } = await import('./HR');
    const toastOk = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CompanyDepartments entity={{ id: 'co1', name: 'Greens Build' }} toastOk={toastOk} toastErr={vi.fn()} />
      </QueryClientProvider>,
    );
    const con = await screen.findByLabelText('Weather Calls for Construction');
    const acct = screen.getByLabelText('Weather Calls for Accounting');
    expect(con.checked).toBe(true);
    expect(acct.checked).toBe(false);
    expect(screen.getAllByTitle("Rain advisories and weather calls apply to this department's people. On for Construction by default.")).toHaveLength(2);
    fireEvent.click(acct);
    await waitFor(() => expect(update).toHaveBeenCalledWith('co1', 'd-acct', { weather: true }));
    await waitFor(() => expect(screen.getByLabelText('Weather Calls for Accounting').checked).toBe(true));
    expect(toastOk).toHaveBeenCalledWith('Weather calls now apply to Accounting.');
    fireEvent.click(screen.getByLabelText('Weather Calls for Construction'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('co1', 'd-con', { weather: false }));
  }, 20000);
});
