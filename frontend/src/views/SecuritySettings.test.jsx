import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Settings > Security > Sign-In & Sessions: renders the two remaining groups
// (Sessions, Guest Sign-In), shows where each value comes from, Save only
// when dirty, and read-only for anyone who is not a Global Admin.
//
// The "Re-Authentication for Sensitive Actions" group (step-up sign-in, MFA,
// unlock duration, sign-in freshness) was removed from this page (Pranshu,
// Sep 28). The backend still returns those keys - nothing about the API
// changed - so the fixture below keeps them, and a test proves the page
// simply doesn't render them any more.

const getSecuritySettings = vi.fn();
const updateSecuritySettings = vi.fn();
vi.mock('../api', () => ({
  api: {
    getSecuritySettings: (...a) => getSecuritySettings(...a),
    updateSecuritySettings: (...a) => updateSecuritySettings(...a),
  },
}));

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
    // Still returned by the API (untouched), just no longer shown here.
    stepupEnforce: bool(true, 'saved'),
    stepupRequireMfa: bool(false),
    stepupTtlSec: int(300, 60, 1800, 'seconds', 'env', { hasEnv: true, envValue: 300 }),
    stepupMaxAgeSec: int(120, 60, 1800, 'seconds'),
    webSessionIdleDays: int(30, 1, 30, 'days'),
    actAsMinutes: int(240, 15, 480, 'minutes'),
    // A field the page still shows, given an env-sourced value here so the
    // "Set by server config" badge still has something real to test now
    // that the group carrying the old example (stepupTtlSec) is gone.
    vaultOtpUnlockSec: int(300, 60, 1800, 'seconds', 'env', { hasEnv: true, envValue: 300 }),
    // Same idea for the "Saved" badge (the old example, stepupEnforce, is
    // also gone).
    vaultPersonalUnlockSec: int(600, 60, 1800, 'seconds', 'saved'),
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
});

describe('SecuritySettings', () => {
  it('renders Sessions and Guest Sign-In, but not the removed re-authentication group', async () => {
    getSecuritySettings.mockResolvedValue(payload(true));
    render(<SecuritySettings />);
    await screen.findByText('Sessions');
    expect(screen.getByText('Guest Sign-In')).toBeTruthy();
    expect(screen.getByText('Set by server config')).toBeTruthy();
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('Allowed: 15 to 480 minutes')).toBeTruthy();
    expect(screen.getByText('Save Changes').closest('button').disabled).toBe(true);

    expect(screen.queryByText('Re-Authentication for Sensitive Actions')).toBeNull();
    expect(screen.queryByLabelText('Require Re-Authentication')).toBeNull();
    expect(screen.queryByLabelText('Require Multi-Factor Verification')).toBeNull();
    expect(screen.queryByLabelText('Unlock Duration')).toBeNull();
    expect(screen.queryByLabelText('Sign-In Freshness')).toBeNull();
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
    // No boolean toggle is shown any more, so nothing can weaken sign-in -
    // confirmWeaken is always false, with no confirm dialog in the way.
    await waitFor(() => expect(updateSecuritySettings).toHaveBeenCalledWith({ actAsMinutes: 60 }, false));
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

  it('is read-only with a note for non-owners', async () => {
    getSecuritySettings.mockResolvedValue(payload(false));
    render(<SecuritySettings />);
    await screen.findByText('You can view these settings. Only a Global Admin can change them.');
    expect(screen.getByLabelText('Act As Session Length').disabled).toBe(true);
    expect(screen.queryByText('Save Changes')).toBeNull();
  });

  it('shows a retry instead of a blank screen when loading fails', async () => {
    getSecuritySettings.mockRejectedValue(new Error('Insufficient permissions'));
    render(<SecuritySettings />);
    await screen.findByText('Insufficient permissions');
    expect(screen.getByText('Try Again')).toBeTruthy();
  });
});
