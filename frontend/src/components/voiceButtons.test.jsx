// The shared voice buttons (Neil, Oct 30 2026): the mic types at the cursor
// of a plain React box so its onChange sees it, a voice note hands back a
// File, and neither shows where the browser cannot do it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import DictateButton from './DictateButton';
import { insertAtCursor } from '../lib/voice';
import VoiceNoteButton from './VoiceNoteButton';

afterEach(() => { cleanup(); delete window.webkitSpeechRecognition; });

function Box({ initial = '' }) {
  const [v, setV] = useState(initial);
  const ref = useRef(null);
  return (<><textarea ref={ref} aria-label="Box" value={v} onChange={(e) => setV(e.target.value)} /><DictateButton target={ref} /><p>{v}</p></>);
}

describe('insertAtCursor', () => {
  it('spaces and capitalizes like a sentence', () => {
    const el = document.createElement('textarea');
    el.value = 'Call Bob.'; el.setSelectionRange(9, 9);
    insertAtCursor(el, 'then the vendor');
    expect(el.value).toBe('Call Bob. Then the vendor');
    el.value = 'Call  today'; el.setSelectionRange(5, 5);
    insertAtCursor(el, 'Bob');
    expect(el.value).toBe('Call Bob today');
  });
});

describe('DictateButton', () => {
  it('is not there when the browser cannot dictate', () => {
    render(<Box />);
    expect(screen.queryByRole('button', { name: /Dictate/ })).toBeNull();
  });

  it('types what is said into a React box through its onChange', async () => {
    let rec;
    window.webkitSpeechRecognition = function SR() { rec = this; this.start = vi.fn(); this.stop = vi.fn(() => this.onend?.()); this.abort = vi.fn(); };
    render(<Box initial="Note:" />);
    const box = screen.getByLabelText('Box');
    box.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole('button', { name: /Dictate/ }));
    expect(rec.start).toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Listening…');
    await act(async () => { rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'gate code is 4411' } }] }); });
    expect(screen.getByText('Note: gate code is 4411', { selector: 'p' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Dictating' }));
    expect(rec.stop).toHaveBeenCalled();
  });
});

describe('VoiceNoteButton', () => {
  it('records and hands back the clip as a File', async () => {
    const realMd = navigator.mediaDevices; const realMR = window.MediaRecorder;
    let mr;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop() {} }] })) }, configurable: true });
    window.MediaRecorder = function MR() { mr = this; this.mimeType = 'audio/mp4'; this.start = vi.fn(); this.stop = vi.fn(() => { this.ondataavailable({ data: new Blob(['x']) }); this.onstop(); }); };
    window.MediaRecorder.isTypeSupported = (m) => m === 'audio/mp4';
    try {
      const onFile = vi.fn();
      render(<VoiceNoteButton onFile={onFile} />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Record a Voice Note' })); });
      expect(screen.getByText(/Recording 0:00/)).toBeTruthy();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Stop/ })); });
      expect(mr.stop).toHaveBeenCalled();
      expect(onFile.mock.calls[0][0].name).toMatch(/^voice-note-\d+\.m4a$/);
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { value: realMd, configurable: true });
      window.MediaRecorder = realMR;
    }
  });
});
