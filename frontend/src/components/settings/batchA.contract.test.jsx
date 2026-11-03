import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { renderInGroup, typedFields, editField, saveRows } from './settingsContract.testkit';

// The Settings save contract (Oct 23 2026) for the Emails & Reminders panels:
// each has ONE Save row, a typed edit makes its group dirty (so leaving
// asks) and enables Save, its save can run from the prompt's Save and
// Leave, and a switch saves on click without waiting for Save.

const api = {
  getDailyBriefingConfig: vi.fn(), updateDailyBriefingConfig: vi.fn(),
  getDailyBriefingLog: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  getWeeklyDigestConfig: vi.fn(), updateWeeklyDigestConfig: vi.fn(),
  getWeeklyDigestLog: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  getWorkforceScorecardConfig: vi.fn(), updateWorkforceScorecardConfig: vi.fn(),
  getWorkforceScorecardRecipients: vi.fn(() => Promise.resolve({ recipients: [] })),
  getWorkforceScorecardLog: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  getTaskNotifySettings: vi.fn(), updateTaskNotifySettings: vi.fn(),
  getTaskNotifyLog: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  getTaskInboundLog: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
  getPeopleDirectory: vi.fn(() => Promise.resolve([])),
};
vi.mock('../../api', () => ({ api: new Proxy({}, { get: (_, k) => api[k] || (() => Promise.resolve({})) }) }));
vi.mock('../../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true, myLevel: 5, isGlobalAdmin: true }) }));
vi.mock('../../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)) } }));
vi.mock('../../tasks/TasksContext', () => ({ useTasks: () => ({ taskById: {} }) }));
vi.mock('../../tasks/TaskDetailDrawer', () => ({ default: () => null }));

const DailyBriefingSettings = (await import('../DailyBriefingSettings')).default;
const WeeklyDigestSettings = (await import('../WeeklyDigestSettings')).default;
const WorkforceScorecardSettings = (await import('../WorkforceScorecardSettings')).default;
const TaskNotifySettings = (await import('../../tasks/TaskNotifySettings')).default;

const DAILY = { mode: 'test', test_recipients: ['qa@x.com'], outlook_card: 'off', leadMinutes: 150, includeNoShift: false, defaultSendTime: '07:00', defaultTimeZone: 'America/Los_Angeles' };
const WEEKLY = { mode: 'test', test_recipients: [], sendDay: 1, leadMinutes: 120, includeNoShift: true, defaultSendTime: '08:00', defaultTimeZone: 'America/Los_Angeles', outlookCard: true };
const WSC = { mode: 'off', test_recipients: [], companyRecipients: [], workingTimeOffTypes: ['Work From Home'], sendDay: 1, sendTime: '08:00',
  defaultTimeZone: 'America/Los_Angeles', weekStart: 'monday', payTypes: ['hourly'],
  standards: { US: { hours: 8, days: [1, 2, 3, 4, 5] }, IN: { hours: 9, days: [1, 2, 3, 4, 5] }, default: { hours: 8, days: [1, 2, 3, 4, 5] } },
  shortToleranceMin: 15, onTrackPct: 95, belowPct: 80 };
const TASKS = { fromMailbox: 'tasks@x.com', defaultCc: [], replyTo: 'tasks@x.com', logoUrl: '', dueSoonDays: 2, overdueRepeatDays: 3,
  batchWindowMinutes: 60, allowUserOverdueOff: false, inboundEnabled: false, inboundMailbox: '', enabledEvents: { created: true, assigned: true } };

beforeEach(() => {
  api.getDailyBriefingConfig.mockResolvedValue({ ...DAILY });
  api.updateDailyBriefingConfig.mockImplementation(async (p) => ({ ...DAILY, ...p }));
  api.getWeeklyDigestConfig.mockResolvedValue({ ...WEEKLY });
  api.updateWeeklyDigestConfig.mockImplementation(async (p) => ({ ...WEEKLY, ...p }));
  api.getWorkforceScorecardConfig.mockResolvedValue({ ...WSC });
  api.updateWorkforceScorecardConfig.mockImplementation(async (p) => ({ ...WSC, ...p }));
  api.getTaskNotifySettings.mockResolvedValue({ ...TASKS });
  api.updateTaskNotifySettings.mockImplementation(async (p) => ({ ...TASKS, ...p, enabledEvents: { ...TASKS.enabledEvents, ...(p.enabledEvents || {}) } }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const PANELS = [
  ['Daily Briefing', () => <DailyBriefingSettings />, 'Minutes before shift start'],
  ['Weekly Digest', () => <WeeklyDigestSettings />, 'Minutes before shift start'],
  ['Workforce Scorecard', () => <WorkforceScorecardSettings />, 'On Track threshold'],
  ['Task Notifications', () => <TaskNotifySettings />, 'Shared Mailbox (Sender)'],
];

describe.each(PANELS)('%s keeps the Settings save contract', (_name, ui, fieldLabel) => {
  it('has one Save row, and any typed edit makes the group dirty and enables Save', async () => {
    const { container, group } = renderInGroup(ui());
    await screen.findByLabelText(fieldLabel, {}, { timeout: 5000 });
    expect(saveRows(container)).toBe(1);
    const save = screen.getByRole('button', { name: /^Save$/ });
    expect(save).toBeDisabled();
    expect(group.dirty).toBe(false);
    const fields = typedFields(container);
    expect(fields.length).toBeGreaterThan(0);
    for (const el of fields) {
      editField(el);
      await waitFor(() => expect(group.dirty).toBe(true));
      fireEvent.click(screen.getByRole('button', { name: 'Discard Changes' }));
      await waitFor(() => expect(group.dirty).toBe(false));
    }
    editField(screen.getByLabelText(fieldLabel));
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled();
    // The prompt's Save and Leave runs the same save and hears whether it landed.
    expect(group.saves).toHaveLength(1);
    await expect(group.saves[0]()).resolves.toBe(true);
    await waitFor(() => expect(group.dirty).toBe(false));
  });
});

describe('switches save on click', () => {
  it('a Task Notifications type switch saves at once, only that key, with no Save click', async () => {
    const { group } = renderInGroup(<TaskNotifySettings />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Task Created' }, { timeout: 5000 }));
    await waitFor(() => expect(api.updateTaskNotifySettings).toHaveBeenCalledWith({ enabledEvents: { created: false } }));
    expect(group.dirty).toBe(false);
    expect(await screen.findByText('Task Created saved.')).toBeTruthy();
  });

  it('a Workforce Scorecard working day saves at once and leaves a typed hour as a draft', async () => {
    const { group } = renderInGroup(<WorkforceScorecardSettings />);
    fireEvent.change(await screen.findByLabelText('US hours', {}, { timeout: 5000 }), { target: { value: '7.5' } });
    expect(group.dirty).toBe(true);
    fireEvent.click(screen.getAllByTitle('Saturday')[0]);
    await waitFor(() => expect(api.updateWorkforceScorecardConfig).toHaveBeenCalledTimes(1));
    const sent = api.updateWorkforceScorecardConfig.mock.calls[0][0];
    expect(Object.keys(sent)).toEqual(['standards']);
    expect(sent.standards.IN.days).toContain(6);   // the rows sort IN before US
    expect(sent.standards.US.hours).toBe(8);       // the saved hours, not the draft
    await waitFor(() => expect(screen.getByLabelText('US hours').value).toBe('7.5'));
    expect(group.dirty).toBe(true);
  });

  it('Task Notifications Save sends only the changed keys', async () => {
    renderInGroup(<TaskNotifySettings />);
    fireEvent.change(await screen.findByLabelText('Default CC', {}, { timeout: 5000 }), { target: { value: 'ops@x.com, hr@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(api.updateTaskNotifySettings).toHaveBeenCalledWith({ defaultCc: ['ops@x.com', 'hr@x.com'] }));
  });
});
