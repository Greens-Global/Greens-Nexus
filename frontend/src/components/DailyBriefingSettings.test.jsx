import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Delivery Log bulk Force Resend: tick rows, send them all, one email per
// employee even when two of their rows are ticked.

const getDailyBriefingConfig = vi.fn();
const getDailyBriefingLog = vi.fn();
const forceResendDailyBriefing = vi.fn();
const updateDailyBriefingConfig = vi.fn();
vi.mock('../api', () => ({
  api: {
    getDailyBriefingConfig: (...a) => getDailyBriefingConfig(...a),
    getDailyBriefingLog: (...a) => getDailyBriefingLog(...a),
    forceResendDailyBriefing: (...a) => forceResendDailyBriefing(...a),
    updateDailyBriefingConfig: (...a) => updateDailyBriefingConfig(...a),
  },
}));
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

const DailyBriefingSettings = (await import('./DailyBriefingSettings')).default;

const row = (id, email, date, sentAt = '') => ({
  id, employeeEmail: email, briefingDate: date, sentAt, mode: 'test',
  redCount: 1, amberCount: 0, greenCount: 0, createdAt: date,
});
const ROWS = [
  row('a', 'pranshu.pandey@greensglobal.com', '2026-09-26', '2026-09-26T01:00:00'),
  row('b', 'visesh.lodha@greensglobal.com', '2026-09-26'),
  row('c', 'pranshu.pandey@greensglobal.com', '2026-09-25', '2026-09-25T01:00:00'),
];

beforeEach(() => {
  getDailyBriefingConfig.mockReset().mockResolvedValue({ mode: 'test', test_recipients: [], outlook_card: 'off' });
  getDailyBriefingLog.mockReset().mockResolvedValue({ rows: ROWS, total: ROWS.length });
  forceResendDailyBriefing.mockReset().mockResolvedValue({ sentNow: true, mode: 'test', hadContent: true });
  confirm.mockReset().mockResolvedValue(true);
});

async function openLog() {
  render(<DailyBriefingSettings />);
  fireEvent.click(await screen.findByText('Delivery Log'));
  await screen.findByLabelText('Select visesh.lodha@greensglobal.com 2026-09-26');
}

describe('Delivery Log bulk Force Resend', () => {
  it('is disabled until something is selected', async () => {
    await openLog();
    expect(screen.getByText('Force Resend Selected').closest('button').disabled).toBe(true);
  });

  it('sends each selected employee once and reports the result', async () => {
    await openLog();
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    expect(screen.getByText('Force Resend Selected (3)')).toBeTruthy();
    fireEvent.click(screen.getByText('Force Resend Selected (3)'));
    await waitFor(() => expect(forceResendDailyBriefing).toHaveBeenCalledTimes(2));
    // Pranshu's newest row (a), not the older one (c); plus Visesh's.
    expect(forceResendDailyBriefing.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    expect(confirm.mock.calls[0][0]).toMatch(/2 employees/);
    expect(confirm.mock.calls[0][0]).toMatch(/1 of them already went out/);
    expect(await screen.findByText(/2 sent\./)).toBeTruthy();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    confirm.mockResolvedValue(false);
    await openLog();
    fireEvent.click(screen.getByLabelText('Select visesh.lodha@greensglobal.com 2026-09-26'));
    fireEvent.click(screen.getByText('Force Resend Selected (1)'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(forceResendDailyBriefing).not.toHaveBeenCalled();
  });

  it('lists who failed', async () => {
    forceResendDailyBriefing.mockImplementation((id) => (id === 'b'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ sentNow: true, mode: 'test', hadContent: true })));
    await openLog();
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    fireEvent.click(screen.getByText('Force Resend Selected (3)'));
    expect(await screen.findByText(/1 failed \(visesh\.lodha@greensglobal\.com\)/)).toBeTruthy();
  });
});

// Timing block (Sep 27): lead minutes, and the default send time for people
// with no shift today. Stored 24h, shown 12-hour.
describe('Timing', () => {
  const TIMING = { mode: 'test', test_recipients: [], outlook_card: 'off',
    leadMinutes: 150, includeNoShift: false, defaultSendTime: '07:00', defaultTimeZone: 'America/Los_Angeles' };
  beforeEach(() => {
    getDailyBriefingConfig.mockResolvedValue(TIMING);
    updateDailyBriefingConfig.mockReset().mockImplementation((p) => Promise.resolve({ ...TIMING, ...p }));
  });

  it('shows the saved values, with the no-shift controls off by default', async () => {
    render(<DailyBriefingSettings />);
    expect((await screen.findByLabelText('Minutes before shift start')).value).toBe('150');
    const time = screen.getByLabelText('Default send time');
    expect(time.value).toBe('07:00');
    expect(time.selectedOptions[0].textContent).toBe('7:00 AM');
    expect(time.disabled).toBe(true);
    expect(screen.getByLabelText('Default time zone').value).toBe('America/Los_Angeles');
    expect(screen.getByLabelText(/People with no shift today/).checked).toBe(false);
  });

  it('saves the timing the admin picked', async () => {
    render(<DailyBriefingSettings />);
    fireEvent.change(await screen.findByLabelText('Minutes before shift start'), { target: { value: '90' } });
    fireEvent.click(screen.getByLabelText(/People with no shift today/));
    fireEvent.change(screen.getByLabelText('Default send time'), { target: { value: '18:30' } });
    expect(screen.getByLabelText('Default send time').selectedOptions[0].textContent).toBe('6:30 PM');
    fireEvent.click(screen.getByText('Save Settings'));
    await waitFor(() => expect(updateDailyBriefingConfig).toHaveBeenCalled());
    expect(updateDailyBriefingConfig.mock.calls[0][0]).toMatchObject({
      leadMinutes: 90, includeNoShift: true, defaultSendTime: '18:30', defaultTimeZone: 'America/Los_Angeles',
    });
  });

  it('refuses a lead outside 30 to 360 minutes without calling the server', async () => {
    render(<DailyBriefingSettings />);
    fireEvent.change(await screen.findByLabelText('Minutes before shift start'), { target: { value: '400' } });
    fireEvent.click(screen.getByText('Save Settings'));
    expect(await screen.findByText(/whole number from 30 to 360/)).toBeTruthy();
    expect(updateDailyBriefingConfig).not.toHaveBeenCalled();
  });
});
