import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Delivery Log bulk Force Resend: tick rows, send them all, one email per
// employee even when two of their rows are ticked.

const getDailyBriefingConfig = vi.fn();
const getDailyBriefingLog = vi.fn();
const forceResendDailyBriefing = vi.fn();
vi.mock('../api', () => ({
  api: {
    getDailyBriefingConfig: (...a) => getDailyBriefingConfig(...a),
    getDailyBriefingLog: (...a) => getDailyBriefingLog(...a),
    forceResendDailyBriefing: (...a) => forceResendDailyBriefing(...a),
    updateDailyBriefingConfig: vi.fn(),
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
