// Meeting Notes, Phase 3 (Neil, 11/12/2026) - transcribing on the device:
// consent before anything starts, the words (never the audio) sent with the
// right times, the last seconds finished on Stop, the browser's speech
// service taking over when Whisper cannot load, the recorded transcript's
// voices named, and Transcribe on a voice note. The microphone and the
// Whisper worker are stand-ins here; the real engine was run in Chromium.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  meetingRecordedStart: vi.fn(), meetingRecordedSegments: vi.fn(), meetingRecordedEnd: vi.fn(),
  meetingRecorded: vi.fn(), meetingRecordedSpeakers: vi.fn(), meetingRecordedDelete: vi.fn(),
  meetingTranscript: vi.fn(), viewerBlob: vi.fn(), createTask: vi.fn(),
}));
vi.mock('../../api', () => ({ api: apiMock }));

const fake = vi.hoisted(() => ({ onAudio: null, opened: null, stopped: 0, engine: null, whisper: true }));
vi.mock('./capture/capture', () => ({
  canCapture: () => true,
  canShareTab: () => true,
  isPhoneLike: () => false,
  createCapture: () => ({
    open: async ({ onAudio, source }) => { fake.onAudio = onAudio; fake.opened = source; return { hasTab: source === 'mic+tab', rate: 48000 }; },
    stop: () => { fake.stopped += 1; },
  }),
  decodeToPcm: async () => new Float32Array(16000),
}));
vi.mock('./capture/engine', async (orig) => {
  const real = await orig();
  return { ...real, getEngine: () => fake.engine, whisperSupported: () => fake.whisper, pickModel: () => 'tiny' };
});
vi.mock('./capture/useTranscriber', async (orig) => ({ ...(await orig()), transcribeRecording: vi.fn(async () => ['Gate codes are 1234.', 'Lock the north gate.']) }));
const dialogMock = vi.hoisted(() => ({ prompt: vi.fn(), confirm: vi.fn() }));
vi.mock('../../ui/dialog', () => ({ dialog: dialogMock }));

import { useTranscriber } from './capture/useTranscriber';
import Recorder from './Recorder';
import { TranscriptView } from './MeetingBand';
import NoteEditor from '../NoteEditor';
import { setTranscribeOn } from './access';

const second = (level = 0.3) => Float32Array.from({ length: 16000 }, (_, i) => level * Math.sin(i / 3));
const feed = (seconds) => { for (let i = 0; i < seconds; i += 1) fake.onAudio(second(), { mic: 0.3, tab: 0.01, seconds: 1 }); };

function makeEngine({ fail = false } = {}) {
  let release;
  const e = {
    model: '',
    loading: null,
    load: vi.fn(() => {
      e.loading = fail ? Promise.reject(new Error('no signal')) : new Promise((res) => { release = () => { e.model = 'tiny'; res(); }; });
      return e.loading;
    }),
    transcribe: vi.fn(async (audio) => ({ text: 'x', ms: 500, chunks: [{ start: 0, end: 2, text: `I will send the gate codes by Friday. (${Math.round(audio.length / 16000)}s)` }] })),
    release: () => release?.(),
  };
  return e;
}

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset?.());
  apiMock.meetingRecordedStart.mockResolvedValue({ ok: true });
  apiMock.meetingRecordedSegments.mockResolvedValue({ added: 1 });
  apiMock.meetingRecordedEnd.mockResolvedValue({ ok: true });
  fake.onAudio = null; fake.opened = null; fake.stopped = 0; fake.whisper = true;
  fake.engine = makeEngine();
});
afterEach(() => { delete window.webkitSpeechRecognition; });

