import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Location on a punch (Visesh, Oct 20 2026): never blocks, always asks.
// A missed fix shows Share Your Location with Try Again / Punch Without
// Location; going without reports whether the browser had location blocked.
const getPosition = vi.fn();
vi.mock('./geoPosition', () => ({ getPosition: (...a) => getPosition(...a) }));
const confirm = vi.fn();
vi.mock('../ui/dialog', () => ({ dialog: { confirm: (...a) => confirm(...a) } }));

const mod = await import('./punchLocation');
const POS = { lat: '33.5', lng: '-117.1', accuracy_m: 20 };

function setPermission(state) {
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: state === null ? undefined : { query: async () => ({ state }) },
  });
}

describe('punchLocation', () => {
  beforeEach(() => {
    getPosition.mockReset(); confirm.mockReset();
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: () => {} } });
    setPermission('prompt');
  });
  afterEach(() => setPermission(null));

  it('keeps the first fix without asking', async () => {
    const r = await mod.askPunchPosition(Promise.resolve(POS));
    expect(r).toEqual({ pos: POS, locationOff: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks to share the location when there is no fix, and Try Again uses the longer timeout', async () => {
    confirm.mockResolvedValueOnce(true);
    getPosition.mockResolvedValueOnce(POS);
    const r = await mod.askPunchPosition(null);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1]).toMatchObject({ title: 'Share Your Location', confirmText: 'Try Again', cancelText: 'Punch Without Location' });
    expect(getPosition).toHaveBeenCalledWith(mod.LOCATION_RETRY_MS);
    expect(r).toEqual({ pos: POS, locationOff: false });
  });

  it('keeps asking while Try Again still finds nothing', async () => {
    confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    getPosition.mockResolvedValueOnce(null);
    const r = await mod.askPunchPosition(null);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ pos: null, locationOff: false });
  });

  it('Punch Without Location goes ahead - Location Off when the browser blocks it', async () => {
    setPermission('denied');
    confirm.mockResolvedValueOnce(false);
    const r = await mod.askPunchPosition(null);
    expect(r).toEqual({ pos: null, locationOff: true });
    expect(confirm.mock.calls[0][0]).toMatch(/turned off for Nexus/);
    expect(confirm.mock.calls[0][0]).toMatch(/Location Off on your Time Sheet/);
  });

  it('a browser with no geolocation punches without asking', async () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    const r = await mod.askPunchPosition(null);
    expect(confirm).not.toHaveBeenCalled();
    expect(r).toEqual({ pos: null, locationOff: false });
  });

  it('the ask names the steps for each case', () => {
    expect(mod.locationHelpText('denied')).toMatch(/Set Location to Allow/);
    expect(mod.locationHelpText('prompt')).toMatch(/click Allow/);
    expect(mod.locationHelpText('prompt')).toMatch(/No Location on your Time Sheet/);
  });
});
