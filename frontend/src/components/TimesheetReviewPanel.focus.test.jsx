import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The Daily Briefing's Review and Submit button (Neil, 11/12/2026) opens the
// Time Sheet with do=submit: once THAT period's panel is drawn, its Send to
// Manager button is focused - never clicked for them.

const submit = vi.fn(() => Promise.resolve({}));
vi.mock('../api', () => ({ api: { timesheetReviewSubmit: (...a) => submit(...a) } }));
vi.mock('./ESign', () => ({ SignModal: () => null }));

const TimesheetReviewPanel = (await import('./TimesheetReviewPanel')).default;
const review = { status: 'not_submitted', canSubmit: true, submitBlocker: '', periodStart: '2026-11-01', periodEnd: '2026-11-14',
  employeeEmail: 'emp@x.com', managerEmail: 'mgr@x.com', rounds: [], parties: [] };
const props = { self: true, anchor: '2026-11-01', periodLabel: '11/01/2026 - 11/14/2026', nameFor: (e) => e, onChanged: () => {} };

describe('TimesheetReviewPanel - Review and Submit from the briefing', () => {
  it('focuses Send to Manager on the linked period, then says it is done', () => {
    const done = vi.fn();
    render(<TimesheetReviewPanel {...props} review={review} focusAction="2026-11-01" onFocused={done} />);
    expect(document.activeElement?.textContent).toMatch(/Send to Manager/);
    expect(done).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('waits while another period is on screen', () => {
    const done = vi.fn();
    render(<TimesheetReviewPanel {...props} review={{ ...review, periodStart: '2026-11-15' }} focusAction="2026-11-01" onFocused={done} />);
    expect(screen.getByText(/Send to Manager/)).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
  });
});
