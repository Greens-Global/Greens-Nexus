// Meeting Notes, Phase 3 - the parts of on-device transcription that can be
// checked without a microphone: 16 kHz audio, cutting at a pause, who spoke,
// the worker protocol, the model choice and the fallback's restarts. The
// engine itself runs in a real browser in e2e (see the PR for the harness run).
import { describe, it, expect, vi } from 'vitest';
import { downsample, rms, quietestCut, Chunker, attribute, RATE } from './audio';
import { WhisperEngine, BrowserSpeech, pickModel, MODELS } from './engine';

const tone = (seconds, level = 0.5, rate = RATE) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => level * Math.sin(i / 3));

describe('audio', () => {
  it('brings 48 kHz down to 16 kHz', () => {
    const out = downsample(new Float32Array(48000).fill(0.25), 48000);
    expect(out.length).toBe(16000);
    expect(out[100]).toBeCloseTo(0.25);
    expect(downsample(new Float32Array(0), 48000).length).toBe(0);
  });

  it('measures loudness', () => {
    expect(rms(new Float32Array([0, 0]))).toBe(0);
    expect(rms(new Float32Array([1, -1]))).toBe(1);
  });

  it('cuts in the quietest stretch near the end, never mid-word', () => {
    const a = new Float32Array([...tone(5), ...new Float32Array(Math.round(0.5 * RATE)), ...tone(1.5)]);
    const cut = quietestCut(a, RATE, 4);
    expect(cut / RATE).toBeGreaterThan(5);
    expect(cut / RATE).toBeLessThan(5.5);
  });

  it('hands back pieces of about 20 seconds with where each starts, then the rest', () => {
    const c = new Chunker({ target: 20, max: 28 });
    let pieces = [];
    for (let i = 0; i < 45; i += 1) pieces = pieces.concat(c.push(tone(1)));
    expect(pieces.length).toBe(2);
    expect(pieces[0].offset).toBe(0);
    expect(pieces[1].offset).toBeCloseTo(pieces[0].seconds, 5);
    expect(pieces[0].seconds).toBeGreaterThan(15);
    expect(pieces[0].seconds).toBeLessThanOrEqual(28);
    const rest = c.flush();
    expect(rest.offset).toBeCloseTo(pieces[0].seconds + pieces[1].seconds, 5);
    expect(pieces[0].seconds + pieces[1].seconds + rest.seconds).toBeCloseTo(45, 3);
    expect(c.flush()).toBeNull();
  });

  it('a tail too short to say anything is dropped', () => {
    const c = new Chunker();
    c.push(tone(0.2));
    expect(c.flush()).toBeNull();
  });

  it('says who spoke from which source was louder', () => {
    const frames = [{ t: 0, d: 1, mic: 0.4, tab: 0.01 }, { t: 1, d: 1, mic: 0.01, tab: 0.5 }, { t: 2, d: 1, mic: 0.02, tab: 0.6 }];
    expect(attribute(frames, 0, 0.9, true)).toBe('You');
    expect(attribute(frames, 1.2, 2.8, true)).toBe('Others');
    expect(attribute(frames, 0, 3, false)).toBe('');
    expect(attribute(frames, 10, 12, true)).toBe('');
  });
});

describe('engine', () => {
  it('picks the small model on a phone or a small machine', () => {
    expect(pickModel({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe('base');
    expect(pickModel({ hardwareConcurrency: 8, deviceMemory: 8 }, true)).toBe('tiny');
    expect(pickModel({ hardwareConcurrency: 4 })).toBe('tiny');
    expect(pickModel({ hardwareConcurrency: 12, deviceMemory: 4 })).toBe('tiny');
    expect(MODELS.base.id).toBe('Xenova/whisper-base.en');
  });

  it('loads a model through the worker with progress, then transcribes', async () => {
    const sent = [];
    const worker = { postMessage: (m) => sent.push(m), terminate: vi.fn() };
    const e = new WhisperEngine(() => worker, 'https://nexus.example');
    const progress = vi.fn();
    const loading = e.load('tiny', progress);
    expect(sent[0]).toEqual({ type: 'load', base: 'https://nexus.example', model: 'Xenova/whisper-tiny.en', revision: 'main', multilingual: false });
    worker.onmessage({ data: { type: 'progress', file: 'a', loaded: 10, total: 100 } });
    worker.onmessage({ data: { type: 'progress', file: 'b', loaded: 5, total: 50 } });
    expect(progress).toHaveBeenLastCalledWith({ loaded: 15, total: 41e6 });
    worker.onmessage({ data: { type: 'ready' } });
    await loading;
    expect(e.model).toBe('tiny');
    await e.load('tiny');                      // already loaded: nothing sent
    expect(sent.length).toBe(1);
    const p = e.transcribe(new Float32Array(16000));
    worker.onmessage({ data: { type: 'result', id: sent[1].id, text: 'Hello', chunks: [{ start: 0, end: 1, text: 'Hello' }], ms: 200 } });
    expect((await p).text).toBe('Hello');
  });

  it('a load error rejects the load, a transcribe error rejects that one', async () => {
    const sent = [];
    const worker = { postMessage: (m) => sent.push(m), terminate: vi.fn() };
    const e = new WhisperEngine(() => worker, '');
    const loading = e.load('base');
    worker.onmessage({ data: { type: 'error', message: 'no signal' } });
    await expect(loading).rejects.toThrow('no signal');
    const p = e.transcribe(new Float32Array(10));
    worker.onmessage({ data: { type: 'error', id: sent[1].id, message: 'bad audio' } });
    await expect(p).rejects.toThrow('bad audio');
  });

  it('the browser speech fallback starts again after its own pauses, until stopped', async () => {
    vi.useFakeTimers();
    const made = [];
    class Rec { constructor() { made.push(this); } start() {} stop() { this.onend?.(); } }
    const phrases = [];
    const s = new BrowserSpeech(Rec);
    s.start({ onPhrase: (p) => phrases.push(p.text) });
    made[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: ' gate codes ' }], { isFinal: true })] });
    expect(phrases).toEqual(['gate codes']);
    made[0].onend();
    vi.advanceTimersByTime(300);
    expect(made.length).toBe(2);
    s.stop();
    vi.advanceTimersByTime(1000);
    expect(made.length).toBe(2);
    vi.useRealTimers();
  });
});
