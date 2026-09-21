import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Render-smoke + the save round trip for the Task Emails panel (in My Profile): loads the caller's
// own preferences, shows company defaults, keeps assigned/mentioned locked on,
// and saves what was changed.

const payload = {
  prefs: {
    reminderHour: 8, timezone: 'America/Los_Angeles', skipWeekends: false, dueSoonDays: 'company',
    overdueFrequency: 'company', reminderDelivery: 'each', updateThrottleMinutes: 0,
    events: { created: true, commented: true, modified: true, follower_added: true, completed: true, deleted: true, recurring: true },
    mutedTaskIds: ['t1'], mutedProjectIds: [],
  },
  company: { dueSoonDays: 2, overdueRepeatDays: 3, allowUserOverdueOff: false, enabledEvents: {} },
  lockedEvents: ['assigned', 'mentioned'],
  optionalEvents: ['created', 'commented', 'modified', 'follower_added', 'completed', 'deleted', 'recurring'],
  mutedTasks: [{ id: 't1', title: 'Replace the pump seal' }], mutedProjects: [],
};
const api = {
  getMyTaskNotifyPrefs: vi.fn(async () => payload),
  saveMyTaskNotifyPrefs: vi.fn(async (prefs) => ({ ...payload, prefs })),
  getTaskProjects: vi.fn(async () => [{ id: 'p1', name: 'Ops' }]),
};
vi.mock('../api', () => ({ api: new Proxy({}, { get: (_, k) => (...a) => api[k](...a) }) }));

const { default: EmailSettingsPanel } = await import('./MyEmailSettings');

describe('EmailSettingsPanel', () => {
  beforeEach(() => { api.saveMyTaskNotifyPrefs.mockClear(); });

  it('renders the settings with company defaults and locked events', async () => {
    render(<EmailSettingsPanel />);
    expect(await screen.findByText('Reminder Time')).toBeTruthy();
    expect(screen.getByText('Company default (2 days before)')).toBeTruthy();
    expect(screen.getByText('Company default (every 3 days)')).toBeTruthy();
    // "Off" is only offered when the company allows it.
    const overdue = screen.getByLabelText('Overdue reminders');
    expect([...overdue.options].map((o) => o.value)).not.toContain('off');
    expect(screen.getByText('Replace the pump seal')).toBeTruthy();
    expect(screen.getAllByText(/always on/).length).toBe(2);
    expect(screen.getByRole('option', { name: '8:00 AM' })).toBeTruthy();
  });

  it('offers the same time zones the rest of Nexus does, not a hand-rolled list', async () => {
    render(<EmailSettingsPanel />);
    await screen.findByText('Reminder Time');
    const tz = screen.getByLabelText('Time zone');
    // Local first, then the shared curated list grouped by region - the
    // picker used to carry seven US zones plus a raw browser id.
    expect(tz.options[0].text.startsWith('Local - ')).toBe(true);
    expect(tz.querySelectorAll('optgroup').length).toBeGreaterThan(2);
    expect(tz.options.length).toBeGreaterThan(20);
    // Every option is labeled, never a bare IANA identifier like "Asia/Calcutta".
    expect([...tz.options].every(o => !/^[A-Za-z_]+\/[A-Za-z_]+$/.test(o.text))).toBe(true);
  });

  it('saves the changed preferences', async () => {
    render(<EmailSettingsPanel />);
    await screen.findByText('Reminder Time');
    fireEvent.click(screen.getByLabelText(/One daily summary/));
    fireEvent.change(screen.getByLabelText('Overdue reminders'), { target: { value: 'weekly' } });
    fireEvent.click(screen.getByRole('button', { name: /Unmute/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save Email Settings/ }));
    await waitFor(() => expect(api.saveMyTaskNotifyPrefs).toHaveBeenCalledTimes(1));
    const sent = api.saveMyTaskNotifyPrefs.mock.calls[0][0];
    expect(sent.reminderDelivery).toBe('digest');
    expect(sent.overdueFrequency).toBe('weekly');
    expect(sent.mutedTaskIds).toEqual([]);
  });

  it('reports "unavailable" instead of rendering for an account without task access', async () => {
    const orig = api.getMyTaskNotifyPrefs;
    api.getMyTaskNotifyPrefs = vi.fn(async () => { const e = new Error('Forbidden'); e.status = 403; throw e; });
    const onUnavailable = vi.fn();
    render(<EmailSettingsPanel onUnavailable={onUnavailable} />);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    api.getMyTaskNotifyPrefs = orig;
  });
});
