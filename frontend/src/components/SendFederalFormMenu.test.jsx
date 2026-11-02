import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The person record's Documents tab (Neil, 11/02/2026): HR++ sends a federal
// form to one person from a small menu - Form W-4, Form I-9, Direct Deposit
// Authorization - with the edition Nexus holds; an expired edition is
// disabled and says why. Managers and the HR team see nothing.
const sendFederalForm = vi.fn();
const federalFormsStatus = vi.fn();
vi.mock('../api', () => ({ api: { sendFederalForm: (...a) => sendFederalForm(...a), federalFormsStatus: (...a) => federalFormsStatus(...a) } }));
const role = { current: null };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role.current }));

const { default: SendFederalFormMenu } = await import('./SendFederalFormMenu');

const ADMIN = { can: (r) => r === 'administrator' || r === 'manager', myGrantedModules: new Map(), hrTeam: false };
const FULL_HR = { can: () => false, myGrantedModules: new Map([['hr', 'full']]), hrTeam: false };
const HR_TEAM = { can: () => false, myGrantedModules: new Map([['hr', 'full']]), hrTeam: true };
const MANAGER = { can: (r) => r === 'manager', myGrantedModules: new Map([['hr', 'editor']]), hrTeam: false };
const STATUS = { forms: [
  { kind: 'w4', title: 'Form W-4', editionLabel: '2026', expires: '12/31/2026', state: 'ok', message: 'Form W-4 (2026) is current through 12/31/2026.' },
  { kind: 'i9', title: 'Form I-9', editionLabel: '01/20/25', expires: '05/31/2027', state: 'expired', message: 'The Form I-9 edition in Nexus (01/20/25) expired on 05/31/2027. Ask an administrator to update it before sending.' },
  { kind: 'direct_deposit', title: 'Direct Deposit Authorization', editionLabel: 'v1', expires: '', state: 'ok', message: 'Direct Deposit Authorization (v1) is current.' },
] };
const ANA = { id: 'e1', firstName: 'Ana', lastName: 'Diaz', employmentType: 'employee' };

beforeEach(() => {
  sendFederalForm.mockReset().mockResolvedValue({ requestId: 'r9', title: 'Form W-4 - Ana Diaz' });
  federalFormsStatus.mockReset().mockResolvedValue(STATUS);
  role.current = ADMIN;
});

describe('SendFederalFormMenu', () => {
  it('sends the picked form and says so; the expired edition is disabled with its reason', async () => {
    const toastOk = vi.fn(); const onSent = vi.fn();
    render(<SendFederalFormMenu employee={ANA} toastOk={toastOk} toastErr={vi.fn()} onSent={onSent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send Federal Form' }));
    const w4 = await screen.findByRole('menuitem', { name: /Form W-4 \(2026\)/ });
    const i9 = screen.getByRole('menuitem', { name: /Form I-9 \(01\/20\/25\)/ });
    expect(i9.disabled).toBe(true);
    expect(screen.getByText(/expired on 05\/31\/2027/)).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Direct Deposit Authorization \(v1\)/ }).disabled).toBe(false);
    fireEvent.click(w4);
    await waitFor(() => expect(sendFederalForm).toHaveBeenCalledWith('e1', 'w4'));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Form W-4 sent to Ana Diaz to sign.'));
    expect(onSent).toHaveBeenCalled();
  });
  it('shows the server refusal as a toast', async () => {
    sendFederalForm.mockRejectedValue(new Error('The Form W-4 edition in Nexus (2026) expired on 12/31/2026. Ask an administrator to update it before sending.'));
    const toastErr = vi.fn();
    render(<SendFederalFormMenu employee={ANA} toastOk={vi.fn()} toastErr={toastErr} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send Federal Form' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Form W-4/ }));
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith(expect.stringMatching(/expired on 12\/31\/2026/)));
  });
  it('shows for a Full People grant, never for the HR team, a manager or a contractor', () => {
    role.current = FULL_HR;
    const { unmount } = render(<SendFederalFormMenu employee={ANA} />);
    expect(screen.getByRole('button', { name: 'Send Federal Form' })).toBeTruthy();
    unmount();
    role.current = HR_TEAM;
    const r2 = render(<SendFederalFormMenu employee={ANA} />);
    expect(screen.queryByRole('button', { name: 'Send Federal Form' })).toBeNull();
    r2.unmount();
    role.current = MANAGER;
    const r3 = render(<SendFederalFormMenu employee={ANA} />);
    expect(screen.queryByRole('button', { name: 'Send Federal Form' })).toBeNull();
    r3.unmount();
    role.current = ADMIN;
    render(<SendFederalFormMenu employee={{ ...ANA, employmentType: 'contractor' }} />);
    expect(screen.queryByRole('button', { name: 'Send Federal Form' })).toBeNull();
  });
});
