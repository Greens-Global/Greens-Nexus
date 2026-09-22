import { describe, it, expect, vi } from 'vitest';

vi.mock('../api', () => ({ api: {} }));
const { needsCountryCode } = await import('./ESign');

// Ten bare digits are ambiguous - 9876543210 is a valid Indian mobile and a
// plausible North American one - so the field asks rather than the server
// guessing and texting a code to a stranger in another country.

describe('needsCountryCode', () => {
  it('asks when a local-looking number has no country code', () => {
    expect(needsCountryCode('9876543210')).toBe(true);
    expect(needsCountryCode('(949) 400-3330')).toBe(true);
    expect(needsCountryCode('98765 43210')).toBe(true);
  });

  it('stays quiet once a country code is there', () => {
    expect(needsCountryCode('+91 98765 43210')).toBe(false);
    expect(needsCountryCode('+1 949 400 3330')).toBe(false);
  });

  it('stays quiet while the number is still being typed, and when empty', () => {
    expect(needsCountryCode('')).toBe(false);
    expect(needsCountryCode('98765')).toBe(false);
    expect(needsCountryCode(undefined)).toBe(false);
  });
});
