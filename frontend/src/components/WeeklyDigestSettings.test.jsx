import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Weekly Digest settings (Sep 28): shows Neil's default (Monday, 120 minutes
// before shift), saves the timing, keeps the "confirm before going live"
// speed bump, and the Delivery Log can force-resend one person.

const getWeeklyDigestConfig = vi.fn();
const updateWeeklyDigestConfig = vi.fn();
const getWeeklyDigestLog = vi.fn();
const forceResendWeeklyDigest = vi.fn();
const sendTestWeeklyDigest = vi.fn();
vi.mock('../api', () => ({
  api: {
    getWeeklyDigestConfig: (...a) => getWeeklyDigestConfig(...a),
    updateWeeklyDigestConfig: (...a) => updateWeeklyDigestConfig(...a),
    getWeeklyDigestLog: (...a) => getWeeklyDigestLog(...a),
    forceResendWeeklyDigest: (...a) => forceResendWeeklyDigest(...a),
    sendTestWeeklyDigest: (...a) => sendTestWeeklyDigest(...a),
    getPeopleDirectory: async () => [{ email: 'Amy@greensglobal.com', name: 'Amy Adams' }],
  },
}));
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: () => true }) }));

const WeeklyDigestSettings = (await import('./WeeklyDigestSettings')).default;

const CFG = { mode: 'off', test_recipients: [], sendDay: 1, leadMinutes: 120, includeNoShift: true,
              defaultSendTime: '08:00', defaultTimeZone: 'America/Los_Angeles' };

beforeEach(() => {
  getWeeklyDigestConfig.mockReset().mockResolvedValue({ ...CFG });
  updateWeeklyDigestConfig.mockReset().mockImplementation(async (p) => ({ ...CFG, ...p }));
  getWeeklyDigestLog.mockReset().mockResolvedValue({ rows: [{
    id: 'w1', employeeEmail: 'amy@greensglobal.com', weekStart: '2026-09-28', sentAt: '', mode: 'test',
    overdueCount: 3, teamCount: 0, createdAt: '2026-09-28T14:00:00',
  }], total: 1 });
  forceResendWeeklyDigest.mockReset().mockResolvedValue({ sentNow: true, mode: 'test', hadContent: true });
  confirm.mockReset().mockResolvedValue(true);
  sendTestWeeklyDigest.mockReset().mockResolvedValue({
    sent: true, overdueCount: 3, teamCount: 1, recipients: ['qa@greensglobal.com'], employeeEmail: 'amy@greensglobal.com',
  });
});

describe('WeeklyDigestSettings', () => {
  it('shows the Monday, 120 minutes before shift default', async () => {
    render(<WeeklyDigestSettings />);
    expect((await screen.findByLabelText('Send day')).value).toBe('1');
    expect(screen.getByLabelText('Minutes before shift start').value).toBe('120');
  });

  const saveButton = () => screen.getByRole('button', { name: /^Save$/ });

  it('saves the typed timing with one Save, sending only what changed', async () => {
    render(<WeeklyDigestSettings />);
    const lead = await screen.findByLabelText('Minutes before shift start');
    expect(saveButton()).toBeDisabled();
    fireEvent.change(lead, { target: { value: '90' } });
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateWeeklyDigestConfig).toHaveBeenCalledTimes(1));
    expect(updateWeeklyDigestConfig.mock.calls[0][0]).toEqual({ leadMinutes: 90 });
  });

  it('saves the send day the moment it changes', async () => {
    render(<WeeklyDigestSettings />);
    fireEvent.change(await screen.findByLabelText('Send day'), { target: { value: '3' } });
    await waitFor(() => expect(updateWeeklyDigestConfig).toHaveBeenCalledWith({ sendDay: 3 }));
    expect(await screen.findByText('Send day saved.')).toBeTruthy();
  });

  it('puts a switch back when its save fails', async () => {
    updateWeeklyDigestConfig.mockRejectedValue(new Error('Server said no.'));
    render(<WeeklyDigestSettings />);
    const box = await screen.findByLabelText('Send When There Is No Shift That Day');
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(await screen.findByText('Server said no.')).toBeTruthy();
    expect(screen.getByLabelText('Send When There Is No Shift That Day').checked).toBe(true);
  });

  it('refuses an out-of-range lead time without calling the API', async () => {
    render(<WeeklyDigestSettings />);
    fireEvent.change(await screen.findByLabelText('Minutes before shift start'), { target: { value: '5' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/whole number from 30 to 360/)).toBeTruthy();
    expect(updateWeeklyDigestConfig).not.toHaveBeenCalled();
  });

  it('asks before switching to Live, and stays put when told no', async () => {
    confirm.mockResolvedValue(false);
    render(<WeeklyDigestSettings />);
    fireEvent.click(await screen.findByText('Live'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(updateWeeklyDigestConfig).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    fireEvent.click(screen.getByText('Live'));
    await waitFor(() => expect(updateWeeklyDigestConfig).toHaveBeenCalledWith({ mode: 'live' }));
  });

  it('sends a test digest for one employee and says where it went', async () => {
    render(<WeeklyDigestSettings />);
    const box = await screen.findByLabelText('Send Test Digest');
    const send = screen.getByText('Send Test').closest('button');
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'amy@greensglobal.com' } });
    fireEvent.click(send);
    await waitFor(() => expect(sendTestWeeklyDigest).toHaveBeenCalledWith('amy@greensglobal.com'));
    expect(await screen.findByText("Sent amy@greensglobal.com's digest (3 overdue, 1 team) to qa@greensglobal.com.")).toBeTruthy();
  });

  it('says so when the person has nothing overdue', async () => {
    sendTestWeeklyDigest.mockResolvedValue({ sent: false, overdueCount: 0, teamCount: 0, recipients: ['me@x.com'], employeeEmail: 'bob@greensglobal.com' });
    render(<WeeklyDigestSettings />);
    fireEvent.change(await screen.findByLabelText('Send Test Digest'), { target: { value: 'bob@greensglobal.com' } });
    fireEvent.click(screen.getByText('Send Test'));
    expect(await screen.findByText(/has nothing overdue or waiting right now/)).toBeTruthy();
  });

  it('force-resends one person from the Delivery Log', async () => {
    render(<WeeklyDigestSettings />);
    fireEvent.click(await screen.findByText('Delivery Log'));
    expect(await screen.findByText('amy@greensglobal.com')).toBeTruthy();
    expect(screen.getByText('09/28/2026')).toBeTruthy();
    // Test mode, something overdue, but nothing sent: the send failed.
    expect(screen.getByText('Send Failed')).toBeTruthy();
    fireEvent.click(screen.getByText('Force Resend'));
    await waitFor(() => expect(forceResendWeeklyDigest).toHaveBeenCalledWith('w1'));
    expect(await screen.findByText("Sent amy@greensglobal.com's weekly digest.")).toBeTruthy();
  });
});
