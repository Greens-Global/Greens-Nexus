// Meeting Notes, Phase 3 (Neil, 11/12/2026) - the pure parts of turning live
// audio into pieces Whisper can read: 16 kHz mono, cut where it is quiet, and
// who was talking (your microphone or the call in the browser tab). No DOM,
// no network - capture.test.js covers them.

export const RATE = 16000;

/** Average down to `toRate` (the browser records at 44.1 or 48 kHz). */
export function downsample(input, fromRate, toRate = RATE) {
  if (!input?.length) return new Float32Array(0);
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j += 1) sum += input[j];
    out[i] = b > a ? sum / (b - a) : input[a] || 0;
  }
  return out;
}

export function rms(a, from = 0, to = a?.length || 0) {
  if (!a || to <= from) return 0;
  let s = 0;
  for (let i = from; i < to; i += 1) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
}

/** Where to cut inside the last `searchSec` of `samples`: the middle of its
 *  quietest `winSec` - a pause between words, so no word is split in two. */
export function quietestCut(samples, rate = RATE, searchSec = 4, winSec = 0.3) {
  const n = samples.length;
  const win = Math.max(1, Math.round(winSec * rate));
  const from = Math.max(0, n - Math.round(searchSec * rate));
  if (n - from <= win) return n;
  let best = n;
  let bestE = Infinity;
  const step = Math.max(1, Math.round(win / 3));
  for (let s = from; s + win <= n; s += step) {
    const e = rms(samples, s, s + win);
    if (e < bestE) { bestE = e; best = s + Math.floor(win / 2); }
  }
  return best;
}

/** Collects audio and hands back pieces of about `target` seconds (never
 *  more than `max`), each cut at a pause, with where it starts in the
 *  recording (seconds). flush() hands back what is left. */
export class Chunker {
  constructor({ rate = RATE, target = 20, max = 28, search = 4, min = 0.6 } = {}) {
    Object.assign(this, { rate, target, max, search, min });
    this.parts = [];
    this.length = 0;
    this.offset = 0;       // samples already handed out
  }

  push(samples) {
    if (samples?.length) { this.parts.push(samples); this.length += samples.length; }
    const out = [];
    while (this.length >= this.target * this.rate) {
      const all = this._take();
      const limit = Math.min(all.length, this.max * this.rate);
      const cut = quietestCut(all.subarray(0, limit), this.rate, this.search);
      out.push(this._emit(all, cut));
    }
    return out;
  }

  flush() {
    if (this.length < this.min * this.rate) { this.offset += this.length; this.parts = []; this.length = 0; return null; }
    const all = this._take();
    return this._emit(all, all.length);
  }

  _take() {
    const all = new Float32Array(this.length);
    let k = 0;
    for (const p of this.parts) { all.set(p, k); k += p.length; }
    return all;
  }

  _emit(all, cut) {
    const piece = { audio: all.slice(0, cut), offset: this.offset / this.rate, seconds: cut / this.rate };
    this.offset += cut;
    const rest = all.slice(cut);
    this.parts = rest.length ? [rest] : [];
    this.length = rest.length;
    return piece;
  }
}

/** Who was speaking between `start` and `end` (seconds in the recording):
 *  'You' (this device's microphone) or 'Others' (the call in the tab), from
 *  the loudness of each source; '' when only a microphone was recorded. */
export function attribute(frames, start, end, hasTab) {
  if (!hasTab) return '';
  let mic = 0;
  let tab = 0;
  for (const f of frames) {
    if (f.t + f.d < start || f.t > end) continue;
    mic += f.mic;
    tab += f.tab;
  }
  if (!mic && !tab) return '';
  return tab > mic * 1.2 ? 'Others' : 'You';
}

/** A short, sortable id for a piece of transcript. */
export const segmentId = (session, chunk, k) => `${session}-${chunk}-${k}`.slice(0, 64);
