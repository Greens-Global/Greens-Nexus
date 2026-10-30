// Voice in the shared editor (Neil, Oct 30 2026): Dictate types what is said
// into the description / comment where the cursor is, and a composer that
// stages files records a voice note into that same staging list.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import RichDescription from './RichDescription';
import { spokenAfter } from '../lib/voice';

const rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => rect;

afterEach(() => { cleanup(); delete window.webkitSpeechRecognition; });

describe('spokenAfter', () => {
  it('spaces after a word and capitalizes a new sentence', () => {
    expect(spokenAfter('', 'call the vendor')).toBe('Call the vendor');
    expect(spokenAfter('Call Bob.', 'then the vendor')).toBe(' Then the vendor');
    expect(spokenAfter('Call', 'Bob')).toBe(' Bob');
    expect(spokenAfter('Call ', 'bob')).toBe('bob');
  });
});

describe('RichDescription voice', () => {
  it('has no mic where the browser cannot dictate', () => {
    render(<RichDescription value="" onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: /Dictate/ })).toBeNull();
  });

  it('Dictate types the words after what is already there', async () => {
    let rec;
    window.webkitSpeechRecognition = function SR() { rec = this; this.start = vi.fn(); this.stop = vi.fn(() => this.onend?.()); this.abort = vi.fn(); };
    let html = '';
    render(<RichDescription value="<p>Leak by the door.</p>" onChange={(h) => { html = h; }} />);
    await act(async () => { fireEvent.mouseDown(screen.getByRole('button', { name: 'Dictate - type what you say' })); });
    expect(rec.start).toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/Listening/);
    await act(async () => { rec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'water on' } }] }); });
    expect(screen.getByRole('status').textContent).toContain('water on');
    await act(async () => { rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'water on the floor again' } }] }); });
    expect(html).toBe('<p>Leak by the door. Water on the floor again</p>');
    await act(async () => { fireEvent.mouseDown(screen.getByRole('button', { name: 'Stop Dictating' })); });
    expect(rec.stop).toHaveBeenCalled();
  });

  it('a comment composer stages a recorded voice note with its files', async () => {
    const realMd = navigator.mediaDevices; const realMR = window.MediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) }, configurable: true });
    window.MediaRecorder = function MR() { this.mimeType = 'audio/mp4'; this.start = vi.fn(); this.stop = vi.fn(() => { this.ondataavailable({ data: new Blob(['x']) }); this.onstop(); }); };
    window.MediaRecorder.isTypeSupported = (m) => m === 'audio/mp4';
    try {
      const onStageFiles = vi.fn();
      render(<RichDescription value="" onChange={() => {}} onStageFiles={onStageFiles} />);
      await act(async () => { fireEvent.mouseDown(screen.getByRole('button', { name: 'Record a Voice Note' })); });
      expect(screen.getByText(/Recording a Voice Note 0:00/)).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Stop$/ })); });
      expect(onStageFiles).toHaveBeenCalledTimes(1);
      const [[files]] = onStageFiles.mock.calls;
      expect(files[0].name).toMatch(/^voice-note-\d+\.m4a$/);
      expect(files[0].type).toBe('audio/mp4');
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { value: realMd, configurable: true });
      window.MediaRecorder = realMR;
    }
  });

  it('no voice note button on a description (nothing to stage it into)', () => {
    render(<RichDescription value="" onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Record a Voice Note' })).toBeNull();
  });
});
