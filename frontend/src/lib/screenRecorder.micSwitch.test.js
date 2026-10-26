import { describe, it, expect, vi, beforeEach } from 'vitest';

// Build Mode's switchable mic (Oct 27 2026): a recorder's tracks are fixed
// once it starts, so a micSwitch recording carries one Web Audio track from
// the start - silent until the mic is plugged into it - and the mic can be
// switched on and off while it records.

const track = (kind) => ({ kind, stop: vi.fn(), addEventListener: vi.fn() });
let source, ctx, micTrack, display;

beforeEach(() => {
  vi.resetModules();
  micTrack = track('audio');
  source = { connect: vi.fn(), disconnect: vi.fn() };
  const destTrack = track('audio');
  ctx = {
    state: 'running', resume: vi.fn(() => Promise.resolve()), close: vi.fn(),
    createMediaStreamDestination: vi.fn(() => ({ stream: { getAudioTracks: () => [destTrack] } })),
    createMediaStreamSource: vi.fn(() => source),
    createOscillator: vi.fn(), createGain: vi.fn(),
  };
  window.AudioContext = vi.fn(function AudioContext() { return ctx; });
  const video = track('video');
  const tracks = [video];
  display = { addTrack: vi.fn((t) => tracks.push(t)), getVideoTracks: () => [video], getTracks: () => tracks };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn(() => Promise.resolve(display)),
      getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [micTrack], getAudioTracks: () => [micTrack] })),
    },
  });
  window.MediaRecorder = class { constructor() { this.state = 'inactive'; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.onstop?.(); } };
  window.MediaRecorder.isTypeSupported = () => true;
});

describe('screenRecorder micSwitch', () => {
  it('starts with a silent audio track, and the mic switches on and off mid-recording', async () => {
    const rec = await import('./screenRecorder');
    await rec.startScreenRecording({ voice: false, micSwitch: true, quiet: true }, vi.fn());
    expect(display.addTrack).toHaveBeenCalledTimes(1);           // the destination's track, from the start
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(rec.recordingMicOn()).toBe(false);

    expect(await rec.setRecordingMic(true)).toBe(true);
    expect(source.connect).toHaveBeenCalled();
    expect(rec.recordingMicOn()).toBe(true);

    expect(await rec.setRecordingMic(false)).toBe(false);
    expect(source.disconnect).toHaveBeenCalled();
    expect(micTrack.stop).toHaveBeenCalled();
    expect(rec.recordingMicOn()).toBe(false);

    rec.stopScreenRecording();
    expect(ctx.close).toHaveBeenCalled();
    expect(await rec.setRecordingMic(true)).toBe(false);          // nothing recording
  });

  it('With Audio starts with the mic on; a denied mic records without sound', async () => {
    const rec = await import('./screenRecorder');
    await rec.startScreenRecording({ voice: true, micSwitch: true, quiet: true }, vi.fn());
    expect(rec.recordingMicOn()).toBe(true);
    rec.stopScreenRecording();

    navigator.mediaDevices.getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })));
    await rec.startScreenRecording({ voice: true, micSwitch: true, quiet: true }, vi.fn());
    expect(rec.recordingMicOn()).toBe(false);
    rec.stopScreenRecording();
  });
});
