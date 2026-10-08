import { describe, it, expect } from 'vitest';
import { headerClocks, tzOffsetMinutes, zoneLabel, CALIFORNIA_TZ, ALL_ZONES } from './worldClockZones';
import { formatTimeIn, greetingFor } from './datetime';

// Dashboard greeting clocks (Neil, Sep 28): the viewer's own time bare, and
// California time beside it only when the viewer's clock reads differently.
// The viewer's zone is passed in, so these run the same on any machine.
const SUMMER = new Date('2026-09-28T23:42:00Z');   // 4:42 PM PDT
const WINTER = new Date('2026-01-15T23:42:00Z');   // 3:42 PM PST

const view = (clocks, now) => clocks.map((c) =>
  `${c.label ? `${c.label} ` : ''}${formatTimeIn(now, c.tz)}${c.abbr ? ` ${c.abbr}` : ''}`);

describe('headerClocks', () => {
  it('in California: one bare time, no label, no second clock', () => {
    const clocks = headerClocks([], SUMMER, 'America/Los_Angeles');
    expect(view(clocks, SUMMER)).toEqual(['4:42 PM']);
  });

  it('on the same clock as California (Vancouver, Tijuana): still just one time', () => {
    expect(view(headerClocks([], SUMMER, 'America/Vancouver'), SUMMER)).toEqual(['4:42 PM']);
    expect(view(headerClocks([], WINTER, 'America/Tijuana'), WINTER)).toEqual(['3:42 PM']);
  });

  it('elsewhere: own time first, then California with PDT in summer', () => {
    const clocks = headerClocks([], SUMMER, 'America/New_York');
    expect(view(clocks, SUMMER)).toEqual(['7:42 PM', 'California 4:42 PM PDT']);
    expect(clocks.every((c) => c.home)).toBe(true);
  });

  it('uses PST in winter', () => {
    expect(view(headerClocks([], WINTER, 'Asia/Kolkata'), WINTER))
      .toEqual(['5:12 AM', 'California 3:42 PM PST']);
  });

  it('keeps My Profile picks after California, skipping repeats of a time already shown', () => {
    // Picks are stored canonicalized (setZones), and this engine's ICU may
    // spell India "Asia/Calcutta" - take it from ALL_ZONES like the picker does.
    const india = ALL_ZONES.find((tz) => /Kolkata|Calcutta/.test(tz));
    const clocks = headerClocks(['America/Los_Angeles', india, 'America/New_York'], SUMMER, 'America/New_York');
    // Los Angeles repeats California and New York repeats the viewer's own
    // time, so only India is added.
    const shown = view(clocks, SUMMER);
    expect(shown.slice(0, 2)).toEqual(['7:42 PM', 'California 4:42 PM PDT']);
    expect(shown).toHaveLength(3);
    expect(shown[2]).toBe('India 5:12 AM');
    expect(clocks[2].home).toBe(false);
  });

  // The point of the row (Neil, Oct 7): a clock never repeats the viewer's
  // own time under a country name.
  it('in India with India picked: one bare time plus California, no "India" repeat', () => {
    const india = ALL_ZONES.find((tz) => /Kolkata|Calcutta/.test(tz));
    expect(view(headerClocks([india], SUMMER, 'Asia/Kolkata'), SUMMER))
      .toEqual(['5:12 AM', 'California 4:42 PM PDT']);
  });

  it('in California with California and India picked: no California repeat', () => {
    const india = ALL_ZONES.find((tz) => /Kolkata|Calcutta/.test(tz));
    expect(view(headerClocks(['America/Los_Angeles', india], SUMMER, 'America/Los_Angeles'), SUMMER))
      .toEqual(['4:42 PM', 'India 5:12 AM']);
  });
});

describe('zoneLabel', () => {
  const find = (re) => ALL_ZONES.find((tz) => re.test(tz));
  it('drops the city for a country that runs one clock', () => {
    expect(zoneLabel(find(/Kolkata|Calcutta/))).toBe('India');
    expect(zoneLabel(find(/Tokyo/))).toBe('Japan');
    expect(zoneLabel(find(/London/))).toBe('United Kingdom');
    expect(zoneLabel(find(/Singapore/))).toBe('Singapore');
    expect(zoneLabel('UTC')).toBe('UTC');
  });
  it('keeps the city where the country has several zones', () => {
    expect(zoneLabel(find(/Denver/))).toBe('United States - Denver');
    expect(zoneLabel(find(/Sydney/))).toBe('Australia - Sydney');
    expect(zoneLabel(find(/Azores/))).toBe('Portugal - Azores');
  });

  it('never shows a Local label', () => {
    for (const tz of ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo']) {
      expect(headerClocks(['Asia/Kolkata'], SUMMER, tz).some((c) => /local/i.test(c.label))).toBe(false);
    }
  });

  it('reads UTC offsets off the zone clock, DST included', () => {
    expect(tzOffsetMinutes(CALIFORNIA_TZ, SUMMER)).toBe(-420);
    expect(tzOffsetMinutes(CALIFORNIA_TZ, WINTER)).toBe(-480);
    expect(tzOffsetMinutes('Asia/Kolkata', SUMMER)).toBe(330);
  });
});

describe('greetingFor', () => {
  it('is Title Case', () => {
    expect(greetingFor(new Date(2026, 8, 28, 9))).toBe('Good Morning');
    expect(greetingFor(new Date(2026, 8, 28, 13))).toBe('Good Afternoon');
    expect(greetingFor(new Date(2026, 8, 28, 19))).toBe('Good Evening');
  });
});
