import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Sync Employee Codes From Intacct (Charmi, Oct 21 2026): the preview renders,
// email matches are ticked by default, Apply sends the ticked rows, an
// unreachable accounting app shows its message, the nightly switch saves.

const preview = vi.fn();
const applyCodes = vi.fn();
const settings = vi.fn();
const setNightly = vi.fn();
vi.mock('../api', () => ({
  api: {
    intacctCodesPreview: (...a) => preview(...a),
    intacctCodesApply: (...a) => applyCodes(...a),
    intacctCodesSettings: (...a) => settings(...a),
    setIntacctCodesNightly: (...a) => setNightly(...a),
  },
}));

const { default: IntacctEmployeeCodes } = await import('./IntacctEmployeeCodes');

const ROWS = [
  { employeeId: 'e1', name: 'Amy Bolanos', workEmail: 'amy@x.com', companyName: 'Alpha', currentCode: 'GG-001', intacctCode: 'E100', intacctName: 'Bolanos, Amy', matchBy: 'email', action: 'update', reason: '', replacesNexusCode: true },
  { employeeId: 'e2', name: 'Raj Patel', workEmail: 'raj@x.com', currentCode: '', intacctCode: 'E101', matchBy: 'name', action: 'update', reason: '' },
  { employeeId: 'e3', name: 'Kim Ng', workEmail: 'kim@x.com', currentCode: 'GG-005', intacctCode: '', matchBy: '', action: 'conflict', reason: 'Intacct E103 matches more than one Nexus person' },
];

describe('IntacctEmployeeCodes', () => {
  beforeEach(() => {
    preview.mockReset(); applyCodes.mockReset(); settings.mockReset(); setNightly.mockReset();
    settings.mockResolvedValue({ companies: [{ id: 'c1', name: 'Alpha', nightly: false }], lastRun: {} });
    preview.mockResolvedValue({ source: 'intacct', rows: ROWS, counts: { update: 2, keep: 0, no_match: 0, conflict: 1 }, notInNexus: [] });
  });

  it('renders the preview with email matches ticked and applies them', async () => {
    applyCodes.mockResolvedValue({ applied: [{ employeeId: 'e1', from: 'GG-001', to: 'E100' }], skipped: [] });
    const onApplied = vi.fn();
    render(<IntacctEmployeeCodes onClose={() => {}} onApplied={onApplied} toastOk={() => {}} toastErr={() => {}} />);
    expect(await screen.findByText('Amy Bolanos')).toBeTruthy();
    expect(screen.getByText('Replaces GG-001, set in Nexus')).toBeTruthy();
    expect(screen.getByText(/matches more than one/)).toBeTruthy();
    expect(screen.getByLabelText('Update Amy Bolanos').checked).toBe(true);
    expect(screen.getByLabelText('Update Raj Patel').checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1' }));
    await waitFor(() => expect(applyCodes).toHaveBeenCalledWith([{ employeeId: 'e1', code: 'E100' }]));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('says which source the codes came from', async () => {
    preview.mockResolvedValue({ source: 'intacct', sourceLabel: 'Intacct (direct)', rows: ROWS, counts: { update: 2, keep: 0, no_match: 0, conflict: 1 }, notInNexus: [] });
    const { unmount } = render(<IntacctEmployeeCodes onClose={() => {}} />);
    expect(await screen.findByText(/Source: Intacct \(direct\)/)).toBeTruthy();
    unmount();
    preview.mockResolvedValue({ source: 'ledger', sourceLabel: 'Ledger codes, names only', rows: ROWS, counts: { update: 2, keep: 0, no_match: 0, conflict: 1 }, notInNexus: [] });
    render(<IntacctEmployeeCodes onClose={() => {}} />);
    expect(await screen.findByText(/Source: Ledger codes, names only/)).toBeTruthy();
    expect(screen.getByText(/matched by name/)).toBeTruthy();
  });

  it('shows the reason when Intacct cannot be read', async () => {
    preview.mockRejectedValue(new Error('Could not reach the accounting service (ConnectError). Nothing was changed.'));
    render(<IntacctEmployeeCodes onClose={() => {}} />);
    expect(await screen.findByText(/Could not reach the accounting service/)).toBeTruthy();
  });

  it('saves the nightly switch per company', async () => {
    setNightly.mockResolvedValue({ id: 'c1', name: 'Alpha', nightly: true });
    render(<IntacctEmployeeCodes onClose={() => {}} toastOk={() => {}} />);
    const box = await screen.findByRole('checkbox', { name: 'Alpha' });
    fireEvent.click(box);
    await waitFor(() => expect(setNightly).toHaveBeenCalledWith('c1', true));
  });
});
