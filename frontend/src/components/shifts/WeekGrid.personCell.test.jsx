import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PersonCell } from './WeekGrid';

// The person cell, Phase 3b (Oct 15): a tiny muted "prefers 24h · max 30h"
// under the hours when the grid passes hours prefs - from `emp.prefs` or an
// availability payload of the {days, dates, prefs} shape - and nothing
// otherwise. Dated availability rows never count as "Limited Availability"
// on their own.

const emp = { email: 'amy@x.com', name: 'Amy Adams', availability: [] };
const hint = () => document.querySelector('[data-hours-prefs]');

describe('PersonCell hours prefs hint', () => {
  it('shows nothing without prefs, or when both are 0', () => {
    const { unmount } = render(<PersonCell emp={emp} hrs={480} />);
    expect(hint()).toBeNull();
    unmount();
    render(<PersonCell emp={{ ...emp, prefs: { preferredHoursWeek: 0, maxHoursWeek: 0 } }} hrs={480} />);
    expect(hint()).toBeNull();
  });

  it('reads the {kind: "prefs"} row the grid payload carries last, which never counts as limited availability', () => {
    render(<PersonCell emp={{ ...emp, availability: [{ kind: 'prefs', preferredHoursWeek: 24, maxHoursWeek: 30 }] }} hrs={480} />);
    expect(hint().textContent).toBe('prefers 24h · max 30h');
    expect(document.body.textContent).not.toContain('Limited Availability');
  });

  it('reads prefs from emp.prefs', () => {
    render(<PersonCell emp={{ ...emp, prefs: { preferredHoursWeek: 24, maxHoursWeek: 30 } }} hrs={480} />);
    expect(hint().textContent).toBe('prefers 24h · max 30h');
    expect(hint().style.whiteSpace).toBe('nowrap');                            // never widens the column
  });

  it('reads prefs from an availability object, and only the weekday rows mark limited availability', () => {
    render(<PersonCell emp={{ ...emp, availability: { days: [], dates: [{ date: '2026-10-20', kind: 'unavailable' }], prefs: { preferredHoursWeek: 0, maxHoursWeek: 30 } } }} hrs={480} />);
    expect(hint().textContent).toBe('max 30h');
    expect(document.body.textContent).not.toContain('Limited Availability');
  });

  it('ignores dated rows mixed into the weekday list for the limited flag', () => {
    render(<PersonCell emp={{ ...emp, availability: [{ date: '2026-10-20', kind: 'unavailable' }, { weekday: 1, kind: 'unavailable', start: '', end: '' }] }} hrs={0} />);
    const tag = document.body.querySelector('[data-limited]');
    expect(tag.textContent).toBe('Limited Availability');
    expect(tag.getAttribute('title')).toMatch(/^Not fully available on a day they usually work: Tue unavailable\./);
  });

  it('is not limited for days they do not work anyway, e.g. weekends off (Neil, Oct 28 2026)', () => {
    render(<PersonCell emp={{ ...emp, availability: [{ weekday: 5, kind: 'unavailable' }, { weekday: 6, kind: 'unavailable' }] }} hrs={0} />);
    expect(document.body.querySelector('[data-limited]')).toBeNull();
  });

  it('is limited when a usual day is only partly available', () => {
    const usual = { start: '06:30', end: '14:30', days: '1,2,3,4,5' };
    render(<PersonCell emp={{ ...emp, availability: [{ weekday: 4, kind: 'available', start: '06:30', end: '12:30' }] }} usual={usual} hrs={0} />);
    expect(document.body.querySelector('[data-limited]')).toBeTruthy();
  });
});
