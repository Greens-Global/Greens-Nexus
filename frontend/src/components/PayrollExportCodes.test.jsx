import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Payroll Export Codes (Neil, Oct 17 2026): one box per pay class with the
// default as its placeholder, per company; Save sends the typed names, Use
// the Default sends none. One Save row: Save disabled until a box changes.

const apiMock = vi.hoisted(() => ({ getEntities: vi.fn(), timeExportCodesGet: vi.fn(), timeExportCodesSet: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import PayrollExportCodes from './PayrollExportCodes';

const DEFAULTS = [['regular', 'Regular Pay'], ['overtime', 'Overtime Pay'], ['doubleTime', 'Double-time Pay'],
  ['holiday', 'Holiday Pay'], ['sick', 'Sick Pay'], ['vacation', 'Vacation Pay'], ['personal', 'Personal Pay']];
const payload = (company, custom = {}, qb = '') => ({
  company, maxLength: 31,
  quickbooksCompanyName: qb, quickbooksCompanyDefault: company === 'co-b' ? 'Greens India' : 'Greens Global',
  classes: DEFAULTS.map(([key, d]) => ({ key, default: d, code: custom[key] || d, custom: key in custom })),
});

beforeEach(() => {
  apiMock.getEntities.mockReset().mockResolvedValue([{ id: 'co-a', name: 'Greens Global' }, { id: 'co-b', name: 'Greens India' }]);
  apiMock.timeExportCodesGet.mockReset().mockImplementation((co) => Promise.resolve(payload(co, co === 'co-b' ? { regular: 'REG-IN' } : {})));
  apiMock.timeExportCodesSet.mockReset().mockImplementation((co, codes, qb) => Promise.resolve(payload(co, Object.fromEntries(Object.entries(codes).filter(([, v]) => v.trim())), (qb || '').trim())));
});

describe('PayrollExportCodes', () => {
  it('shows one box per pay class with the default as placeholder', async () => {
    render(<PayrollExportCodes />);
    const reg = await screen.findByLabelText('Regular code');
    expect(reg.getAttribute('placeholder')).toBe('Regular Pay');
    expect(reg.value).toBe('');
    expect(screen.getByLabelText('Double Time (2x) code').getAttribute('placeholder')).toBe('Double-time Pay');
    expect(screen.getAllByRole('textbox')).toHaveLength(9);   // seven pay classes + the QuickBooks company name + its create time
    expect(apiMock.timeExportCodesGet).toHaveBeenCalledWith('co-a');
    // Nothing changed and nothing custom yet: Save disabled, no Use the Default.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Use the Default' })).toBeNull();
  });

  it('enables Save and shows Discard Changes only once a box changes', async () => {
    render(<PayrollExportCodes />);
    const sick = await screen.findByLabelText('Sick code');
    fireEvent.change(sick, { target: { value: 'SICK' } });
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }));
    expect(sick.value).toBe('');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('names the meal and rest premium classes instead of showing their keys', async () => {
    apiMock.timeExportCodesGet.mockReset().mockResolvedValue({
      ...payload('co-a'),
      classes: [{ key: 'mealPremium', default: 'Meal Premium', code: 'Meal Premium', custom: false },
        { key: 'restPremium', default: 'Rest Premium', code: 'Rest Premium', custom: false }],
    });
    render(<PayrollExportCodes />);
    expect(await screen.findByLabelText('Meal Premium code')).toBeTruthy();
    expect(screen.getByLabelText('Rest Premium code')).toBeTruthy();
    expect(screen.queryByText('mealPremium')).toBeNull();
  });

  it('reports whether a fixed company has names of its own', async () => {
    const onOverride = vi.fn();
    render(<PayrollExportCodes company="co-b" onOverride={onOverride} />);
    await waitFor(() => expect(onOverride).toHaveBeenCalledWith(true));
    expect(screen.queryByLabelText('Company')).toBeNull();
  });

  it('saves the typed names for the picked company', async () => {
    const toastOk = vi.fn();
    render(<PayrollExportCodes toastOk={toastOk} />);
    fireEvent.change(await screen.findByLabelText('Overtime (1.5x) code'), { target: { value: 'OT 1.5x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.timeExportCodesSet).toHaveBeenCalled());
    const [co, codes] = apiMock.timeExportCodesSet.mock.calls[0];
    expect(co).toBe('co-a');
    expect(codes.overtime).toBe('OT 1.5x');
    expect(codes.regular).toBe('');
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Payroll export codes saved.'));
    expect(screen.getByLabelText('Overtime (1.5x) code').value).toBe('OT 1.5x');
  });

  it('switches company and resets that company to default', async () => {
    render(<PayrollExportCodes />);
    fireEvent.change(await screen.findByLabelText('Company'), { target: { value: 'co-b' } });
    await waitFor(() => expect(screen.getByLabelText('Regular code').value).toBe('REG-IN'));
    fireEvent.click(screen.getByRole('button', { name: 'Use the Default' }));
    // Use the Default resets names - never the saved create time (the 4th
    // argument stays undefined so the server leaves it alone).
    await waitFor(() => expect(apiMock.timeExportCodesSet).toHaveBeenCalledWith('co-b', {}, '', undefined));
    await waitFor(() => expect(screen.getByLabelText('Regular code').value).toBe(''));
  });

  it('saves the QuickBooks company name the IIF header carries', async () => {
    render(<PayrollExportCodes />);
    const qb = await screen.findByLabelText('QuickBooks Company Name');
    expect(qb.getAttribute('placeholder')).toBe('Greens Global');
    fireEvent.change(qb, { target: { value: 'Greens Global, Inc.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.timeExportCodesSet).toHaveBeenCalled());
    expect(apiMock.timeExportCodesSet.mock.calls[0][2]).toBe('Greens Global, Inc.');
    expect(await screen.findByRole('button', { name: 'Use the Default' })).toBeTruthy();
  });

  it('asks before its own company select drops unsaved names', async () => {
    const guard = await import('../lib/dialogGuard');
    const ask = vi.spyOn(guard, 'confirmDiscard').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<PayrollExportCodes />);
    fireEvent.change(await screen.findByLabelText('Sick code'), { target: { value: 'SICK' } });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-b' } });
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Sick code').value).toBe('SICK');
    expect(apiMock.timeExportCodesGet).not.toHaveBeenCalledWith('co-b');
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-b' } });
    await waitFor(() => expect(screen.getByLabelText('Regular code').value).toBe('REG-IN'));
    expect(screen.getByLabelText('Sick code').value).toBe('');
    ask.mockRestore();
  });

  it('shows an error with Retry when the codes cannot load', async () => {
    apiMock.timeExportCodesGet.mockReset().mockRejectedValueOnce(new Error('Nope')).mockResolvedValue(payload('co-a'));
    render(<PayrollExportCodes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Regular code')).toBeTruthy();
  });
  it('reads a QuickBooks Timer Lists file into the boxes, unsaved until Save', async () => {
    render(<PayrollExportCodes />);
    await screen.findByLabelText('Regular code');
    const text = ['!TIMERHDR\tVER\tREL\tCOMPANYNAME\tIMPORTEDBEFORE\tFROMTIMER\tCOMPANYCREATETIME',
      'TIMERHDR\t8\t0\tMCD Service, Inc.\tN\tN\t1475877092',
      '!PAYITEM\tNAME\tHIDDEN',
      'PAYITEM\tHourly Rate\tN',
      'PAYITEM\tVacation Hourly\tN'].join('\r\n');
    const file = new File([text], 'timer.iif');
    fireEvent.change(screen.getByLabelText('QuickBooks Timer Lists file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('Regular code').value).toBe('Hourly Rate'));
    expect(screen.getByLabelText('Vacation code').value).toBe('Vacation Hourly');
    expect(screen.getByLabelText('QuickBooks Company Name').value).toBe('MCD Service, Inc.');
    expect(screen.getByLabelText('QuickBooks Company Create Time').value).toBe('1475877092');
    expect(screen.getByText(/Read 2 payroll items/)).toBeTruthy();
    expect(apiMock.timeExportCodesSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.timeExportCodesSet).toHaveBeenCalled());
    const [, codes, qb, created] = apiMock.timeExportCodesSet.mock.calls[0];
    expect(codes.regular).toBe('Hourly Rate');
    expect(qb).toBe('MCD Service, Inc.');
    expect(created).toBe('1475877092');
  });

  it('saves Leave Customer:Job Blank on click and keeps the saved names', async () => {
    apiMock.timeExportCodesGet.mockReset().mockResolvedValue(payload('co-a', { regular: 'Hourly Rate' }));
    render(<PayrollExportCodes />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Leave Customer:Job Blank' }));
    await waitFor(() => expect(apiMock.timeExportCodesSet).toHaveBeenCalled());
    const [co, codes, qb, created, blank] = apiMock.timeExportCodesSet.mock.calls[0];
    expect(co).toBe('co-a');
    expect(codes.regular).toBe('Hourly Rate');
    expect(qb).toBeUndefined();
    expect(created).toBeUndefined();
    expect(blank).toBe(true);
  });
});
