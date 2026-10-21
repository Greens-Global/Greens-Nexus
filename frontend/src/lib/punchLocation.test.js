import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Location on a punch (Neil, Oct 21 2026): the punch never waits or asks -
// it sends whatever the quick attempt found. Turn On on the red location bar
// asks the browser, and shows the steps to allow it when that finds nothing.
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

  it('keeps the first fix', async () => {
    expect(await mod.askPunchPosition(Promise.resolve(POS))).toEqual({ pos: POS, locationOff: false });
  });

  it('never asks at punch time - no fix punches straight away', async () => {
    expect(await mod.askPunchPosition(null)).toEqual({ pos: null, locationOff: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(getPosition).not.toHaveBeenCalled();
  });

  it('reports Location Off when the browser blocks it', async () => {
    setPermission('denied');
    expect(await mod.askPunchPosition(null)).toEqual({ pos: null, locationOff: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Turn On asks the browser with the longer budget', async () => {
    getPosition.mockResolvedValueOnce(POS);
    expect(await mod.turnOnLocation()).toEqual(POS);
    expect(getPosition).toHaveBeenCalledWith(mod.LOCATION_RETRY_MS);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Turn On while blocked shows the steps; Not Now gives up', async () => {
    setPermission('denied');
    confirm.mockResolvedValueOnce(false);
    expect(await mod.turnOnLocation()).toBeNull();
    expect(getPosition).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0][0]).toMatch(/Set Location to Allow/);
    expect(confirm.mock.calls[0][1]).toMatchObject({ title: 'Turn On Location', confirmText: 'Try Again', cancelText: 'Not Now' });
  });

  it('Turn On with no fix: Try Again tries once more', async () => {
    getPosition.mockResolvedValueOnce(null).mockResolvedValueOnce(POS);
    confirm.mockResolvedValueOnce(true);
    expect(await mod.turnOnLocation()).toEqual(POS);
    expect(getPosition).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0][0]).toMatch(/click Allow/);
  });

  it('a browser with no geolocation cannot turn it on', async () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    expect(await mod.turnOnLocation()).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
});
