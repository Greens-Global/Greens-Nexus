import { describe, it, expect, vi, beforeEach } from 'vitest';

// Require Location to Punch (Oct 19 2026): a missed fix is retried once with a
// longer timeout, and the blocking message says how to turn location on.
const getPosition = vi.fn();
vi.mock('./geoPosition', () => ({ getPosition: (...a) => getPosition(...a) }));
const alert = vi.fn(async () => true);
vi.mock('../ui/dialog', () => ({ dialog: { alert: (...a) => alert(...a) } }));

const mod = await import('./punchLocation');

describe('punchLocation', () => {
  beforeEach(() => { getPosition.mockReset(); alert.mockClear(); });

  it('keeps the first fix without asking again', async () => {
    const pos = { lat: '1', lng: '2', accuracy_m: 5 };
    expect(await mod.requiredPunchPosition(Promise.resolve(pos))).toBe(pos);
    expect(getPosition).not.toHaveBeenCalled();
  });

  it('retries once with the longer timeout when the first try missed', async () => {
    const pos = { lat: '3', lng: '4', accuracy_m: 9 };
    getPosition.mockResolvedValueOnce(pos);
    expect(await mod.requiredPunchPosition(Promise.resolve(null))).toBe(pos);
    expect(getPosition).toHaveBeenCalledTimes(1);
    expect(getPosition).toHaveBeenCalledWith(mod.LOCATION_RETRY_MS);
  });

  it('gives up with null after the one retry', async () => {
    getPosition.mockResolvedValueOnce(null);
    expect(await mod.requiredPunchPosition(null)).toBeNull();
    expect(getPosition).toHaveBeenCalledTimes(1);
  });

  it('the how-to names the next step and the steps', () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, geolocation: { getCurrentPosition: () => {} } });
    const denied = mod.locationHelpText('denied');
    expect(denied).toContain('Turn on location for this site in your browser, then try again.');
    expect(denied).toContain('blocking location');
    expect(denied).toContain('Set Location to Allow');
    expect(mod.locationHelpText('prompt')).toContain('could not get your location in time');
    vi.unstubAllGlobals();
    expect(mod.locationHelpText('')).toContain('Turn on location for this site in your browser, then try again.');
  });

  it('the blocking message is a titled dialog', async () => {
    await mod.showLocationRequired('denied');
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('Set Location to Allow'), expect.objectContaining({ title: 'Location Required' }));
  });

  it('clock-out never needs a location; other punches do only when required', () => {
    const on = { locationRequired: true };
    expect(mod.needsLocation(on, 'in')).toBe(true);
    expect(mod.needsLocation(on, 'break_start')).toBe(true);
    expect(mod.needsLocation(on, 'out')).toBe(false);
    expect(mod.needsLocation({ locationRequired: false }, 'in')).toBe(false);
    expect(mod.needsLocation(null, 'in')).toBe(false);
  });

  it('recognizes the server refusal', () => {
    expect(mod.isLocationRequiredError({ status: 400, detail: { code: 'location_required' } })).toBe(true);
    expect(mod.isLocationRequiredError({ status: 409, detail: { code: 'bod_required' } })).toBe(false);
    expect(mod.isLocationRequiredError(null)).toBe(false);
  });
});
