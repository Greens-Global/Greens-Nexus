import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// HR & Compliance Reminders: one row per reminder with who gets it, days as
// chips, Save only when something changed, Reset to Defaults, read-only
// without edit rights.

const DEFAULTS = {
  rightToWork: { enabled: true, daysBefore: [60, 30, 14, 7, 3, 1, 0], daysAfter: [1, 2, 3, 4, 5, 6, 7] },
  contractEnd: { enabled: true, daysBefore: [30, 14, 7, 1, 0] },
  newStarter: { enabled: true, daysBefore: [7, 3, 1, 0] },
  documentExpiry: { enabled: true, daysBefore: [30, 14, 7, 1, 0] },
  esignExpiring: { enabled: true, daysBefore: [3, 2, 1, 0] },
  esignChase: { enabled: true, firstNudgeAfterDays: 3, maxNudges: 3 },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

const getHrReminderSettings = vi.fn();
const updateHrReminderSettings = vi.fn();
vi.mock('../api', () => ({
  api: {
    getHrReminderSettings: (...a) => getHrReminderSettings(...a),
    updateHrReminderSettings: (...a) => updateHrReminderSettings(...a),
  },
}));

const HrReminderSettings = (await import('./HrReminderSettings')).default;

const state = (over = {}) => ({
  config: clone(DEFAULTS), defaults: clone(DEFAULTS), canEdit: true, updatedBy: '', updatedAt: '', ...over,
});

beforeEach(() => {
  getHrReminderSettings.mockReset().mockResolvedValue(state());
  updateHrReminderSettings.mockReset().mockImplementation(async ({ config }) => state({
    config, updatedBy: 'hr@greensglobal.com', updatedAt: '2026-09-26T13:00:00+00:00',
  }));
});

const saveBtn = () => screen.getByRole('button', { name: /Save Changes/ });

describe('HrReminderSettings', () => {
  it('renders every reminder with who receives it', async () => {
    render(<HrReminderSettings />);
    for (const t of ['Visa & Right-to-Work Expiry', 'Contract End', 'New Starter', 'HR Document Expiry',
      'Signature Request Expiring', 'Signature Chase']) {
      expect(await screen.findByText(t)).toBeInTheDocument();
    }
    expect(screen.getByText(/HR team and the new starter's manager/)).toBeInTheDocument();
    expect(screen.getByText('Goes to the person who sent the request.')).toBeInTheDocument();
    expect(screen.getAllByText('60 days before')).toHaveLength(1);
    expect(screen.getAllByText('On the day').length).toBeGreaterThan(0);
    expect(screen.getByText('7 days after')).toBeInTheDocument();
  });

  it('enables Save only once something changes, and saves the edited days', async () => {
    render(<HrReminderSettings />);
    await screen.findByText('Contract End');
    expect(saveBtn()).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Remove 30 days before from Contract End'));
    const add = screen.getByLabelText('Add a day to Contract End (remind before the date)');
    fireEvent.change(add, { target: { value: '21' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(saveBtn()).toBeEnabled();

    fireEvent.click(saveBtn());
    await waitFor(() => expect(updateHrReminderSettings).toHaveBeenCalledTimes(1));
    expect(updateHrReminderSettings.mock.calls[0][0].config.contractEnd.daysBefore).toEqual([21, 14, 7, 1, 0]);
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
  });

  it('rejects a day out of range without changing anything', async () => {
    render(<HrReminderSettings />);
    await screen.findByText('New Starter');
    const add = screen.getByLabelText('Add a day to New Starter (remind before the date)');
    fireEvent.change(add, { target: { value: '400' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('from 0 to 365');
    expect(saveBtn()).toBeDisabled();
  });

  it('turning a reminder off hides its days and marks the form dirty', async () => {
    render(<HrReminderSettings />);
    await screen.findByText('HR Document Expiry');
    fireEvent.click(screen.getByRole('switch', { name: 'HR Document Expiry reminders' }));
    expect(screen.getByText(/nobody is reminded about this/)).toBeInTheDocument();
    expect(saveBtn()).toBeEnabled();
  });

  it('Reset to Defaults restores the starting days (and needs Save)', async () => {
    const custom = clone(DEFAULTS);
    custom.contractEnd.daysBefore = [45];
    getHrReminderSettings.mockResolvedValue(state({ config: custom }));
    render(<HrReminderSettings />);
    expect(await screen.findByText('45 days before')).toBeInTheDocument();
    expect(saveBtn()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Reset to Defaults/ }));
    expect(screen.queryByText('45 days before')).not.toBeInTheDocument();
    expect(saveBtn()).toBeEnabled();
    expect(screen.getByRole('button', { name: /Reset to Defaults/ })).toBeDisabled();
  });

  it('is read-only without edit rights', async () => {
    getHrReminderSettings.mockResolvedValue(state({ canEdit: false }));
    render(<HrReminderSettings />);
    expect(await screen.findByText(/Only a Global Admin/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Changes/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove /)).not.toBeInTheDocument();
    for (const sw of screen.getAllByRole('switch')) expect(sw).toBeDisabled();
  });
});
