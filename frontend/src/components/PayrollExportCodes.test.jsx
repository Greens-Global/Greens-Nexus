import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Payroll Export Codes (Neil, Oct 17 2026): one box per pay class with the
// default as its placeholder, per company; Save sends the typed names, Reset
// to Default sends none.

const apiMock = vi.hoisted(() => ({ getEntities: vi.fn(), timeExportCodesGet: vi.fn(), timeExportCodesSet: vi.fn() }));
vi.mock('../api', () => ({ api: apiMock }));

import PayrollExportCodes from './PayrollExportCodes';

const DEFAULTS = [['regular', 'Regular Pay'], ['overtime', 'Overtime Pay'], ['doubleTime', 'Double-time Pay'],
  ['holiday', 'Holiday Pay'], ['sick', 'Sick Pay'], ['vacation', 'Vacation Pay'], ['personal', 'Personal Pay']];
const payload = (company, custom = {}) => ({
  company, maxLength: 31,
  classes: DEFAULTS.map(([key, d]) => ({ key, default: d, code: custom[key] || d, custom: key in custom })),
});

beforeEach(() => {
  apiMock.getEntities.mockReset().mockResolvedValue([{ id: 'co-a', name: 'Greens Global' }, { id: 'co-b', name: 'Greens India' }]);
  apiMock.timeExportCodesGet.mockReset().mockImplementation((co) => Promise.resolve(payload(co, co === 'co-b' ? { regular: 'REG-IN' } : {})));
  apiMock.timeExportCodesSet.mockReset().mockImplementation((co, codes) => Promise.resolve(payload(co, Object.fromEntries(Object.entries(codes).filter(([, v]) => v.trim())))));
});

describe('PayrollExportCodes', () => {
  it('shows one box per pay class with the default as placeholder', async () => {
    render(<PayrollExportCodes />);
    const reg = await screen.findByLabelText('Regular code');
    expect(reg.getAttribute('placeholder')).toBe('Regular Pay');
    expect(reg.value).toBe('');
    expect(screen.getByLabelText('Double Time (2x) code').getAttribute('placeholder')).toBe('Double-time Pay');
    expect(screen.getAllByRole('textbox')).toHaveLength(7);
    expect(apiMock.timeExportCodesGet).toHaveBeenCalledWith('co-a');
    // Nothing changed yet: both buttons wait.
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset to Default' }).disabled).toBe(true);
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
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Default' }));
    await waitFor(() => expect(apiMock.timeExportCodesSet).toHaveBeenCalledWith('co-b', {}));
    await waitFor(() => expect(screen.getByLabelText('Regular code').value).toBe(''));
  });

  it('shows an error with Retry when the codes cannot load', async () => {
    apiMock.timeExportCodesGet.mockReset().mockRejectedValueOnce(new Error('Nope')).mockResolvedValue(payload('co-a'));
    render(<PayrollExportCodes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Regular code')).toBeTruthy();
  });
});
