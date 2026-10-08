import { describe, it, expect } from 'vitest';
import { formatDistance, formatAccuracy, metersToFeet, feetToMeters } from './distance';

// Distances read in US units (Oct 2): miles from a tenth of a mile, feet below.
describe('distance in US units', () => {
  it('reads miles from 0.1 mi up', () => {
    expect(formatDistance(3800)).toBe('2.4 mi');          // the "3.8 km from GS Temecula" punch
    expect(formatDistance(161)).toBe('0.1 mi');
    expect(formatDistance(25000)).toBe('16 mi');
  });
  it('reads feet below a tenth of a mile', () => {
    expect(formatDistance(150)).toBe('492 ft');
    expect(formatDistance(0)).toBe('0 ft');
    expect(formatDistance(undefined)).toBe('');
  });
  it('shows GPS accuracy with a plus-minus', () => {
    expect(formatAccuracy(7)).toBe('±23 ft');
    expect(formatAccuracy(78)).toBe('±256 ft');
    expect(formatAccuracy(2000)).toBe('±1.2 mi');
  });
  it('converts feet and meters both ways', () => {
    expect(Math.round(metersToFeet(100))).toBe(328);
    expect(Math.round(feetToMeters(650))).toBe(198);
  });
});
