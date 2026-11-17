import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import DayTimeline from './DayTimeline';

// 11/17/2026: hour ticks were snapped to whole UTC hours and labeled with
// the hour only, so in a half-hour zone (India) every label was 30 minutes
// early. They snap to whole hours on the reader's clock.

const utc = (h, m = 0) => Date.UTC(2026, 10, 17, h, m);

afterEach(() => vi.restoreAllMocks());

describe('DayTimeline ticks', () => {
  it('draws its ticks on whole hours of the reader\'s clock', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-330);
    const at = (h, m) => new Date(utc(h, m)).toISOString().slice(0, 19);   // zone-less UTC, like the server
    const { container } = render(<DayTimeline date="2026-11-10" punches={[{ kind: 'in', at: at(3, 40) }, { kind: 'out', at: at(6, 10) }]} />);
    // 9:10 AM - 11:40 AM in India: the window is 9:00 AM - 12:00 PM, three hours, a tick at each.
    const ticks = [...container.querySelectorAll('span')].filter((el) => el.style.transform === 'translateX(-50%)');
    expect(ticks.map((el) => el.style.left)).toEqual(['0%', '33.33333333333333%', '66.66666666666666%', '100%']);
    // The work bar starts 10 minutes into that window, not 40 (a window snapped to UTC hours began at 8:30 AM).
    expect(parseFloat(container.querySelector('[style*="cursor: pointer"]').style.left)).toBeCloseTo((10 / 180) * 100, 5);
  });

  it('is unchanged in a whole-hour zone', () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(480);   // Pacific
    const at = (h, m) => new Date(utc(h, m)).toISOString().slice(0, 19);
    const { container } = render(<DayTimeline date="2026-11-10" punches={[{ kind: 'in', at: at(16, 10) }, { kind: 'out', at: at(18, 50) }]} />);
    const ticks = [...container.querySelectorAll('span')].filter((el) => el.style.transform === 'translateX(-50%)');
    expect(ticks).toHaveLength(4);   // 8:00, 9:00, 10:00 and 11:00 AM
    expect(parseFloat(container.querySelector('[style*="cursor: pointer"]').style.left)).toBeCloseTo((10 / 180) * 100, 5);
  });
});
