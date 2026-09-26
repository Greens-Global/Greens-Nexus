import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Equipment Reminders: overdue checkouts + asset date alerts, each row says
// who gets it, numbers and day chips edit the draft, Save sends the config.

const DEFAULTS = {
  overdue: { enabled: true, onDueDate: true, everyDays: 3, maxReminders: 5, notifyOwnerAfterDays: 3 },
  warranty: { enabled: true, daysBefore: [90] },
  inspection: { enabled: true, daysBefore: [30] },
  registration: { enabled: true, daysBefore: [60] },
  service: { enabled: true, daysBefore: [30] },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

const getSettings = vi.fn();
const updateSettings = vi.fn();
vi.mock('../api', () => ({
  api: {
    getEquipmentReminderSettings: (...a) => getSettings(...a),
    updateEquipmentReminderSettings: (...a) => updateSettings(...a),
  },
}));

const EquipmentReminderSettings = (await import('./EquipmentReminderSettings')).default;

const state = (over = {}) => ({
  config: clone(DEFAULTS), defaults: clone(DEFAULTS), canEdit: true, updatedBy: '', updatedAt: '', ...over,
});

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue(state());
  updateSettings.mockReset().mockImplementation(async ({ config }) => state({ config }));
});

describe('EquipmentReminderSettings', () => {
  it('renders every reminder with who receives it', async () => {
    render(<EquipmentReminderSettings />);
    for (const t of ['Overdue Checkouts', 'Warranty Expiry', 'Inspection Due', 'Registration & Insurance', 'Next Service']) {
      expect(await screen.findByText(t)).toBeInTheDocument();
    }
    expect(screen.getByText(/Goes to the person who has the item/)).toBeInTheDocument();
    expect(screen.getAllByText(/If nobody is set, it goes to the IT Admins/).length).toBe(4);
    expect(screen.getByText('90 days before')).toBeInTheDocument();
    expect(screen.getByLabelText('Also remind on the due date')).toBeChecked();
    expect(document.body.textContent).not.toContain(String.fromCharCode(0x2014)); // no em dashes in user copy
  });

  it('saves edited overdue numbers and warranty days', async () => {
    render(<EquipmentReminderSettings />);
    await screen.findByText('Overdue Checkouts');
    const save = () => screen.getByRole('button', { name: /Save Changes/ });
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Remind every/), { target: { value: '2' } });
    const add = screen.getByLabelText('Add a day to Warranty Expiry (warn before the date)');
    fireEvent.change(add, { target: { value: '30' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.click(save());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const cfg = updateSettings.mock.calls[0][0].config;
    expect(cfg.overdue.everyDays).toBe(2);
    expect(cfg.warranty.daysBefore).toEqual([90, 30]);
  });

  it('is read-only without edit rights', async () => {
    getSettings.mockResolvedValue(state({ canEdit: false }));
    render(<EquipmentReminderSettings />);
    expect(await screen.findByText(/Full access to Item Management/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Changes/ })).not.toBeInTheDocument();
    for (const sw of screen.getAllByRole('switch')) expect(sw).toBeDisabled();
  });
});
