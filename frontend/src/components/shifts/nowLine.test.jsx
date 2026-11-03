import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { nowLineFor } from './nowLine';
import ScheduleDay from './ScheduleDay';
import { DayHeader } from './WeekGrid';
import { DayStrip } from './SchedulePhone';
import { parseIso } from './shiftLib';

// The now marker (Neil, 11/02/2026): today's header in the live accent and,
// on the Day view's 24-hour axis, a line at the TEAM zone's current time.
// 22:14 UTC on 11/02/2026 = 2:14 PM in Los Angeles (PST - DST ended 11/01)
// and 3:44 AM on 11/03 in Kolkata.
const AT = new Date('2026-11-02T22:14:00Z');

describe('nowLineFor', () => {
  it('reads the team zone wall clock', () => {
    const la = nowLineFor('2026-11-02', 'America/Los_Angeles', AT);
    expect(la.minutes).toBe(14 * 60 + 14);
    expect(la.frac).toBeCloseTo(854 / 1440, 10);
    expect(la.label).toBe('2:14 PM');
    const ny = nowLineFor('2026-11-02', 'America/New_York', AT);
    expect(ny.label).toBe('5:14 PM');
  });

  it('is null when the date is not today in that zone', () => {
    expect(nowLineFor('2026-11-02', 'Asia/Kolkata', AT)).toBeNull();
    const ist = nowLineFor('2026-11-03', 'Asia/Kolkata', AT);
    expect(ist.label).toBe('3:44 AM');
    expect(nowLineFor('2026-11-01', 'America/Los_Angeles', AT)).toBeNull();
    expect(nowLineFor('', 'America/Los_Angeles', AT)).toBeNull();
  });

  it('puts midnight at the left edge', () => {
    const m = nowLineFor('2026-11-02', 'UTC', new Date('2026-11-02T00:00:30Z'));
    expect(m.frac).toBe(0);
    expect(m.label).toBe('12:00 AM');
  });
});

const dayProps = (over = {}) => ({
  date: '2026-11-02', sections: [{ id: 'g1', name: 'Crew', isGroup: false, members: [{ email: 'amy@x.com', name: 'Amy Adams', availability: [] }] }],
  shifts: [], openCells: {}, notes: {}, canManage: false, offOn: () => [], holOn: () => null, copied: null, prefs: {},
  rowEditable: () => false, shiftEditable: () => false, on: {}, single: true, ...over,
});
const lines = () => document.querySelectorAll('[data-now-line]');

describe('ScheduleDay now line', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sits at the team zone time, moves each minute, and clears its timers on unmount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const view = render(<ScheduleDay {...dayProps({ teamZone: 'America/Los_Angeles' })} />);
    expect(lines().length).toBe(1);
    expect(lines()[0].style.left).toBe(`${(854 / 1440) * 100}%`);
    expect(document.querySelector('[data-now-label]').textContent).toBe('Now 2:14 PM');
    act(() => { vi.advanceTimersByTime(60000); });
    expect(document.querySelector('[data-now-label]').textContent).toBe('Now 2:15 PM');
    expect(lines()[0].style.left).toBe(`${(855 / 1440) * 100}%`);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows nothing when the day is not today in the team zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    render(<ScheduleDay {...dayProps({ teamZone: 'Asia/Kolkata' })} />);
    expect(lines().length).toBe(0);
    expect(document.querySelector('[data-now-label]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Today marker', () => {
  it('marks today\'s week-grid header with the live accent', () => {
    const { container, unmount } = render(<DayHeader d={parseIso('2026-11-02')} isToday />);
    const hdr = container.querySelector('[role="columnheader"]');
    expect(hdr.getAttribute('aria-current')).toBe('date');
    expect(hdr.style.boxShadow).toContain('var(--wk-live)');
    expect(screen.getByRole('button', { name: 'Open 11/02/2026' }).style.color).toBe('var(--wk-live-ink)');
    unmount();
    const other = render(<DayHeader d={parseIso('2026-11-03')} isToday={false} />);
    expect(other.container.querySelector('[role="columnheader"]').getAttribute('aria-current')).toBeNull();
  });

  it('rings today on the phone day strip when it is not the picked day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 12, 0));
    const days = [parseIso('2026-11-02'), parseIso('2026-11-03')];
    render(<DayStrip days={days} value="2026-11-03" onChange={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-current')).toBe('date');
    expect(tabs[0].style.color).toBe('var(--wk-live-ink)');
    expect(tabs[1].getAttribute('aria-current')).toBeNull();
    vi.useRealTimers();
  });
});
