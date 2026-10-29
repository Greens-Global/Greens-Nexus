import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Workers' comp rate on a person's pay setup (Charmi, 10/27 call, item 14:
// "it changes every year ... I would enter here in the HR module, in the
// people's module when I'm setting that up"): People > Pay, Benefits & Bank
// shows the rate in force and every earlier entry, and Save adds a new rate
// for a year - without re-saving the pay when only the rate changed.

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => true, canAccessModule: () => true, myEmail: 'hr@x.com', myRole: 'owner', myGrantedModules: new Map([['hr', 'owner']]), isExternal: false }),
}));
vi.mock('../stepup/StepUp', async (importOriginal) => ({ ...(await importOriginal()), ensureStepUp: async () => ({ ok: true }) }));
const calls = [];
vi.mock('../api', () => {
  const data = {
    getCompensation: { compensation: { base: 5133.33, currency: 'USD', payBasis: 'salary', frequency: 'monthly', benefits: [] }, bank: [], payroll: {}, rateHistory: [] },
    getWorkersCompRates: {
      rates: [{ year: 2026, ratePct: 3.5, note: '', setBy: 'hr@x.com', setAt: '2026-02-01T00:00:00+00:00' }],
      history: [{ year: 2026, ratePct: 3.5, note: '', setBy: 'hr@x.com', setAt: '2026-02-01T00:00:00+00:00' },
        { year: 2026, ratePct: 4, note: '', setBy: 'hr@x.com', setAt: '2026-01-02T00:00:00+00:00' }],
    },
  };
  const api = new Proxy({}, {
    get: (_, key) => (...args) => { calls.push([key, ...args]); return Promise.resolve(key in data ? data[key] : {}); },
  });
  return { api, default: api };
});

afterEach(() => { cleanup(); calls.length = 0; });

async function openModal() {
  const { CompensationModal } = await import('./HR');
  const toastOk = vi.fn();
  const toastErr = vi.fn();
  const onClose = vi.fn();
  render(<CompensationModal employee={{ id: 'e1', firstName: 'Valinda', lastName: 'Cranfill' }} onClose={onClose} toastOk={toastOk} toastErr={toastErr} />);
  await screen.findByText(/In force now: 3.5% \(from 2026\)/);
  return { toastOk, toastErr, onClose };
}

describe("Pay, Benefits & Bank - Workers' Comp (10/27 item 14)", () => {
  it('shows the rate in force and keeps every earlier entry', async () => {
    await openModal();
    expect(screen.getByText("WORKERS' COMP")).toBeTruthy();
    expect(screen.getByLabelText('RATE (% OF GROSS WAGES)').placeholder).toBe('In force: 3.5%');
    expect(screen.getByText('2026 · 3.5%')).toBeTruthy();
    expect(screen.getByText('2026 · 4% (replaced)')).toBeTruthy();
  }, 30000);

  it('Save adds the new rate for its year, and leaves the pay record alone when only the rate changed', async () => {
    const { toastOk } = await openModal();
    fireEvent.change(screen.getByLabelText('EFFECTIVE YEAR'), { target: { value: '2027' } });
    fireEvent.change(screen.getByLabelText('RATE (% OF GROSS WAGES)'), { target: { value: '4.25' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toastOk).toHaveBeenCalled());
    expect(calls.find((c) => c[0] === 'addWorkersCompRate')).toEqual(['addWorkersCompRate', 'e1', { year: 2027, ratePct: 4.25 }]);
    expect(calls.some((c) => c[0] === 'saveCompensation')).toBe(false);
  }, 30000);

  it('refuses a rate outside 0-100 before saving anything', async () => {
    const { toastErr } = await openModal();
    fireEvent.change(screen.getByLabelText('RATE (% OF GROSS WAGES)'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith("The workers' comp rate is a percent of gross wages, from 0 to 100."));
    expect(calls.some((c) => c[0] === 'addWorkersCompRate' || c[0] === 'saveCompensation')).toBe(false);
  }, 30000);
});
