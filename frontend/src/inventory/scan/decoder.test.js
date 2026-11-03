import { describe, it, expect, vi } from 'vitest';
import { createDecoder, startScanLoop } from './decoder';
import { cameraErrorKind, cameraSupport, torchSupported, cameraHelp } from './camera';

// Items phase 4: the browser's BarcodeDetector when it can read QR codes,
// else jsqr over a downscaled frame (iPhone Safari has no BarcodeDetector).

function fakeDoc() {
  const ctx = { drawImage: vi.fn(), getImageData: vi.fn((x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })) };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx) };
  return { doc: { createElement: vi.fn(() => canvas) }, canvas, ctx };
}

describe('the decoder', () => {
  it('uses the native BarcodeDetector when it reads QR codes', async () => {
    const detect = vi.fn(async () => [{ rawValue: '' }, { rawValue: 'https://x/itemmanagement/item/a' }]);
    class BarcodeDetector { constructor(opts) { this.opts = opts; BarcodeDetector.last = this; } detect(s) { return detect(s); } }
    BarcodeDetector.getSupportedFormats = async () => ['qr_code', 'code_128', 'aztec'];
    const loadJsQR = vi.fn();
    const d = await createDecoder({ win: { BarcodeDetector }, loadJsQR });
    expect(d.kind).toBe('native');
    expect(BarcodeDetector.last.opts.formats).toEqual(['qr_code', 'code_128']);
    expect(await d.decode({ videoWidth: 10, videoHeight: 10 })).toBe('https://x/itemmanagement/item/a');
    expect(loadJsQR).not.toHaveBeenCalled();
  });

  it('falls back to jsqr where there is no BarcodeDetector (iPhone Safari)', async () => {
    const jsQR = vi.fn(() => ({ data: 'GG-00042' }));
    const { doc, canvas, ctx } = fakeDoc();
    const d = await createDecoder({ win: {}, doc, loadJsQR: async () => jsQR });
    expect(d.kind).toBe('fallback');
    const video = { videoWidth: 1280, videoHeight: 720 };
    expect(await d.decode(video)).toBe('GG-00042');
    // Downscaled to 480 on the long side and read the right way round only
    // (review L8: cooler on an older iPhone; printed tags are dark on white).
    expect([canvas.width, canvas.height]).toEqual([480, 270]);
    expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 480, 270);
    expect(jsQR).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 480, 270, { inversionAttempts: 'dontInvert' });
  });

  it('falls back to jsqr when the native detector cannot read QR codes', async () => {
    class BarcodeDetector { detect() { return []; } }
    BarcodeDetector.getSupportedFormats = async () => ['ean_13'];
    const { doc } = fakeDoc();
    const d = await createDecoder({ win: { BarcodeDetector }, doc, loadJsQR: async () => () => null });
    expect(d.kind).toBe('fallback');
    expect(await d.decode({ videoWidth: 100, videoHeight: 100 })).toBe('');
  });

  it('reads nothing from a frame that has no size yet', async () => {
    const jsQR = vi.fn();
    const d = await createDecoder({ win: {}, doc: fakeDoc().doc, loadJsQR: async () => jsQR });
    expect(await d.decode({ videoWidth: 0, videoHeight: 0 })).toBe('');
    expect(jsQR).not.toHaveBeenCalled();
  });
});

describe('the scan loop', () => {
  const manual = () => {
    const q = [];
    return { q, schedule: (fn) => { q.push(fn); return q.length; }, cancel: vi.fn(), run: async () => { const fn = q.shift(); await fn?.(); } };
  };

  it('reads frame after frame until one decodes, then stops', async () => {
    const s = manual();
    const decode = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('GG-1');
    const onCode = vi.fn();
    const loop = startScanLoop({ decode, source: { readyState: 4 }, onCode, schedule: s.schedule, cancel: s.cancel });
    await s.run(); await s.run();
    expect(onCode).toHaveBeenCalledWith('GG-1');
    expect(loop.running).toBe(false);
    expect(s.q).toHaveLength(0);
  });

  it('waits for the video to have a frame', async () => {
    const s = manual();
    const decode = vi.fn();
    startScanLoop({ decode, source: { readyState: 1 }, onCode: vi.fn(), schedule: s.schedule, cancel: s.cancel });
    await s.run();
    expect(decode).not.toHaveBeenCalled();
    expect(s.q).toHaveLength(1);
  });

  it('stop() ends it, even mid-read', async () => {
    const s = manual();
    let release;
    const decode = vi.fn(() => new Promise((r) => { release = r; }));
    const onCode = vi.fn();
    const loop = startScanLoop({ decode, source: { readyState: 4 }, onCode, schedule: s.schedule, cancel: s.cancel });
    const pending = s.run();
    loop.stop();
    release('GG-1');
    await pending;
    expect(onCode).not.toHaveBeenCalled();
  });
});

describe('the camera', () => {
  it('sorts getUserMedia failures into what the person can do', () => {
    expect(cameraErrorKind({ name: 'NotAllowedError' })).toBe('denied');
    expect(cameraErrorKind({ name: 'NotFoundError' })).toBe('nocamera');
    expect(cameraErrorKind({ name: 'NotReadableError' })).toBe('busy');
    expect(cameraErrorKind({ name: 'SecurityError' })).toBe('insecure');
    expect(cameraErrorKind(new Error('x'))).toBe('error');
  });

  it('knows a page without https or getUserMedia cannot scan', () => {
    expect(cameraSupport({ isSecureContext: false, navigator: {} })).toBe('insecure');
    expect(cameraSupport({ isSecureContext: true, navigator: {} })).toBe('unsupported');
    expect(cameraSupport({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } })).toBe('ok');
  });

  it('offers the torch only where the track has one', () => {
    expect(torchSupported({ getCapabilities: () => ({ torch: true }) })).toBe(true);
    expect(torchSupported({ getCapabilities: () => ({}) })).toBe(false);
    expect(torchSupported({})).toBe(false);
    expect(torchSupported(null)).toBe(false);
  });

  it('explains how to allow the camera in the browser at hand', () => {
    expect(cameraHelp('denied', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)').steps.join(' ')).toMatch(/Website Settings/);
    expect(cameraHelp('denied', 'Mozilla/5.0 (Linux; Android 14)').steps.join(' ')).toMatch(/Permissions/);
    expect(cameraHelp('nocamera').title).toBe('No Camera Found');
  });
});
