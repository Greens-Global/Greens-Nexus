import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Settings > Shifts > Weather Alerts (Weather Call, Oct 2026): the
// per-company switch the feature ships behind, the thresholds, quiet hours
// and the heads-up line save together; Check Now runs the watch and says
// what it found.

const weatherWatchSettings = vi.fn();
const weatherWatchSettingsSave = vi.fn();
const weatherWatchScan = vi.fn();
vi.mock('../../api', () => ({
  api: {
    weatherWatchSettings: (...a) => weatherWatchSettings(...a),
    weatherWatchSettingsSave: (...a) => weatherWatchSettingsSave(...a),
    weatherWatchScan: (...a) => weatherWatchScan(...a),
  },
}));

const { default: WeatherSettingsPanel } = await import('./WeatherSettings');

const config = { companies: { ent1: true }, majorChance: 70, majorInches: 0.5, anyChanceInches: 1, headsUpChance: 40, headsUpInches: 0.1, stormChance: 50,
  quietStart: '21:00', quietEnd: '05:00', headsUpTeams: true, smsDefault: true };
const payload = (over = {}) => ({
  config: { ...config, ...over.config },
  companies: [
    { id: 'ent1', name: 'Greens', enabled: true, groupsReady: ['Yard Crew'], groupsNotReady: ['Office'] },
    { id: 'ent2', name: 'Sacred Natural', enabled: false, groupsReady: [], groupsNotReady: [] },
  ],
  lastAdvisoryAt: '', untaggedGroups: [],
  ...over,
});
const toastOk = vi.fn();
const toastErr = vi.fn();

beforeEach(() => {
  weatherWatchSettings.mockReset().mockResolvedValue(payload());
  weatherWatchSettingsSave.mockReset().mockImplementation(async (body) => payload({ config: { ...config, ...body, companies: undefined } }));
  weatherWatchScan.mockReset().mockResolvedValue({ groups: 1, days: 2, advisories: 1, headsUp: 0, eased: 0, held: 0, providerDown: 0, bands: {} });
  toastOk.mockReset(); toastErr.mockReset();
});

describe('Weather Alerts settings', () => {
  it('shows each company with its ready groups, and saves the switch, a threshold and quiet hours together', async () => {
    render(<WeatherSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText('Greens')).toBeTruthy();
    expect(screen.getByText(/1 group ready: Yard Crew/).textContent).toContain('not ready (no located site or alerts off): Office');
    expect(screen.getByText('No group ready')).toBeTruthy();
    const greens = screen.getByLabelText('Watch the weather for Greens');
    const sacred = screen.getByLabelText('Watch the weather for Sacred Natural');
    expect(greens.checked).toBe(true);
    expect(sacred.checked).toBe(false);
    expect(screen.getByRole('button', { name: /Save/ }).disabled).toBe(true);      // nothing changed yet
    fireEvent.click(sacred);
    fireEvent.change(screen.getByLabelText('Major: chance of rain (%)'), { target: { value: '80' } });
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '22:00' } });
    fireEvent.click(screen.getByLabelText('Post a quiet Teams line for a heads-up'));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(weatherWatchSettingsSave).toHaveBeenCalledTimes(1));
    expect(weatherWatchSettingsSave.mock.calls[0][0]).toMatchObject({ companies: { ent1: true, ent2: true }, majorChance: 80, quietStart: '22:00', headsUpTeams: false });
    expect(toastOk).toHaveBeenCalledWith('Weather alert settings saved.');
  });

  it('Check Now runs the watch and says what it found', async () => {
    render(<WeatherSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    await screen.findByText('Greens');
    fireEvent.click(screen.getByRole('button', { name: /Check Now/ }));
    await waitFor(() => expect(weatherWatchScan).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Checked 1 group, 2 days with shifts, 1 advisory sent.'));
    weatherWatchScan.mockResolvedValue({ groups: 0, days: 0, advisories: 0, headsUp: 0, eased: 0, held: 0, providerDown: 0, bands: {} });
    fireEvent.click(screen.getByRole('button', { name: /Check Now/ }));
    await waitFor(() => expect(toastOk).toHaveBeenLastCalledWith('Nothing to check - no company is switched on, or no group is ready.'));
  });

  it('shows an error with Retry when the settings cannot load', async () => {
    weatherWatchSettings.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(payload());
    render(<WeatherSettingsPanel toastOk={toastOk} toastErr={toastErr} />);
    expect(await screen.findByText(/could not be loaded right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByText('Greens')).toBeTruthy();
  });
});
