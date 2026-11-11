// Photos in notes, small previews, the viewer and Start With (Neil,
// 11/10/2026): a photo is a tile, a tap opens it full size, an empty note
// offers what it can be, and a shared document never carries a picture from
// anywhere but our storage.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';

const storeTaskFile = vi.hoisted(() => vi.fn());
vi.mock('../tasks/lib', () => ({ storeTaskFile }));

import NoteEditor from './NoteEditor';
import { noteMediaKind, checkNoteMedia, PHOTO_MAX } from './noteMedia';
import { safeHtml } from './noteSafeHtml';
import { VIEW_PREFIX } from '../lib/storageView';

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
  storeTaskFile.mockReset();
});

const file = (name, type, size) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('what a note can hold', () => {
  it('knows a photo, even one with no type, and keeps clips as before', () => {
    expect(noteMediaKind(file('a.jpg', 'image/jpeg', 1))).toBe('image');
    expect(noteMediaKind(file('IMG_0042.HEIC', '', 1))).toBe('image');
    expect(noteMediaKind(file('clip.mov', '', 1))).toBe('video');
    expect(noteMediaKind(file('x.pdf', 'application/pdf', 1))).toBe('');
  });
  it('names the size and the limit for a photo that is too big', () => {
    expect(checkNoteMedia(file('big.jpg', 'image/jpeg', PHOTO_MAX + 5 * 1024 * 1024))).toBe('That picture is 30 MB. The limit is 25 MB.');
    expect(checkNoteMedia(file('vector.svg', 'image/svg+xml', 100))).toContain('cannot be added');
    expect(checkNoteMedia(file('ok.png', 'image/png', 1000))).toBe('');
  });
});

describe('photos and videos are small tiles', () => {
  const body = `<p>Site walk</p><img src="${SRC}.jpg" alt="North wall"><video src="${SRC}.mp4" controls playsinline preload="metadata"></video>`;

  it('shows each as a tile, and a tap opens the viewer that steps through them', async () => {
    const onChange = vi.fn();
    render(<NoteEditor value={body} onChange={onChange} />);
    const photo = await screen.findByRole('button', { name: 'Open Photo' });
    expect(photo.querySelector('img').getAttribute('src')).toBe(`${SRC}.jpg`);
    expect(screen.getByRole('button', { name: 'Open Video' })).toBeTruthy();
    await act(async () => { fireEvent.click(photo); });
    const viewer = screen.getByRole('dialog', { name: 'Photo' });
    expect(viewer.textContent).toContain('1 of 2');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next' })); });
    expect(screen.getByRole('dialog', { name: 'Video' }).textContent).toContain('2 of 2');
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Remove in the viewer takes the photo out of the note', async () => {
    const onChange = vi.fn();
    render(<NoteEditor value={body} onChange={onChange} />);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Open Photo' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })); });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)[0]).not.toContain(`${SRC}.jpg`);
    expect(onChange.mock.calls.at(-1)[0]).toContain(`${SRC}.mp4`);
  });

  it('read only: the viewer opens, nothing can be removed', async () => {
    render(<NoteEditor value={body} readOnly onChange={() => {}} />);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Open Photo' })); });
    expect(screen.getByRole('dialog', { name: 'Photo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Photo' })).toBeNull();
  });

  it('a picked photo is saved under notes and lands in the note', async () => {
    storeTaskFile.mockResolvedValue(`${SRC}.jpg`);
    const onChange = vi.fn();
    const { container } = render(<NoteEditor value="<p>Gate 3</p>" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Add a Photo - or paste one with Ctrl+V' })).toBeTruthy();
    const input = container.querySelector('input[type="file"][accept="image/*"]');
    await act(async () => { fireEvent.change(input, { target: { files: [file('gate.jpg', 'image/jpeg', 2048)] } }); });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(storeTaskFile.mock.calls[0][2]).toBe('notes');
    expect(storeTaskFile.mock.calls[0][3]).toBe(PHOTO_MAX);
    expect(onChange.mock.calls.at(-1)[0]).toContain(`<img src="${SRC}.jpg"`);
  });

  it('a phone takes a photo or a video from one camera button', async () => {
    phone();
    const { container } = render(<NoteEditor value="<p>x</p>" onChange={() => {}} />);
    await act(async () => { fireEvent.focus(container.querySelector('.ProseMirror')); });
    expect(await screen.findByRole('button', { name: 'Photo or Video - take one or pick from the library' })).toBeTruthy();
    const input = container.querySelector('input[type="file"][accept="image/*,video/*"]');
    expect(input).toBeTruthy();
    expect(input.hasAttribute('capture')).toBe(false);   // the phone asks Take Photo / Library / Files
  });

  it('a shared document keeps only pictures from our own storage', () => {
    const ours = `${VIEW_PREFIX}${encodeURIComponent(`${SRC}.jpg`)}`;
    const out = safeHtml(`<p>a</p><img src="https://evil.example/x.png"><img src="data:image/png;base64,AAAA"><img src="${ours}">`);
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('data:');
    expect(out).toContain('<img');
  });
});

describe('Start with', () => {
  it('an empty note offers what it can be; a checklist starts one', async () => {
    const onChange = vi.fn();
    render(<NoteEditor value="" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Start this note as' });
    const names = [...group.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual(['Text', 'Checklist', 'Bulleted List', 'Numbered List', 'Table', 'Photo', 'Templates']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start with Checklist' })); });
    expect(onChange.mock.calls.at(-1)[0]).toContain('data-type="taskList"');
  });

  it('Table starts a three by three table with a header row', async () => {
    const onChange = vi.fn();
    render(<NoteEditor value="" onChange={onChange} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start with Table' })); });
    const html = onChange.mock.calls.at(-1)[0];
    expect((html.match(/<th/g) || []).length).toBe(3);
    expect((html.match(/<tr/g) || []).length).toBe(3);
  });

  it('is gone once the note has words, read only, or turned off', () => {
    render(<NoteEditor value="<p>Milk</p>" onChange={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Start this note as' })).toBeNull();
    cleanup();
    render(<NoteEditor value="" readOnly onChange={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Start this note as' })).toBeNull();
    cleanup();
    render(<NoteEditor value="" starters={false} onChange={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Start this note as' })).toBeNull();
  });

  it('a phone shows the short names', () => {
    phone();
    render(<NoteEditor value="" onChange={() => {}} />);
    const names = [...screen.getByRole('group', { name: 'Start this note as' }).querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toContain('Bullets');
    expect(names).toContain('Numbered');
  });
});
