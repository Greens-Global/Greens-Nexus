import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Shift Differentials and Call-Back Pay (Neil, Oct 17 2026): off by default
// per company; the switches save on click; switching it on opens the rule
// editor; its one Save sends the typed rules over the switches as saved.

const apiMock = vi.hoisted(() => ({ getEntities: vi.fn(), timePremiumsGet: vi.fn(), timePremiumsSet: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import PayPremiums, { ruleSummary } from './PayPremiums';

const OFF = { company: 'co-a', enabled: false, differentials: [], callBack: { enabled: false, minimumMin: 120, gapMin: 60 },
  sites: [{ id: 's1', name: 'Alpha Yard' }], maxRules: 20 };

beforeEach(() => {
  apiMock.getEntities.mockReset().mockResolvedValue([{ id: 'co-a', name: 'Greens Global' }, { id: 'co-b', name: 'Greens India' }]);
  apiMock.timePremiumsGet.mockReset().mockImplementation((co) => Promise.resolve({ ...OFF, company: co }));
  apiMock.timePremiumsSet.mockReset().mockImplementation((co, cfg) => Promise.resolve({ ...OFF, ...cfg, company: co,
    differentials: cfg.differentials.map((r, i) => ({ ...r, id: r.id || `r${i}` })) }));
});

describe('PayPremiums', () => {
  it('is off by default with nothing to save', async () => {
    render(<PayPremiums />);
    const toggle = await screen.findByLabelText('Pay Shift Differentials and Call-Back Pay');
    expect(toggle.checked).toBe(false);
    expect(screen.queryByText('Add Differential')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();   // off: no rules to type
    expect(apiMock.timePremiumsGet).toHaveBeenCalledWith('co-a');
  });

  it('saves each switch on click, then saves the typed rule through the one Save row', async () => {
    const toastOk = vi.fn();
    render(<PayPremiums toastOk={toastOk} />);
    fireEvent.click(await screen.findByLabelText('Pay Shift Differentials and Call-Back Pay'));
    await waitFor(() => expect(apiMock.timePremiumsSet).toHaveBeenCalledTimes(1));
    expect(apiMock.timePremiumsSet.mock.calls[0][1].enabled).toBe(true);
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Shift differentials are on for this company.'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Add Differential/ }));
    fireEvent.change(screen.getByLabelText('Differential name'), { target: { value: 'Night Differential' } });
    fireEvent.change(screen.getByLabelText('Differential amount'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '06:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha Yard' }));
    // Call-back pay saves on its own, without the half-made rule beside it...
    fireEvent.click(screen.getByLabelText('Call-Back Pay'));
    await waitFor(() => expect(apiMock.timePremiumsSet).toHaveBeenCalledTimes(2));
    expect(apiMock.timePremiumsSet.mock.calls[1][1].differentials).toEqual([]);
    expect(apiMock.timePremiumsSet.mock.calls[1][1].callBack.enabled).toBe(true);
    // ...and the rule is still the draft.
    await waitFor(() => expect(screen.getByLabelText('Call-Back Pay').checked).toBe(true));
    expect(screen.getByLabelText('Differential name').value).toBe('Night Differential');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.timePremiumsSet).toHaveBeenCalledTimes(3));
    const [co, cfg] = apiMock.timePremiumsSet.mock.calls[2];
    expect(co).toBe('co-a');
    expect(cfg.enabled).toBe(true);
    expect(cfg.differentials).toEqual([{ id: '', name: 'Night Differential', kind: 'flat', amount: 2, start: '22:00', end: '06:00', days: [6], sites: ['s1'] }]);
    expect(cfg.callBack).toEqual({ enabled: true, minimumMin: 120, gapMin: 60 });
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Shift differentials saved.'));
  });

  it('a differential window can be cleared again (both times or neither)', async () => {
    render(<PayPremiums />);
    fireEvent.click(await screen.findByLabelText('Pay Shift Differentials and Call-Back Pay'));
    await waitFor(() => expect(apiMock.timePremiumsSet).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Add Differential/ }));
    const start = screen.getByLabelText('Window start');
    fireEvent.change(start, { target: { value: '22:00' } });
    expect(start.value).toBe('22:00');
    // The blank choice stays after a time is picked, so the window can be emptied.
    expect([...start.options].map(o => o.textContent)[0]).toBe('No Window');
    fireEvent.change(start, { target: { value: '' } });
    expect(start.value).toBe('');
  });

  it('a switch that fails to save goes back', async () => {
    const toastErr = vi.fn();
    apiMock.timePremiumsSet.mockReset().mockRejectedValue(new Error('No'));
    render(<PayPremiums toastErr={toastErr} />);
    const toggle = await screen.findByLabelText('Pay Shift Differentials and Call-Back Pay');
    fireEvent.click(toggle);
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith('No'));
    expect(toggle.checked).toBe(false);
  });

  it('describes a rule in US time', () => {
    expect(ruleSummary({ kind: 'flat', amount: 2, start: '22:00', end: '06:00', days: [0, 6], sites: [] }))
      .toBe('$2.00 per hour · 10:00 PM - 6:00 AM · Sun, Sat');
    expect(ruleSummary({ kind: 'percent', amount: 10, start: '', end: '', days: [], sites: [] }))
      .toBe('10% of the base rate per hour · all hours worked');
  });

  it('shows an error with Retry when the rule cannot load', async () => {
    apiMock.timePremiumsGet.mockReset().mockRejectedValueOnce(new Error('Nope')).mockResolvedValue(OFF);
    render(<PayPremiums />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Pay Shift Differentials and Call-Back Pay')).toBeTruthy();
  });
});
