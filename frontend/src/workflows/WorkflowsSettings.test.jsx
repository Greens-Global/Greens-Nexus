import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Settings > Workflows: the switches save on click, the typed fields go
// through one Save row that shows only once something changed, Pause All
// is the Global Admin's and says who paused and when, a company's face
// drops the org-only rows and offers Use the Default when it overrides.

const wfSettings = vi.fn();
const wfSettingsSave = vi.fn();
const wfPauseAll = vi.fn();
vi.mock('../api', () => ({
  api: {
    wfSettings: (...a) => wfSettings(...a),
    wfSettingsSave: (...a) => wfSettingsSave(...a),
    wfPauseAll: (...a) => wfPauseAll(...a),
  },
}));
const roleState = { myRole: 'owner' };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => roleState }));
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a), prompt: vi.fn() } }));

const { WorkflowsSettings } = await import('./WorkflowsSettings');

const ORG = {
  enabled: true, pausedAll: false, pausedBy: '', pausedAt: '', ownerDigest: false,
  maxRunsPerHourCap: 500, maxRecipientsCap: 200, nexusRunAs: false,
  webhookHosts: ['hooks.example.com'], webhookSecretsSet: ['hooks.example.com'], override: false,
  companies: [{ id: 'c1', name: 'Greens Global', own: false }],
};

beforeEach(() => {
  [wfSettings, wfSettingsSave, wfPauseAll, confirm].forEach((f) => f.mockReset());
  roleState.myRole = 'owner';
  wfSettings.mockResolvedValue(ORG);
  wfSettingsSave.mockImplementation((body) => Promise.resolve({ ...ORG, ...body }));
  wfPauseAll.mockResolvedValue({});
  confirm.mockResolvedValue(true);
});

describe('WorkflowsSettings', () => {
  it('draws every org row for a Global Admin and saves a switch on click', async () => {
    const toastOk = vi.fn();
    render(<WorkflowsSettings company="" toastOk={toastOk} />);
    expect(await screen.findByRole('switch', { name: 'Workflows On' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Pause All Workflows' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Nexus Run-As' })).toBeTruthy();
    expect(screen.getByText('Webhook Hosts')).toBeTruthy();
    expect(screen.getByText('Secret Set')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Owner Digest' }));
    await vi.waitFor(() => expect(wfSettingsSave).toHaveBeenCalledTimes(1));
    const [body, company] = wfSettingsSave.mock.calls[0];
    expect(company).toBe('');
    expect(body.ownerDigest).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.webhookSecrets).toBeUndefined();
    await vi.waitFor(() => expect(toastOk).toHaveBeenCalledWith('Saved.'));
  });

  it('shows Save only once a typed field changed, clamps the caps and sends only typed secrets', async () => {
    render(<WorkflowsSettings company="" />);
    const runs = await screen.findByLabelText('Runs per hour cap');
    fireEvent.change(runs, { target: { value: '900' } });
    const save = await screen.findByRole('button', { name: 'Save' });
    fireEvent.click(screen.getByRole('button', { name: 'Add Host' }));
    fireEvent.change(screen.getByLabelText('Webhook host 2'), { target: { value: 'Alerts.Example.com' } });
    fireEvent.change(screen.getByLabelText('Secret for Alerts.Example.com'), { target: { value: 's3cret' } });
    fireEvent.click(save);
    await vi.waitFor(() => expect(wfSettingsSave).toHaveBeenCalledTimes(1));
    const [body] = wfSettingsSave.mock.calls[0];
    expect(body.maxRunsPerHourCap).toBe(500);
    expect(body.webhookHosts).toEqual(['hooks.example.com', 'alerts.example.com']);
    // Only the secret typed this time, keyed by the host as saved.
    expect(body.webhookSecrets).toEqual({ 'alerts.example.com': 's3cret' });
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  });

  it('discards typed changes without saving', async () => {
    render(<WorkflowsSettings company="" />);
    fireEvent.change(await screen.findByLabelText('Recipients cap'), { target: { value: '20' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Discard Changes' }));
    expect(screen.getByLabelText('Recipients cap').value).toBe('200');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(wfSettingsSave).not.toHaveBeenCalled();
  });

  it('pauses everything after a confirmation and says who paused and since when', async () => {
    wfSettings.mockResolvedValueOnce(ORG).mockResolvedValueOnce({ ...ORG, pausedAll: true, pausedBy: 'Neil Kadakia', pausedAt: '2026-10-28T15:05:00Z' });
    render(<WorkflowsSettings company="" />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Pause All Workflows' }));
    await vi.waitFor(() => expect(wfPauseAll).toHaveBeenCalledWith({ paused: true }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Paused by Neil Kadakia since 10\/28\/2026, \d{1,2}:\d{2} [AP]M\./)).toBeTruthy();
    expect(wfSettingsSave).not.toHaveBeenCalled();
  });

  it('does not pause when the confirmation is declined', async () => {
    confirm.mockResolvedValue(false);
    render(<WorkflowsSettings company="" />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Pause All Workflows' }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(wfPauseAll).not.toHaveBeenCalled();
  });

  it('locks the org face for someone who is not a Global Admin', async () => {
    roleState.myRole = 'administrator';
    render(<WorkflowsSettings company="" />);
    expect((await screen.findByRole('switch', { name: 'Workflows On' })).disabled).toBe(true);
    expect(screen.getByRole('switch', { name: 'Pause All Workflows' }).disabled).toBe(true);
    expect(screen.getByText(/changed by a Global Admin/)).toBeTruthy();
  });

  it('shows a company\'s face without the org-only rows, reports its override and resets to the default', async () => {
    roleState.myRole = 'administrator';
    wfSettings.mockResolvedValue({ ...ORG, override: true, maxRunsPerHourCap: 50 });
    const onOverride = vi.fn();
    render(<WorkflowsSettings company="c1" onOverride={onOverride} />);
    expect(await screen.findByText('This company has its own workflow settings.')).toBeTruthy();
    await vi.waitFor(() => expect(onOverride).toHaveBeenCalledWith(true));
    expect(screen.queryByRole('switch', { name: 'Pause All Workflows' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Nexus Run-As' })).toBeNull();
    expect(screen.queryByText('Webhook Hosts')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Workflows On' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Use the Default' }));
    await vi.waitFor(() => expect(wfSettingsSave).toHaveBeenCalledTimes(1));
    const [body, company] = wfSettingsSave.mock.calls[0];
    expect(company).toBe('c1');
    expect(body.override).toBe(false);
  });

  it('offers a retry when the settings could not load', async () => {
    wfSettings.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(ORG);
    render(<WorkflowsSettings company="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('switch', { name: 'Workflows On' })).toBeTruthy();
    expect(within(document.body).queryByText('down')).toBeNull();
  });
});
