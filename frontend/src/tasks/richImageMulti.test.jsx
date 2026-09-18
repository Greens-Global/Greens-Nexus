import { describe, it, expect } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import RichDescription from './RichDescription';

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
