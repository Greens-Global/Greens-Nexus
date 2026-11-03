// Items phase 4 - reading a code out of the live camera picture.
//
// The browser's own BarcodeDetector when it has one (Chrome and Android: QR
// tags plus the 1D barcodes on manufacturer serial stickers), else jsqr
// (self-hosted, its own lazy chunk vendor-jsqr - iPhone Safari has no
// BarcodeDetector) over a downscaled frame. Nothing is fetched from a
// network: the CSP is self only.

const NATIVE_FORMATS = ['qr_code', 'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'data_matrix'];
// The long side jsqr reads: ~480px is plenty for a tag held in the frame and
// keeps an older iPhone cool (review L8); printed tags are dark on white, so
// jsqr never tries the inverted image either.
const FRAME_MAX = 480;

const loadJsQRDefault = () => import('jsqr').then((m) => m.default || m);

/**
 * { kind: 'native' | 'fallback', decode(source) -> Promise<string> }
 * `source` is a playing <video> (or anything drawImage / detect accept).
 */
export async function createDecoder({ win = typeof window !== 'undefined' ? window : undefined, doc = typeof document !== 'undefined' ? document : undefined, loadJsQR = loadJsQRDefault } = {}) {
  const BD = win?.BarcodeDetector;
  if (typeof BD === 'function') {
    try {
      let formats = NATIVE_FORMATS;
      if (typeof BD.getSupportedFormats === 'function') {
        const supported = await BD.getSupportedFormats();
        formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
      }
      if (formats.includes('qr_code')) {
        const detector = new BD({ formats });
        return {
          kind: 'native',
          async decode(source) {
            const codes = await detector.detect(source);
            return (codes || []).find((c) => c && c.rawValue)?.rawValue || '';
          },
        };
      }
    } catch { /* a detector that will not build: read with jsqr instead */ }
  }
  const jsQR = await loadJsQR();
  let canvas = null;
  let ctx = null;
  return {
    kind: 'fallback',
    async decode(source) {
      const w = source?.videoWidth || source?.width || 0;
      const h = source?.videoHeight || source?.height || 0;
      if (!w || !h) return '';
      const scale = Math.min(1, FRAME_MAX / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      if (!canvas) { canvas = doc.createElement('canvas'); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
      if (!ctx) return '';
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      ctx.drawImage(source, 0, 0, cw, ch);
      const img = ctx.getImageData(0, 0, cw, ch);
      const hit = jsQR(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
      return hit?.data || '';
    },
  };
}

/**
 * Read frames on a cadence until one decodes or stop() is called. One frame
 * at a time (a slow phone never queues reads); the first code ends the loop
 * and goes to onCode - Scan Again starts a new loop.
 */
export function startScanLoop({ decode, source, onCode, intervalMs = 160,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t) }) {
  let stopped = false;
  let timer = null;
  const ready = () => source && (source.readyState === undefined || source.readyState >= 2);
  const tick = async () => {
    timer = null;
    if (stopped) return;
    if (ready()) {
      let code;
      try { code = await decode(source); } catch { code = ''; }
      if (stopped) return;
      if (code) { stopped = true; onCode(code); return; }
    }
    timer = schedule(tick, intervalMs);
  };
  timer = schedule(tick, 0);
  return {
    stop() { stopped = true; if (timer != null) cancel(timer); timer = null; },
    get running() { return !stopped; },
  };
}
