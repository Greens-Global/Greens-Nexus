// Voice notes, videos, dictation and the phone formatting bar in Notes
// (Neil, Oct 29 2026). The limits and their messages, a stored player
// rendering back, a video saved from the picker, dictated words landing at
// the cursor, and the phone bar with lists first.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';

const storeTaskFile = vi.hoisted(() => vi.fn());
vi.mock('../tasks/lib', () => ({ storeTaskFile }));

import NoteEditor from './NoteEditor';
import { mediaKind, checkMedia, MEDIA_MAX, withType, useVoiceRecorder } from './noteMedia';
import { hasContent } from './QuickNotePanel';
import { renderHook } from '@testing-library/react';

// jsdom has no layout: ProseMirror measures the caret when a toolbar button focuses the editor.
const rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => rect;

const SRC = 'https://store.supabase.co/storage/v1/object/public/task-files/notes/1-a';
const realMatch = window.matchMedia;
const phone = () => {
  window.matchMedia = (q) => ({ matches: q === '(max-width: 768px)', media: q, addEventListener() {}, removeEventListener() {} });
};

afterEach(() => {
  cleanup();
  window.matchMedia = realMatch;
  delete window.webkitSpeechRecognition;
  storeTaskFile.mockReset();
});

const file = (name, type, size) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('note media limits', () => {
  it('knows a voice note from a video, even a .mov with no type', () => {
    expect(mediaKind(file('a.webm', 'audio/webm', 1))).toBe('audio');
    expect(mediaKind(file('clip.mov', '', 1))).toBe('video');
    expect(mediaKind(file('x.pdf', 'application/pdf', 1))).toBe('');
  });
  it('names the real size and the limit', () => {
    expect(checkMedia(file('big.mp4', 'video/mp4', MEDIA_MAX.video + 5 * 1024 * 1024))).toBe('That video is 55 MB. The limit is 50 MB - record a shorter clip and try again.');
    expect(checkMedia(file('x.pdf', 'application/pdf', 10))).toBe('Only voice notes and videos can be added here.');
    expect(checkMedia(file('ok.m4a', 'audio/mp4', 1000))).toBe('');
  });
});

describe('NoteEditor media', () => {
  it('shows a stored voice note and video as players, with Remove only while editing', async () => {
    const body = `<p>Hi</p><audio src="${SRC}.webm" controls preload="metadata"></audio><video src="${SRC}.mp4" controls playsinline preload="metadata"></video>`;
    const { container, unmount } = render(<NoteEditor value={body} onChange={() => {}} />);
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy());   // node views mount a tick later
    expect(container.querySelector('audio').getAttribute('src')).toBe(`${SRC}.webm`);
    expect(container.querySelector('video').getAttribute('src')).toBe(`${SRC}.mp4`);
    expect(screen.getByRole('button', { name: 'Remove Voice Note' })).toBeTruthy();
    unmount();
    const ro = render(<NoteEditor value={body} readOnly onChange={() => {}} />);
    await waitFor(() => expect(ro.container.querySelector('video')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Remove Video' })).toBeNull();
  });

  it('saves a picked video and puts its player in the note', async () => {
    storeTaskFile.mockResolvedValue(`${SRC}.mp4`);
    const onChange = vi.fn();
    const { container } = render(<NoteEditor value="<p>Site walk</p>" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Add a Video' })).toBeTruthy();
    const input = container.querySelector('input[type="file"][accept="video/*"]');
    await act(async () => { fireEvent.change(input, { target: { files: [file('walk.mp4', 'video/mp4', 2048)] } }); });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(storeTaskFile.mock.calls[0][2]).toBe('notes');
    expect(storeTaskFile.mock.calls[0][3]).toBe(MEDIA_MAX.video);
    expect(onChange.mock.calls.at(-1)[0]).toContain(`<video src="${SRC}.mp4"`);
  });

  it('a video over the limit is refused with the reason, nothing uploaded', async () => {
    const { container } = render(<NoteEditor value="<p>x</p>" onChange={() => {}} />);
    const input = container.querySelector('input[type="file"][accept="video/*"]');
    await act(async () => { fireEvent.change(input, { target: { files: [file('huge.mov', 'video/quicktime', 80 * 1024 * 1024)] } }); });
    expect(screen.getByRole('alert').textContent).toContain('That video is 80 MB. The limit is 50 MB');
    expect(storeTaskFile).not.toHaveBeenCalled();
  });

  it('Dictate types what you say at the cursor', async () => {
    let rec;
    window.webkitSpeechRecognition = function SR() { rec = this; this.start = vi.fn(); this.stop = vi.fn(() => this.onend?.()); this.abort = vi.fn(); };
    const onChange = vi.fn();
    render(<NoteEditor value="<p>Call</p>" onChange={onChange} />);
    await act(async () => { fireEvent.mouseDown(screen.getByRole('button', { name: 'Dictate - type what you say' })); });
    expect(rec.start).toHaveBeenCalled();
    expect(rec.continuous).toBe(true);
    await act(async () => { rec.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'the vend' } }] }); });
    expect(screen.getByRole('status').textContent).toContain('the vend');
    await act(async () => { rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'the vendor tomorrow' } }] }); });
    expect(onChange.mock.calls.at(-1)[0]).toContain('the vendor tomorrow');
  });
});

