import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import RichDescription from './RichDescription';
import { sameDoc } from './lib';

// Picking several pictures at once kept only ONE: each was inserted over the
// current selection, and the image inserted just before it was that selection -
// so every new picture replaced the previous one. All of them must land, in
// the order they were picked.

const png = (name) => new File([new Uint8Array([137, 80, 78, 71, name.length])], name, { type: 'image/png' });

describe('RichDescription multi-image insert', () => {
  it('keeps every picked image, in order', async () => {
    let html = '';
    const { container } = render(<RichDescription value="" onChange={(h) => { html = h; }} />);
    const input = container.querySelector('input[type="file"][accept="image/*"]');
    expect(input.multiple).toBe(true);
    fireEvent.change(input, { target: { files: [png('one.png'), png('two.png'), png('three.png')] } });
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror img').length).toBe(3));
    expect((html.match(/<img/g) || []).length).toBe(3);
  });

  it('shows a saved inline (data:) image again when the description is reopened', () => {
    // Pasted images with no task to upload to are stored as data: URLs; the
    // image extension skipped those on load, so they vanished after saving.
    const saved = '<p>Before</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="><p>After</p>';
    const { container } = render(<RichDescription value={saved} onChange={() => {}} />);
    expect(container.querySelectorAll('.ProseMirror img').length).toBe(1);
  });
});

// Leaving the box with nothing changed is not a commit (11/17/2026): clicking
// into and out of an EMPTY description handed back '<p></p>' for '', which
// saved the task and told its people the description had changed.
describe('RichDescription commits on blur only what changed', () => {
  const editorOf = (container) => container.querySelector('.ProseMirror').editor;
  // Click in, click out: the DOM events the editor listens for.
  const leave = (ed) => act(() => { fireEvent.focus(ed.view.dom); fireEvent.blur(ed.view.dom); });

  it('an untouched empty description commits nothing', () => {
    const onCommit = vi.fn();
    const { container } = render(<RichDescription value="" onChange={() => {}} onCommit={onCommit} />);
    leave(editorOf(container));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('an untouched description commits nothing, however it was stored', () => {
    const onCommit = vi.fn();
    // Stored as plain words: the editor reads it as a paragraph.
    const { container } = render(<RichDescription value="Call the vendor" onChange={() => {}} onCommit={onCommit} />);
    leave(editorOf(container));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('a changed description commits once, and not again until it changes again', () => {
    const onCommit = vi.fn();
    const { container } = render(<RichDescription value="" onChange={() => {}} onCommit={onCommit} />);
    const ed = editorOf(container);
    act(() => { ed.commands.insertContent('Leak by the door'); });
    leave(ed);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('<p>Leak by the door</p>');
    leave(ed);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("sameDoc: '' and an empty paragraph are the same; a picture with no words is not empty", () => {
    expect(sameDoc('', '<p></p>')).toBe(true);
    expect(sameDoc(undefined, '')).toBe(true);
    expect(sameDoc('<p>a</p>', '<p>a</p>')).toBe(true);
    expect(sameDoc('<p>a</p>', '<p>b</p>')).toBe(false);
    expect(sameDoc('', '<img src="x.png">')).toBe(false);
  });
});
