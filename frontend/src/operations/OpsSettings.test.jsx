import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Settings > Global Settings > Operations > Push to Cubby (Oct 21 2026): the
// switch reads from the server, starts off, explains both states, and only
// people the server says may edit can flip it.

const api = { getOpsSettings: vi.fn(), saveOpsSettings: vi.fn() };
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));

const { default: OpsSettings } = await import('./OpsSettings');

const OFF = { cubbyPushOn: false, writeConfigured: false, writeKeyEnv: 'CUBBY_MANAGER_API_KEY', updatedBy: '', updatedAt: '', history: [], canEdit: true };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
});

describe('Operations settings', () => {
  it('starts off and says what off means', async () => {
    api.getOpsSettings.mockResolvedValue(OFF);
    render(<OpsSettings />);
    const sw = await screen.findByRole('switch', { name: 'Push to Cubby' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Nexus only reads from Cubby/)).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('turns it on after a confirm and shows the missing key warning and the history', async () => {
    api.getOpsSettings.mockResolvedValue(OFF);
    api.saveOpsSettings.mockResolvedValue({ ...OFF, cubbyPushOn: true, updatedBy: 'neil@greensglobal.com', updatedAt: '2026-10-21T18:00:00Z',
      history: [{ by: 'neil@greensglobal.com', at: '2026-10-21T18:00:00Z', from: false, to: true }] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ok = vi.fn();
    render(<OpsSettings toastOk={ok} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Push to Cubby' }));
    await waitFor(() => expect(api.saveOpsSettings).toHaveBeenCalledWith({ cubbyPushOn: true }));
    expect(await screen.findByText(/no Cubby key with the Manager role/)).toBeTruthy();
    expect(screen.getByTestId('ops-settings-history').textContent).toContain('turned it on');
    expect(ok).toHaveBeenCalledWith('Push to Cubby is on');
    window.confirm.mockRestore();
  });

  it('is read-only for someone who cannot change it', async () => {
    api.getOpsSettings.mockResolvedValue({ ...OFF, canEdit: false });
    render(<OpsSettings />);
    expect((await screen.findByRole('switch', { name: 'Push to Cubby' })).disabled).toBe(true);
    expect(screen.getByText(/Only a Global Admin, an IT Admin or someone with Full access to Operations/)).toBeTruthy();
  });

  it('shows an error with a retry when it cannot load', async () => {
    api.getOpsSettings.mockRejectedValue(new Error('down'));
    render(<OpsSettings />);
    expect(await screen.findByText(/Couldn't load the Operations settings/)).toBeTruthy();
  });
});
