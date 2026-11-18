// Meeting Notes, Phase 3 (Neil, 11/12/2026): the speech engines.
//
//   Whisper (the first choice) - runs in a Web Worker on this device
//     (whisperWorker.js); the runtime and model come from our own address
//     (functions/ml/[[path]].js) and are kept by the browser after the first
//     download. English models, int8: "base" on a computer, "tiny" on a phone
//     or a slow machine - and a computer that cannot keep up switches itself
//     to "tiny" mid-meeting.
//   The browser's own speech service (the fallback, Neil's call) - what Notes
//     dictation already uses. No download, but Chrome sends the audio to
//     Google and Safari to Apple to recognize it, it hears the microphone only,
//     and it cannot read a recording. Used only when Whisper cannot run here.
//
// One Whisper engine per tab (getEngine), shared by meetings and voice notes,
// so the model loads once.

export const MODELS = {
  tiny: { id: 'Xenova/whisper-tiny.en', mb: 41, label: 'Fast' },
  base: { id: 'Xenova/whisper-base.en', mb: 77, label: 'Accurate' },
};
export const REVISION = 'main';

// A WebAssembly module that uses SIMD: Whisper needs it.
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export function whisperSupported() {
  try {
    return typeof Worker === 'function' && typeof WebAssembly === 'object' && WebAssembly.validate(SIMD);
  } catch { return false; }
}

export const browserSpeech = () => (typeof window === 'undefined' ? null : (window.SpeechRecognition || window.webkitSpeechRecognition || null));

/** 'tiny' on a phone, a small or low-memory machine; 'base' otherwise. */
export function pickModel(nav = typeof navigator === 'undefined' ? {} : navigator, phone = false) {
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory || 8;
  return phone || cores < 6 || memory <= 4 ? 'tiny' : 'base';
}

const makeWorker = () => new Worker(new URL('./whisperWorker.js', import.meta.url), { type: 'module' });

export class WhisperEngine {
  constructor(factory = makeWorker, base = (typeof location !== 'undefined' ? location.origin : '')) {
    this.factory = factory;
    this.base = base;
    this.worker = null;
    this.model = '';
    this.loading = null;
    this.waiting = new Map();
    this.seq = 0;
  }

  _ensure() {
    if (this.worker) return;
    this.worker = this.factory();
    this.worker.onmessage = (e) => this._onMessage(e.data || {});
    this.worker.onerror = (e) => this._failAll(e?.message || 'The speech engine stopped');
  }

  _failAll(message) {
    for (const [, w] of this.waiting) w.reject(new Error(message));
    this.waiting.clear();
    if (this._loadReject) { this._loadReject(new Error(message)); this._loadReject = null; }
  }

  _onMessage(m) {
    if (m.type === 'progress') { this._onProgress?.(m); return; }
    if (m.type === 'ready') { this.model = this._want; this._loadResolve?.(); this._loadReject = null; return; }
    if (m.type === 'result') { this.waiting.get(m.id)?.resolve(m); this.waiting.delete(m.id); return; }
    if (m.type === 'error') {
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id).reject(new Error(m.message)); this.waiting.delete(m.id); }
      else if (this._loadReject) { this._loadReject(new Error(m.message)); this._loadReject = null; }
    }
  }

  /** Load a model size ('tiny' | 'base'); progress reports { loaded, total } in bytes over every file. */
  load(size, onProgress) {
    if (this.model === size && !this.loading) return Promise.resolve();
    this._ensure();
    const files = new Map();
    this._onProgress = (p) => {
      files.set(p.file, p);
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) { loaded += f.loaded || 0; total += f.total || 0; }
      onProgress?.({ loaded, total: Math.max(total, MODELS[size].mb * 1e6) });
    };
    this._want = size;
    this.loading = new Promise((resolve, reject) => {
      this._loadResolve = resolve;
      this._loadReject = reject;
      this.worker.postMessage({ type: 'load', base: this.base, model: MODELS[size].id, revision: REVISION, multilingual: false });
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  /** Text and timed pieces for 16 kHz mono samples. */
  transcribe(audio) {
    this._ensure();
    const id = `t${(this.seq += 1)}`;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
    });
  }

  terminate() {
    this._failAll('Stopped');
    this.worker?.terminate();
    this.worker = null;
    this.model = '';
  }
}

let shared = null;
export function getEngine() {
  if (!shared) shared = new WhisperEngine();
  return shared;
}
export function setEngineForTests(e) { shared = e; }

/** The browser's speech service, kept listening across its own pauses. Each
 *  finished phrase comes back as { text, at } (Unix seconds). */
export class BrowserSpeech {
  constructor(Rec = browserSpeech()) {
    this.Rec = Rec;
    this.on = false;
  }

  start({ onPhrase, onError }) {
    if (!this.Rec) throw new Error('This browser has no speech service');
    this.on = true;
    const run = () => {
      if (!this.on) return;
      const r = new this.Rec();
      this.r = r;
      r.lang = 'en-US';
      r.continuous = true;
      r.interimResults = false;
      let heard = Date.now();
      r.onspeechstart = () => { heard = Date.now(); };
      r.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const res = e.results[i];
          const text = String(res[0]?.transcript || '').trim();
          if (res.isFinal && text) onPhrase({ text, at: heard / 1000 });
          heard = Date.now();
        }
      };
      r.onerror = (e) => {
        if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') { this.on = false; onError?.(new Error('The microphone or the speech service was not allowed')); }
      };
      // It stops by itself after a pause - start again while the meeting runs.
      r.onend = () => { if (this.on) setTimeout(run, 250); };
      try { r.start(); } catch { if (this.on) setTimeout(run, 500); }
    };
    run();
  }

  stop() {
    this.on = false;
    try { this.r?.stop(); } catch { /* already stopped */ }
  }
}
