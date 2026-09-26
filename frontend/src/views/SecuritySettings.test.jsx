import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Settings > Security > Sign-In & Sessions: renders every group, shows where
// each value comes from, Save only when dirty, confirm before weakening, and
// read-only for anyone who is not a Global Admin.

const getSecuritySettings = vi.fn();
const updateSecuritySettings = vi.fn();
vi.mock('../api', () => ({
  api: {
    getSecuritySettings: (...a) => getSecuritySettings(...a),
    updateSecuritySettings: (...a) => updateSecuritySettings(...a),
  },
}));
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));

const SecuritySettings = (await import('./SecuritySettings')).default;

const int = (value, min, max, unit, source = 'default', extra = {}) => ({
  value, source, default: value, type: 'int', locked: false, hasEnv: false, envValue: null,
  min, max, unit, outOfRange: false, ...extra,
});
const bool = (value, source = 'default', extra = {}) => ({
  value, source, default: false, type: 'bool', locked: false, hasEnv: false, envValue: null,
  min: null, max: null, unit: null, outOfRange: false, ...extra,
});
const payload = (canEdit, over = {}) => ({
  canEdit,
  settings: {
    stepupEnforce: bool(true, 'saved'),
    stepupRequireMfa: bool(false),
    stepupTtlSec: int(300, 60, 1800, 'seconds', 'env', { hasEnv: true, envValue: 300 }),
    stepupMaxAgeSec: int(120, 60, 1800, 'seconds'),
    webSessionIdleDays: int(30, 1, 30, 'days'),
    actAsMinutes: int(240, 15, 480, 'minutes'),
    vaultOtpUnlockSec: int(300, 60, 1800, 'seconds'),
    vaultPersonalUnlockSec: int(600, 60, 1800, 'seconds'),
    guestCodeTtlMin: int(10, 5, 30, 'minutes'),
    guestMaxAttempts: int(5, 3, 10, 'attempts'),
    guestLockoutMin: int(15, 5, 60, 'minutes'),
    guestRequestsPerHour: int(5, 3, 10, 'requests'),
    guestInviteTtlDays: int(7, 1, 14, 'days'),
    ...over,
  },
});

beforeEach(() => {
  getSecuritySettings.mockReset();
  updateSecuritySettings.mockReset().mockImplementation(async () => payload(true));
  confirm.mockReset().mockResolvedValue(true);
});

describe('SecuritySettings', () => {
  it('renders the three groups with sources and ranges', async () => {
    getSecuritySettings.mockResolvedValue(payload(true));
    render(<SecuritySettings />);
    await screen.findByText('Re-Authentication for Sensitive Actions');
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getByText('Guest Sign-In')).toBeTruthy();
    expect(screen.getByText('Set by server config')).toBeTruthy();
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('Allowed: 15 to 480 minutes')).toBeTruthy();
    expect(screen.getByText('Save Changes').closest('button').disabled).toBe(true);
  });

  it('enables Save when dirty, blocks out-of-range values, and saves only the change', async () => {
    getSecuritySettings.mockResolvedValue(payload(true));
    render(<SecuritySettings />);
    const input = await screen.findByLabelText('Act As Session Length');
    fireEvent.change(input, { target: { value: '600' } });
    expect(screen.getByText('Must be 15 to 480 minutes.')).toBeTruthy();
    expect(screen.getByText('Save Changes').closest('button').disabled).toBe(true);
    fireEvent.change(input, { target: { value: '60' } });
    const save = screen.getByText('Save Changes').closest('button');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(updateSecuritySettings).toHaveBeenCalledWith({ actAsMinutes: 60 }, false));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks for confirmation before turning re-authentication off', async () => {
    getSecuritySettings.mockResolvedValue(payload(true));
    confirm.mockResolvedValueOnce(false);
    render(<SecuritySettings />);
    fireEvent.click(await screen.findByLabelText('Require Re-Authentication'));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(updateSecuritySettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(updateSecuritySettings).toHaveBeenCalledWith({ stepupEnforce: false }, true));
  });

  it('Reset to Default sends null for a saved value', async () => {
    getSecuritySettings.mockResolvedValue(payload(true, { actAsMinutes: int(60, 15, 480, 'minutes', 'saved', { default: 240 }) }));
    render(<SecuritySettings />);
    await screen.findByText('Sessions');
    fireEvent.click(screen.getByLabelText('Reset Act As Session Length to Default'));
    expect(screen.getByLabelText('Act As Session Length').value).toBe('240');
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(updateSecuritySettings).toHaveBeenCalledWith({ actAsMinutes: null }, false));
  });

  it('is read-only with a note for non-owners, and locks a server-forced switch', async () => {
    getSecuritySettings.mockResolvedValue(payload(false, {
      stepupRequireMfa: bool(true, 'env', { locked: true, hasEnv: true, envValue: true }),
    }));
    render(<SecuritySettings />);
    await screen.findByText('You can view these settings. Only a Global Admin can change them.');
    expect(screen.getByLabelText('Act As Session Length').disabled).toBe(true);
    expect(screen.getByLabelText('Require Multi-Factor Verification').disabled).toBe(true);
    expect(screen.getByText('Required by server config')).toBeTruthy();
    expect(screen.queryByText('Save Changes')).toBeNull();
  });

  it('shows a retry instead of a blank screen when loading fails', async () => {
    getSecuritySettings.mockRejectedValue(new Error('Insufficient permissions'));
    render(<SecuritySettings />);
    await screen.findByText('Insufficient permissions');
    expect(screen.getByText('Try Again')).toBeTruthy();
  });
});
