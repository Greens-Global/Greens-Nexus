// Meeting Notes, Phase 3 (Neil, 11/12/2026): Whisper, on the device.
//
// A module Web Worker so the speech model never blocks the page. It loads
// the runtime (transformers.js, ONNX Runtime's WebAssembly build) and the
// model from OUR address - functions/ml/[[path]].js serves them, checked and
// cached at the edge - never a CDN (the CSP is self-only). The audio it is
// handed never leaves this worker; nothing is sent anywhere.
//
// Self-contained on purpose (no imports): Vite builds it as its own small
// chunk and the runtime is fetched at run time, so the app's bundle does not
// carry it.
//
//   in:  { type: 'load', base, model, revision, multilingual }
//   out: { type: 'progress', file, loaded, total } ... { type: 'ready', model }
//   in:  { type: 'transcribe', id, audio: Float32Array (16 kHz mono) }
//   out: { type: 'result', id, text, chunks: [{ start, end, text }], ms }
//   out: { type: 'error', id?, message }

let asr = null;
let multilingual = false;

function post(msg) { self.postMessage(msg); }

async function load({ base, model, revision = 'main', multilingual: multi = false }) {
  const T = await import(/* @vite-ignore */ `${base}/ml/rt/transformers.min.js`);
  const { env, pipeline } = T;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = `${base}/ml/hf/`;
  env.remotePathTemplate = '{model}/resolve/{revision}/';
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${base}/ml/rt/ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${base}/ml/rt/ort-wasm-simd-threaded.asyncify.wasm`,
  };
  // Import the runtime's loader from its own URL: the default copies it into
  // a blob: URL first, and the CSP (script-src 'self') rightly refuses that.
  env.useWasmCache = false;
  env.backends.onnx.wasm.numThreads = 1;      // no cross-origin isolation: one thread
  env.backends.onnx.wasm.proxy = false;
  multilingual = !!multi;
  asr = await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8', device: 'wasm', revision,
    progress_callback: (p) => {
      if (p && p.status === 'progress') post({ type: 'progress', file: p.file || '', loaded: p.loaded || 0, total: p.total || 0 });
    },
  });
  post({ type: 'ready', model });
}

async function transcribe({ id, audio }) {
  if (!asr) throw new Error('The speech model is not loaded');
  const t0 = performance.now();
  const out = await asr(audio, {
    chunk_length_s: 30,
    return_timestamps: true,
    ...(multilingual ? { language: 'english', task: 'transcribe' } : {}),
  });
  const chunks = (out?.chunks || []).map((c) => ({
    start: Number(c.timestamp?.[0]) || 0,
    end: Number(c.timestamp?.[1] ?? c.timestamp?.[0]) || 0,
    text: String(c.text || '').trim(),
  })).filter((c) => c.text);
  post({ type: 'result', id, text: String(out?.text || '').trim(), chunks, ms: Math.round(performance.now() - t0) });
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'load') await load(msg);
    else if (msg.type === 'transcribe') await transcribe(msg);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: String(err?.message || err || 'Speech engine error') });
  }
};