describe('a recording', () => {
  it('starts with the consent, listens while the model loads, sends words with their times, finishes on Stop', async () => {
    const { result } = renderHook(() => useTranscriber('note_1'));
    act(() => { result.current.start('mic+tab'); });
    await waitFor(() => expect(apiMock.meetingRecordedStart).toHaveBeenCalled());
    const [, session] = apiMock.meetingRecordedStart.mock.calls[0];
    expect(session).toMatchObject({ engine: 'whisper', source: 'mic+tab', consent: true });
    await waitFor(() => expect(fake.opened).toBe('mic+tab'));
    await waitFor(() => expect(result.current.state.phase).toBe('loading'));
    const t0 = Date.now() / 1000;
    act(() => feed(21));                                   // said while the model downloads: kept
    expect(fake.engine.transcribe).not.toHaveBeenCalled();
    await act(async () => { fake.engine.release(); });
    await waitFor(() => expect(result.current.state.phase).toBe('listening'));
    await waitFor(() => expect(result.current.live.length).toBe(1));
    const seg = result.current.live[0];
    expect(seg.text).toMatch(/^I will send the gate codes by Friday/);
    expect(seg.speaker).toBe('You');                       // the microphone was the loud one
    expect(seg.at).toBeGreaterThan(t0 - 5);
    expect(seg.at).toBeLessThan(t0 + 5);
    expect(seg.id.startsWith(session.id)).toBe(true);
    act(() => feed(2));
    await act(async () => { await result.current.stop(); });
    expect(fake.engine.transcribe).toHaveBeenCalledTimes(2); // the last seconds too
    expect(result.current.live.length).toBe(2);
    const sent = apiMock.meetingRecordedSegments.mock.calls.flatMap((c) => c[2]);
    expect(sent.map((s) => s.id)).toEqual(result.current.live.map((s) => s.id));
    expect(sent.every((s) => !('audio' in s))).toBe(true);  // words only
    expect(apiMock.meetingRecordedEnd).toHaveBeenCalledWith('note_1', session.id);
    expect(fake.stopped).toBeGreaterThan(0);
    expect(result.current.state.phase).toBe('idle');
  });

  it('a session the server refuses never listens', async () => {
    apiMock.meetingRecordedStart.mockRejectedValue(new Error('Confirm that everyone in the meeting agreed to be transcribed'));
    const { result } = renderHook(() => useTranscriber('note_1'));
    act(() => { result.current.start('mic'); });
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(result.current.state.error).toContain('agreed');
    expect(fake.opened).toBeNull();
  });

  it("when Whisper cannot load, the browser's speech service carries on with the microphone", async () => {
    fake.engine = makeEngine({ fail: true });
    const made = [];
    window.webkitSpeechRecognition = class { constructor() { made.push(this); } start() {} stop() {} };
    const { result } = renderHook(() => useTranscriber('note_1'));
    act(() => { result.current.start('mic'); });
    await waitFor(() => expect(result.current.state.engine).toBe('browser'));
    expect(result.current.state.phase).toBe('listening');
    expect(result.current.state.note).toContain("browser's speech service");
    expect(apiMock.meetingRecordedStart.mock.calls.map((c) => c[1].engine)).toEqual(['whisper', 'browser']);
    act(() => { made[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Hello there' }], { isFinal: true })] }); });
    expect(result.current.live.map((s) => s.text)).toEqual(['Hello there']);
  });

  it('a browser that cannot do either says so instead of starting', () => {
    fake.whisper = false;
    const { result } = renderHook(() => useTranscriber('note_1'));
    act(() => { result.current.start('mic+tab'); });
    expect(result.current.state.phase).toBe('error');
    expect(apiMock.meetingRecordedStart).not.toHaveBeenCalled();
  });
});

describe('Start Transcribing', () => {
  it('asks first and starts only once everyone agreed, with the call in the tab when picked', async () => {
    const onRecording = vi.fn();
    render(<Recorder noteId="note_1" onRecording={onRecording} />);
    fireEvent.click(screen.getByRole('button', { name: /Start Transcribing/ }));
    const go = screen.getAllByRole('button', { name: /Start Transcribing/ }).at(-1);
    expect(go.disabled).toBe(true);
    expect(screen.getByText(/never saved or sent anywhere/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/call in this browser/));
    fireEvent.click(screen.getByLabelText(/Everyone in this meeting has agreed/));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(apiMock.meetingRecordedStart).toHaveBeenCalledWith('note_1', expect.objectContaining({ source: 'mic+tab', consent: true })));
    expect(await screen.findByText(/Getting Ready/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Downloading the speech model' })).toBeTruthy();
    expect(onRecording).toHaveBeenCalledWith(true, expect.any(Number), expect.any(String));
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy();
  });
});

describe('the transcript recorded in Nexus', () => {
  it('shows the saved words with the live ones, and names a voice', async () => {
    apiMock.meetingRecorded.mockResolvedValue({
      cues: [{ id: 'a', at: 1794495600, speaker: 'Others', label: 'Others', text: 'Let us go with the Austin vendor.' }],
      sessions: [{ id: 's1', by: 'neil@greensglobal.com', startedAt: '2026-11-12T15:00:00Z', engine: 'whisper' }],
      speakers: {}, highlights: { actions: [], decisions: [], questions: [] }, mayRecord: true, mayDelete: true,
    });
    apiMock.meetingRecordedSpeakers.mockResolvedValue({
      cues: [{ id: 'a', at: 1794495600, speaker: 'Visesh', label: 'Others', text: 'Let us go with the Austin vendor.' }],
      sessions: [], speakers: { Others: 'Visesh' }, highlights: { actions: [], decisions: [], questions: [] }, mayRecord: true, mayDelete: true,
    });
    dialogMock.prompt.mockResolvedValue('Visesh');
    render(<TranscriptView noteId="note_1" sources={['recorded']} myEmail="neil@greensglobal.com" onClose={() => {}}
      liveCues={[{ id: 'b', at: 1794495700, speaker: 'You', text: 'I will send the codes.' }]} />);
    expect(await screen.findByText('Let us go with the Austin vendor.')).toBeTruthy();
    expect(screen.getByText('I will send the codes.')).toBeTruthy();
    expect(screen.getByText(/only the words are kept/)).toBeTruthy();
    expect(screen.getByText(/by you; everyone present agreed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Others' }));
    await waitFor(() => expect(apiMock.meetingRecordedSpeakers).toHaveBeenCalledWith('note_1', { Others: 'Visesh' }));
    expect(await screen.findByRole('button', { name: 'Visesh' })).toBeTruthy();
    expect(apiMock.meetingTranscript).not.toHaveBeenCalled();     // never the Teams one for this note
  });

  it('a meeting with both offers From Teams and Recorded in Nexus', async () => {
    apiMock.meetingRecorded.mockResolvedValue({ cues: [], sessions: [], speakers: {}, highlights: { actions: [], decisions: [], questions: [] }, mayRecord: true });
    apiMock.meetingTranscript.mockResolvedValue({ cues: [{ at: 1794495600, speaker: 'Neil', text: 'From Teams words.' }], recordings: 0, chatThreadId: '', highlights: { actions: [], decisions: [], questions: [] } });
    render(<TranscriptView noteId="note_1" sources={['teams', 'recorded']} onClose={() => {}} />);
    expect(await screen.findByText('From Teams words.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recorded in Nexus' }));
    expect(await screen.findByText('Nothing recorded yet')).toBeTruthy();
  });
});

describe('Transcribe on a voice note', () => {
  const SRC = 'https://store.supabase.co/storage/v1/object/public/task-files/notes/1-a.m4a';
  afterEach(() => setTranscribeOn(false));

  it('is offered to testers only, and puts the words under the clip as a Transcript', async () => {
    const onChange = vi.fn();
    const { unmount } = render(<NoteEditor value={`<audio src="${SRC}" controls preload="metadata"></audio>`} onChange={onChange} />);
    expect(screen.queryByRole('button', { name: /Transcribe/ })).toBeNull();
    unmount();
    setTranscribeOn(true);
    apiMock.viewerBlob.mockResolvedValue(new Blob(['x']));
    render(<NoteEditor value={`<audio src="${SRC}" controls preload="metadata"></audio><p>After</p>`} onChange={onChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /Transcribe/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(apiMock.viewerBlob).toHaveBeenCalledWith(SRC);
    const html = onChange.mock.calls.at(-1)[0];
    expect(html).toContain('data-summary="Transcript"');
    expect(html).toContain('Gate codes are 1234.');
    expect(html.indexOf('Transcript')).toBeGreaterThan(html.indexOf('<audio'));
    expect(html.indexOf('Transcript')).toBeLessThan(html.indexOf('After'));
  });
});
