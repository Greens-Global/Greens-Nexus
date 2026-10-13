import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Render-smoke for Workforce Analytics > Scorecard (Neil, 10/10): the week
// header, the band tiles, one row per person with their score, the day
// breakdown on click, and the Everyone switch only for company-wide rights.

const amy = {
  email: 'amy@greensglobal.com', name: 'Amy Bolanos', jobTitle: 'Leasing Agent', managerName: 'Mia Lee',
  expectedMin: 2400, workedMin: 2400, leaveMin: 0, coveredMin: 2400, coveragePct: 100, score: 100, band: 'on_track', bandLabel: 'On Track',
  daysAbsent: 0, daysShort: 0, daysLate: 1, missingPunches: 0, activePct: 72,
  days: [
    { date: '2026-10-05', weekday: 'Monday', status: 'full', scored: true, expectedMin: 480, workedMin: 480, leaveMin: 0, shiftStart: '09:00', late: true, flags: [], reasonLabel: '' },
    { date: '2026-10-06', weekday: 'Tuesday', status: 'full', scored: true, expectedMin: 480, workedMin: 480, leaveMin: 0, shiftStart: '09:00', late: false, flags: [], reasonLabel: '' },
    { date: '2026-10-07', weekday: 'Wednesday', status: 'full', scored: true, expectedMin: 480, workedMin: 480, leaveMin: 0, shiftStart: '', late: false, flags: [], reasonLabel: '' },
    { date: '2026-10-08', weekday: 'Thursday', status: 'full', scored: true, expectedMin: 480, workedMin: 480, leaveMin: 0, shiftStart: '', late: false, flags: [], reasonLabel: '' },
    { date: '2026-10-09', weekday: 'Friday', status: 'full', scored: true, expectedMin: 480, workedMin: 480, leaveMin: 0, shiftStart: '', late: false, flags: ['missing_break_end'], reasonLabel: '' },
    { date: '2026-10-10', weekday: 'Saturday', status: 'off', scored: true, expectedMin: 0, workedMin: 0, leaveMin: 0, shiftStart: '', late: false, flags: [], reasonLabel: 'Not scheduled' },
    { date: '2026-10-11', weekday: 'Sunday', status: 'off', scored: true, expectedMin: 0, workedMin: 0, leaveMin: 0, shiftStart: '', late: false, flags: [], reasonLabel: 'Not scheduled' },
  ],
};
const raj = { ...amy, email: 'raj@greensglobal.com', name: 'Raj Patel', expectedMin: 2700, workedMin: 0, coveredMin: 0, coveragePct: 0, score: 0,
  band: 'absent', bandLabel: 'Absent', daysAbsent: 5, daysLate: 0, activePct: null, days: amy.days.map((d) => ({ ...d, status: d.expectedMin ? 'absent' : 'off', workedMin: 0, late: false, flags: [] })) };
const report = {
  weekStart: '2026-10-05', weekEnd: '2026-10-11', scope: 'direct', canSeeCompany: false, people: [raj, amy],
  summary: {}, thresholds: { onTrackPct: 95, belowPct: 70, shortToleranceMin: 15 },
  standards: { US: { hours: 8, days: [1, 2, 3, 4, 5] }, IN: { hours: 9, days: [1, 2, 3, 4, 5] }, default: { hours: 8, days: [1, 2, 3, 4, 5] } },
};
vi.mock('../../api', () => ({ api: {
  getWorkforceScorecard: vi.fn(async () => report),
  emailMeWorkforceScorecard: vi.fn(async () => ({ sent: true, to: 'mia@greensglobal.com' })),
} }));

import Scorecard from './Scorecard';
import { api } from '../../api';

beforeEach(() => { vi.clearAllMocks(); api.getWorkforceScorecard.mockResolvedValue(report); });

describe('Scorecard', () => {
  it('shows the week, the tiles and one row per person, worst first', async () => {
    render(<Scorecard />);
    expect(await screen.findByText('Week of 10/05/2026 - 10/11/2026')).toBeTruthy();
    expect(screen.getByText('Absent All Week').previousSibling.textContent).toBe('1');
    const rows = screen.getAllByRole('button', { expanded: false });
    expect(rows[0].textContent).toContain('Raj Patel');
    expect(rows[1].textContent).toContain('Amy Bolanos');
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('72% active at the computer')).toBeTruthy();
    // Viewer scope: no Everyone switch.
    expect(screen.queryByText('Everyone')).toBeNull();
    expect(api.getWorkforceScorecard).toHaveBeenCalledTimes(1);
    expect(api.getWorkforceScorecard).toHaveBeenCalledWith({ scope: 'team' });
    // A shift time reads 12-hour (CLAUDE.md), not 09:00.
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[1]);
    expect(screen.getAllByText(/from 9:00 AM/).length).toBeGreaterThan(0);
  });

  it('opens the day-by-day breakdown on click and filters by band', async () => {
    render(<Scorecard />);
    const amyRow = (await screen.findAllByRole('button', { expanded: false }))[1];
    fireEvent.click(amyRow);
    expect(screen.getByText('Full - Late')).toBeTruthy();
    expect(screen.getByText('Break never ended')).toBeTruthy();
    expect(screen.getAllByText('Not scheduled').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Absent (1)' }));
    expect(screen.queryByText('Amy Bolanos')).toBeNull();
    expect(screen.getByText('Raj Patel')).toBeTruthy();
  });

  it('moves between weeks, offers Everyone to company-wide rights and emails the report', async () => {
    api.getWorkforceScorecard.mockResolvedValue({ ...report, canSeeCompany: true });
    render(<Scorecard />);
    await screen.findByText('Week of 10/05/2026 - 10/11/2026');
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(api.getWorkforceScorecard).toHaveBeenLastCalledWith({ week_start: '2026-09-28', scope: 'team' });
    fireEvent.click(screen.getByText('Everyone'));
    expect(api.getWorkforceScorecard).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'all' }));
    fireEvent.click(screen.getByRole('button', { name: /Email Me This Report/ }));
    expect(await screen.findByText('Sent to mia@greensglobal.com.')).toBeTruthy();
  });

  it('explains an empty reporting line instead of rendering blank', async () => {
    api.getWorkforceScorecard.mockResolvedValue({ ...report, people: [] });
    render(<Scorecard />);
    expect(await screen.findByText(/None of your direct reports/)).toBeTruthy();
  });
});
