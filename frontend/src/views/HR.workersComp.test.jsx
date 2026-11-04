import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Workers' comp rate on a person's pay setup (Charmi, 10/27 call, item 14:
// "it changes every year ... I would enter here in the HR module, in the
// people's module when I'm setting that up"): People > Pay & Benefits shows
// the rate in force and every earlier entry, and Save adds a new rate for a
// year - without re-saving the pay when only the rate changed. Edited in
// place since 11/03/2026 (people/PayTab.jsx). Since 11/05/2026 (Charmi /
// Neil) each entry is a line of the insurer's sheet: State, Class Code,
// Description and Rate Per $100 of Wages.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, canAccessModule: () => true, myEmail: 'hr@x.com', myRole: 'owner', myGrantedModules: new Map([['hr', 'owner']]), isExternal: false }),
}));
vi.mock('../stepup/StepUp', async (importOriginal) => ({ ...(await importOriginal()), ensureStepUp: async () => ({ ok: true }) }));
const calls = [];
vi.mock('../api', () => {
  const now = { year: 2026, ratePct: 3.5, classCode: '8810', state: 'CA', description: 'Clerical Office Employees-NOC', note: '', setBy: 'hr@x.com', setAt: '2026-02-01T00:00:00+00:00' };
  const data = {
    getCompensation: { compensation: { base: 5133.33, currency: 'USD', payBasis: 'salary', frequency: 'monthly', benefits: [] }, bank: [], payroll: {}, rateHistory: [] },
    getWorkersCompRates: {
      rates: [now],
      history: [now, { year: 2026, ratePct: 4, note: '', setBy: 'hr@x.com', setAt: '2026-01-02T00:00:00+00:00' }],
    },
  };
  const api = new Proxy({}, {
    get: (_, key) => (...args) => { calls.push([key, ...args]); return Promise.resolve(key in data ? data[key] : {}); },
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); calls.length = 0; });

const RATE = 'Rate Per $100 of Wages';

async function openEdit() {
  const { default: PayTab } = await import('../people/PayTab');
  const toastOk = vi.fn();
  const toastErr = vi.fn();
  render(<PayTab employee={{ id: 'e1', firstName: 'Valinda', lastName: 'Cranfill' }} toastOk={toastOk} toastErr={toastErr} />);
  await screen.findByText(/In force now: CA 8810 · \$3\.5 per \$100 \(from 2026\)/);
  fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
  return { toastOk, toastErr };
}

describe("Pay & Benefits - Workers' Comp (10/27 item 14, class 11/05)", () => {
  it('shows the rate in force with its class and keeps every earlier entry', async () => {
    await openEdit();
    expect(screen.getByText("Workers' Comp")).toBeTruthy();
    expect(screen.getByLabelText(RATE).placeholder).toBe('In force: 3.5');
    expect(screen.getByLabelText('Class Code').placeholder).toBe('8810');
    expect(screen.getByLabelText('State').placeholder).toBe('CA');
    expect(screen.getByLabelText('Description').placeholder).toBe('Clerical Office Employees-NOC');
    expect(screen.getByText('2026 · CA 8810 · $3.5 per $100 · Clerical Office Employees-NOC')).toBeTruthy();
    expect(screen.getByText('2026 · $4 per $100 (replaced)')).toBeTruthy();
  }, 30000);

  it('Save adds the new rate for its year with the class in force, and leaves the pay record alone', async () => {
    const { toastOk } = await openEdit();
    fireEvent.change(screen.getByLabelText('Effective Year'), { target: { value: '2027' } });
    fireEvent.change(screen.getByLabelText(RATE), { target: { value: '4.25' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toastOk).toHaveBeenCalled());
    expect(calls.find((c) => c[0] === 'addWorkersCompRate')).toEqual(['addWorkersCompRate', 'e1',
      { year: 2027, ratePct: 4.25, classCode: '8810', state: 'CA', description: 'Clerical Office Employees-NOC' }]);
    expect(calls.some((c) => c[0] === 'saveCompensation')).toBe(false);
  }, 30000);

  it('a new class with no rate typed keeps the rate in force', async () => {
    const { toastOk } = await openEdit();
    fireEvent.change(screen.getByLabelText('Class Code'), { target: { value: '9015-1' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Building Operation-NOC' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toastOk).toHaveBeenCalled());
    expect(calls.find((c) => c[0] === 'addWorkersCompRate')).toEqual(['addWorkersCompRate', 'e1',
      { year: new Date().getFullYear(), ratePct: 3.5, classCode: '9015-1', state: 'CA', description: 'Building Operation-NOC' }]);
  }, 30000);

  it('refuses a rate outside 0-100 before saving anything', async () => {
    const { toastErr } = await openEdit();
    fireEvent.change(screen.getByLabelText(RATE), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith("The workers' comp rate is per $100 of wages, from 0 to 100."));
    expect(calls.some((c) => c[0] === 'addWorkersCompRate' || c[0] === 'saveCompensation')).toBe(false);
  }, 30000);
});
