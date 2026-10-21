import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Request a Missing Punch (Oct 21): the Type was a <select> that looked like a
// text box, so people never picked Sick / Vacation. Every Type is now a pill
// shown at once; what each one sends is unchanged.

const cardFor = (start) => {
  const end = new Date(`${start}T12:00:00`); end.setDate(end.getDate() + 13);
  return {
    payType: 'hourly', email: 'me@x.com', name: 'Me', periodStart: start, periodEnd: end.toISOString().slice(0, 10),
    rate: 20, rateSet: true, days: [],
    totals: { regMin: 0, otMin: 0, dtMin: 0, workedMin: 0, totalPay: 0, missingPunches: 0, editedPunches: 0, pendingEdits: 0 },
  };
};
const sent = vi.hoisted(() => []);

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ instance: {}, accounts: [] }) }));
vi.mock('../contexts/RoleContext', async (importOriginal) => ({
  ...(await importOriginal()),
  useRole: () => ({ can: () => false, myLevel: 1, myGrantedModules: new Set(), canAccessModule: () => false, isExternal: false }),
}));
vi.mock('../api', () => {
  const api = new Proxy({}, {
    get: (_, key) => (arg) => {
      if (key === 'timePunchRequestCreate') { sent.push(arg); return Promise.resolve({ id: sent.length }); }
      return Promise.resolve(key === 'timeMyPayroll' ? globalThis.__cardFor(arg) : []);
    },
  });
  return { api, default: api };
});
globalThis.__cardFor = cardFor;

beforeEach(() => { sent.length = 0; });

const openRequest = async () => {
  const PayrollTimecard = (await import('./PayrollTimecard')).default;
  render(<QueryClientProvider client={new QueryClient()}><PayrollTimecard selfMode toastOk={() => {}} toastErr={() => {}} /></QueryClientProvider>);
  // The period's first day is never in the future, so its Add is always there.
  fireEvent.click((await screen.findAllByRole('button', { name: 'Add' }))[0]);
  const dialog = await screen.findByRole('dialog', { name: 'Request a missing punch' });
  return { dialog, group: within(dialog).getByRole('radiogroup', { name: 'Type' }) };
};
const send = (dialog) => {
  fireEvent.change(within(dialog).getByPlaceholderText(/Why you're adding it/), { target: { value: 'forgot' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send Request' }));
};

describe('Request a Missing Punch - Type', () => {
  it('shows every Type at once, Regular picked', async () => {
    const { group } = await openRequest();
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Regular', 'Break', 'Sick', 'Vacation', 'Personal']);
    expect(within(group).getByRole('radio', { name: 'Regular' }).getAttribute('aria-checked')).toBe('true');
  }, 20000);

  it('Regular sends no category', async () => {
    const { dialog } = await openRequest();
    send(dialog);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((b) => [b.punch_kind, b.category])).toEqual([['in', ''], ['out', '']]);
  }, 20000);

  it('Sick sends category Sick on the clock-in, as before', async () => {
    const { dialog, group } = await openRequest();
    fireEvent.click(within(group).getByRole('radio', { name: 'Sick' }));
    expect(within(group).getByRole('radio', { name: 'Sick' }).getAttribute('aria-checked')).toBe('true');
    send(dialog);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((b) => [b.punch_kind, b.category])).toEqual([['in', 'Sick'], ['out', '']]);
  }, 20000);

  it('arrow keys move the choice; only the picked pill is in the Tab order', async () => {
    const { group } = await openRequest();
    const radio = (n) => within(group).getByRole('radio', { name: n });
    expect(radio('Regular').tabIndex).toBe(0);
    expect(radio('Sick').tabIndex).toBe(-1);
    fireEvent.keyDown(radio('Regular'), { key: 'ArrowRight' });
    expect(radio('Break').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('Break'));
    fireEvent.keyDown(radio('Break'), { key: 'ArrowLeft' });
    fireEvent.keyDown(radio('Regular'), { key: 'ArrowLeft' });   // wraps to the last
    expect(radio('Personal').getAttribute('aria-checked')).toBe('true');
    expect(radio('Personal').tabIndex).toBe(0);
  }, 20000);
});
