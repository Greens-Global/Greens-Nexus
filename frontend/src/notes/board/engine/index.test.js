import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadEngine, resetEngine, engineLoaded, validateEngine, ENGINE_MEMBERS, CAPTURE } from './index';

const fakeEngine = () => ({
  Canvas: () => null, toScene: () => ({}), fromScene: () => ({}), exportPng: async () => new Blob(), exportSvg: async () => '',
  reconcile: (l) => l, version: 'fake/1',
});

describe('engine adapter: loadEngine', () => {
  beforeEach(() => { resetEngine(); });

  it('names the contract', () => {
    expect(ENGINE_MEMBERS).toEqual(['Canvas', 'toScene', 'fromScene', 'exportPng', 'exportSvg', 'reconcile', 'version']);
    expect(CAPTURE).toEqual({ IMMEDIATELY: 'IMMEDIATELY', NEVER: 'NEVER' });
  });

  it('loads the engine once and hands the same object to every caller', async () => {
    const importer = vi.fn(async () => ({ default: fakeEngine() }));
    resetEngine(importer);
    expect(engineLoaded()).toBeNull();
    const [a, b] = await Promise.all([loadEngine(), loadEngine()]);
    expect(a).toBe(b);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(engineLoaded()).toBe(a);
    await loadEngine();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('a failed load is not remembered: Retry imports again', async () => {
    let fail = true;
    const importer = vi.fn(async () => { if (fail) throw new Error('chunk missing'); return { default: fakeEngine() }; });
    resetEngine(importer);
    await expect(loadEngine()).rejects.toThrow('chunk missing');
    expect(engineLoaded()).toBeNull();
    fail = false;
    const eng = await loadEngine();
    expect(eng.version).toBe('fake/1');
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('refuses a module that is not the whole contract', async () => {
    const half = fakeEngine(); delete half.exportSvg;
    resetEngine(async () => ({ default: half }));
    await expect(loadEngine()).rejects.toThrow(/exportSvg/);
    expect(() => validateEngine(fakeEngine())).not.toThrow();
    expect(() => validateEngine(null)).toThrow();
  });

  it('the real adapter module satisfies the contract', async () => {
    const eng = await loadEngine();
    for (const k of ENGINE_MEMBERS) expect(eng[k], k).toBeDefined();
    expect(typeof eng.version).toBe('string');
    // the word the engine's maker uses never reaches a person
    expect(eng.version.toLowerCase()).not.toContain('excalidraw');
  });
});