describe('review fixes', () => {
  it('an iPhone .mov with no type uploads as a video', () => {
    expect(withType(file('IMG_1.MOV', '', 10)).type).toBe('video/quicktime');
    expect(withType(file('a.mp4', 'video/mp4', 10)).type).toBe('video/mp4');
  });

  it('a scratchpad that is only a voice note is still worth making', () => {
    expect(hasContent(`<audio src="${SRC}.m4a" controls></audio>`)).toBe(true);
    expect(hasContent('<p></p>')).toBe(false);
  });

  it('removing a player saves, even as the first change', async () => {
    const onChange = vi.fn();
    const { container } = render(<NoteEditor value={`<p>Hi</p><audio src="${SRC}.m4a" controls preload="metadata"></audio>`} onChange={onChange} />);
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Voice Note' })); });
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)[0]).not.toContain('<audio');
  });

  it('a second clip during an upload waits its turn instead of vanishing', async () => {
    let finish;
    storeTaskFile.mockImplementationOnce(() => new Promise((r) => { finish = r; })).mockResolvedValueOnce(`${SRC}-2.mp4`);
    const onChange = vi.fn();
    const { container } = render(<NoteEditor value="<p>x</p>" onChange={onChange} />);
    const input = container.querySelector('input[type="file"][accept="video/*"]');
    await act(async () => { fireEvent.change(input, { target: { files: [file('one.mp4', 'video/mp4', 10)] } }); });
    await act(async () => { fireEvent.change(input, { target: { files: [file('two.mp4', 'video/mp4', 10)] } }); });
    expect(screen.getByRole('status').textContent).toContain('1 more waiting');
    await act(async () => { finish(`${SRC}-1.mp4`); });
    await waitFor(() => expect(storeTaskFile).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onChange.mock.calls.at(-1)[0]).toContain(`${SRC}-2.mp4`));
    expect(onChange.mock.calls.at(-1)[0]).toContain(`${SRC}-1.mp4`);
  });

  it('a double tap on Record opens the microphone once, and a closed note frees it', async () => {
    let grant;
    const stopTrack = vi.fn();
    const gum = vi.fn(() => new Promise((r) => { grant = r; }));
    const realMd = navigator.mediaDevices;
    const realMR = window.MediaRecorder;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: gum }, configurable: true });
    window.MediaRecorder = function MR() { this.start = vi.fn(); this.stop = vi.fn(); };
    window.MediaRecorder.isTypeSupported = () => false;
    try {
      const { result, unmount } = renderHook(() => useVoiceRecorder(() => {}));
      act(() => { result.current.start(); result.current.start(); });
      expect(gum).toHaveBeenCalledTimes(1);
      unmount();
      await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }); });
      expect(stopTrack).toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { value: realMd, configurable: true });
      window.MediaRecorder = realMR;
    }
  });
});

describe('NoteEditor on a phone', () => {
  it('drops the desktop toolbar and shows the keyboard bar with lists first while you write', async () => {
    phone();
    const onChange = vi.fn();
    const { container } = render(<NoteEditor value="<p>Milk</p>" onChange={onChange} />);
    expect(screen.queryByRole('toolbar', { name: 'Formatting' })).toBeNull();
    await act(async () => { fireEvent.focus(container.querySelector('.ProseMirror')); });
    const bar = await screen.findByRole('toolbar', { name: 'Formatting' });
    expect(bar.classList.contains('nt-pb')).toBe(true);
    const labels = [...bar.querySelectorAll('.nt-pb-main button')].map((b) => b.getAttribute('aria-label'));
    expect(labels.slice(0, 5)).toEqual(['Checklist', 'Bulleted List', 'Numbered List', 'Outdent', 'Indent']);
    expect(labels).toContain('Add a Video');
    expect(labels).toContain('More Formatting');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Bulleted List' })); });
    expect(onChange.mock.calls.at(-1)[0]).toContain('<ul>');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'More Formatting' })); });
    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy();
  });
});
