// Meeting Notes, Phase 3 (Neil, 11/12/2026): the live audio.
//
// The microphone, and - on a computer, for a Zoom / Google Meet / Teams call
// running in a browser tab - that tab's sound, shared through the browser's
// own picker. The two go into one ScriptProcessor on separate channels, so
// each moment's loudness says who was talking (audio.attribute), then mixed,
// brought down to 16 kHz mono and handed on. Nothing is recorded to a file
// and nothing leaves the device: the samples go straight to the speech
// engine in this tab.
//
// iPhone: the AudioContext has to be made and resumed inside the tap that
// starts it, so createCapture() is synchronous and is called first thing in
// the click handler; open() does the asking for permission after.
import { downsample, rms } from './audio';

const BUFFER = 4096;

export const isPhoneLike = () => typeof window !== 'undefined'
  && (window.matchMedia?.('(pointer: coarse)')?.matches || /iPhone|iPad|Android/i.test(navigator.userAgent || ''));

export const canCapture = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  && !!(window.AudioContext || window.webkitAudioContext);

/** A call in a browser tab can be shared on a computer (Chrome, Edge), not on a phone. */
export const canShareTab = () => canCapture() && !!navigator.mediaDevices?.getDisplayMedia && !isPhoneLike();

export function createCapture() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  ctx.resume?.();      // inside the tap, or iPhone keeps it suspended
  const streams = [];
  let proc = null;
  let silent = null;
  let stopped = false;

  async function open({ source = 'mic', onAudio, onTabEnded }) {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    streams.push(mic);
    let tab = null;
    if (source === 'mic+tab') {
      try {
        tab = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch (e) {
        mic.getTracks().forEach((t) => t.stop());
        throw Object.assign(new Error('The call was not shared - pick the tab with your meeting and turn on its audio.'), { cause: e });
      }
      streams.push(tab);
      tab.getVideoTracks().forEach((t) => t.stop());        // the sound only
      if (!tab.getAudioTracks().length) {
        streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
        throw new Error('That share has no sound - share the browser tab with your meeting and turn on "Share tab audio".');
      }
      tab.getAudioTracks()[0].addEventListener('ended', () => onTabEnded?.());
    }
    if (stopped) { streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); return; }
    const merger = ctx.createChannelMerger(2);
    ctx.createMediaStreamSource(mic).connect(merger, 0, 0);
    if (tab) ctx.createMediaStreamSource(new MediaStream(tab.getAudioTracks())).connect(merger, 0, 1);
    proc = ctx.createScriptProcessor(BUFFER, 2, 1);
    proc.onaudioprocess = (e) => {
      if (stopped) return;
      const a = e.inputBuffer.getChannelData(0);
      const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : null;
      const mixed = new Float32Array(a.length);
      for (let i = 0; i < a.length; i += 1) mixed[i] = Math.max(-1, Math.min(1, a[i] + (b ? b[i] : 0)));
      onAudio(downsample(mixed, ctx.sampleRate), { mic: rms(a), tab: b ? rms(b) : 0, seconds: a.length / ctx.sampleRate });
    };
    // A processor only runs when it reaches the speakers - through silence, so nothing echoes.
    silent = ctx.createGain();
    silent.gain.value = 0;
    merger.connect(proc);
    proc.connect(silent);
    silent.connect(ctx.destination);
    await ctx.resume?.();
    return { hasTab: !!tab, rate: ctx.sampleRate };
  }

  function stop() {
    stopped = true;
    try { proc?.disconnect(); silent?.disconnect(); } catch { /* already gone */ }
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    ctx.close?.().catch?.(() => {});
  }

  return { ctx, open, stop };
}

/** A recorded file (a voice note) as 16 kHz mono samples - decoded on the device. */
export async function decodeToPcm(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c += 1) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < ch.length; i += 1) mono[i] += ch[i] / decoded.numberOfChannels;
    }
    return downsample(mono, decoded.sampleRate);
  } finally {
    ctx.close?.().catch?.(() => {});
  }
}
