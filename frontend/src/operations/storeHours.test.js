import { describe, it, expect } from 'vitest';
import { storeHoursCell } from './storeHours';

// The Facility Scorecard's labor column (Neil, 11/21/2026): hours:minutes clocked at the store's
// own work sites, never decimal hours, never pay, never a name.
const HOURS = { from: '2026-11-14', to: '2026-11-20', days: 7, stores: {
  fac_a: { minutes: 7710, people: 4, sites: ['Oak', 'Oak East'] },
  fac_b: { minutes: 0, people: 0, sites: ['Canyon'] },
  fac_c: { minutes: 480, people: 1, sites: ['Valley'] },
} };

describe('storeHoursCell', () => {
  it('reads minutes as hours:minutes and says where and when on hover', () => {
    expect(storeHoursCell(HOURS, 'fac_a')).toEqual({ text: '128:30', title: '128:30 clocked by 4 people at Oak, Oak East, 11/14/2026 - 11/20/2026' });
    expect(storeHoursCell(HOURS, 'fac_c').title).toBe('8:00 clocked by 1 person at Valley, 11/14/2026 - 11/20/2026');
  });
  it('a store with a work site and nobody clocked in reads 0:00, not a dash', () => {
    expect(storeHoursCell(HOURS, 'fac_b').text).toBe('0:00');
  });
  it('a store no work site covers, or hours not loaded, reads a dash', () => {
    expect(storeHoursCell(HOURS, 'fac_z')).toEqual({ text: '-', title: 'No Time Clock work site covers this store.' });
    expect(storeHoursCell(null, 'fac_a').text).toBe('-');
  });
});
