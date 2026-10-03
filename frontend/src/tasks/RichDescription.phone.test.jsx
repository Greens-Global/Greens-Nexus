import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

// RichDescription on a phone (Oct 2026): a one-row toolbar of the six actions
// that matter at 36px, an @-mention list hung off the caret through
// AnchoredMenu with tappable rows, and no Ctrl+V hint. The desktop editor is
// shared with Tasks and must not change - pinned below too. Also pins the
// allowInlineData switch the ticket reply composer uses.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

// jsdom has no layout: ProseMirror's scroll-into-view after a focus() asks a
// Range for its rects. A zero rect is enough for it to carry on.
const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} });
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = zeroRect;

const { default: RichDescription } = await import('./RichDescription');

function setViewport(isMobile) {
  window.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

afterEach(() => { cleanup(); });

const PEOPLE = [{ email: 'neil@greensglobal.com', name: 'Neil Kadakia' }, { email: 'sagar@greensglobal.com', name: 'Sagar S' }];
const png = (name) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
const editorOf = (container) => container.querySelector('.ProseMirror').editor;

describe('RichDescription toolbar', () => {
  it('on a phone: Attach, Bold, Italic, Bulleted, Numbered, Link - 36px, one row', () => {
    setViewport(true);
    render(<RichDescription value="" onChange={() => {}} />);
    for (const label of ['Attach', 'Bold', 'Italic', 'Bulleted list', 'Numbered list', 'Link']) {
      const b = screen.getByRole('button', { name: label });
      expect(b.style.width).toBe('36px');
      expect(b.style.height).toBe('36px');
    }
    for (const label of ['Undo', 'Underline', 'Highlight', 'Strikethrough', 'Indent list item', 'Inline code', 'Code block', 'Rephrase with AI']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Bold' }).parentElement.style.flexWrap).toBe('nowrap');
  });

  it('on a desktop: the full toolbar, unchanged', () => {
    setViewport(false);
    render(<RichDescription value="" onChange={() => {}} />);
    for (const label of ['Attach', 'Undo', 'Redo', 'Bold', 'Italic', 'Underline', 'Highlight', 'Strikethrough', 'Bulleted list',
      'Numbered list', 'Indent list item', 'Link', 'Inline code', 'Code block', 'Rephrase with AI']) {
      expect(screen.getByRole('button', { name: label }).style.width).toBe('28px');
    }
  });

  it('hides the Ctrl+V hint in the + menu on a phone only', () => {
    setViewport(true);
    const { unmount } = render(<RichDescription value="" onChange={() => {}} />);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Attach' }));
    expect(screen.getByText(/Insert image/)).toBeInTheDocument();
    expect(screen.queryByText(/Ctrl\+V/)).toBeNull();
    unmount();
    setViewport(false);
    render(<RichDescription value="" onChange={() => {}} />);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Attach' }));
    expect(screen.getByText(/or press Ctrl\+V to paste/)).toBeInTheDocument();
  });
});

describe('@mentions on a phone', () => {
  it('opens a portaled list of 44px rows and a tap inserts the mention', async () => {
    setViewport(true);
    let html = '';
    const { container } = render(<RichDescription value="" onChange={(h) => { html = h; }} mentionPeople={PEOPLE} />);
    await act(async () => { editorOf(container).commands.insertContent('hi @nei'); });
    const listbox = await screen.findByRole('listbox', { name: 'Mention someone' });
    // Portaled to <body>, outside the editor frame that clips.
    expect(container.contains(listbox)).toBe(false);
    const row = screen.getByRole('option', { name: /Neil Kadakia/ });
    expect(row.style.minHeight).toBe('44px');
    await act(async () => { fireEvent.click(row); });
    expect(html).toContain('mailto:neil@greensglobal.com');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('keeps the old in-frame list on a desktop', async () => {
    setViewport(false);
    const { container } = render(<RichDescription value="" onChange={() => {}} mentionPeople={PEOPLE} />);
    await act(async () => { editorOf(container).commands.insertContent('hi @nei'); });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(container.querySelector('.nx-rich').textContent).toContain('Neil Kadakia');
  });
});

describe('allowInlineData={false} (ticket replies)', () => {
  it('uploads a picked picture and embeds it by URL', async () => {
    setViewport(false);
    let html = '';
    const upload = vi.fn(async (f) => ({ url: `https://x.supabase.co/storage/v1/object/public/ticket-evidence/${f.name}`, name: f.name, kind: 'image' }));
    const { container } = render(<RichDescription value="" onChange={(h) => { html = h; }} onAttachFile={upload} allowInlineData={false} />);
    const input = container.querySelector('input[type="file"][accept="image/*"]');
    await act(async () => { fireEvent.change(input, { target: { files: [png('a.png')] } }); });
    await waitFor(() => expect(html).toContain('ticket-evidence/a.png'));
    expect(html).not.toContain('data:');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('files a non-image result (an unconverted HEIC) as a link, not a broken picture', async () => {
    setViewport(false);
    let html = '';
    const heic = new File([new Uint8Array([1])], 'IMG_1.HEIC', { type: 'image/heic' });
    const upload = vi.fn(async () => ({ url: 'https://x.supabase.co/storage/v1/object/public/ticket-evidence/IMG_1.HEIC', name: 'IMG_1.HEIC', kind: 'doc' }));
    const { container } = render(<RichDescription value="" onChange={(h) => { html = h; }} onAttachFile={upload} allowInlineData={false} />);
    await act(async () => { fireEvent.change(container.querySelector('input[type="file"][accept="image/*"]'), { target: { files: [heic] } }); });
    await waitFor(() => expect(html).toContain('<a'));
    expect(html).not.toContain('<img');
    expect(html).toContain('IMG_1.HEIC');
  });

  it('a failed upload never falls back to base64', async () => {
    setViewport(false);
    let html = '';
    const upload = vi.fn(async () => { throw new Error('offline'); });
    const { container } = render(<RichDescription value="" onChange={(h) => { html = h; }} onAttachFile={upload} allowInlineData={false} />);
    await act(async () => { fireEvent.change(container.querySelector('input[type="file"][accept="image/*"]'), { target: { files: [png('a.png')] } }); });
    expect(await screen.findByRole('alert')).toHaveTextContent(/"a.png" couldn't be uploaded: offline/);
    expect(html).not.toContain('data:');
    expect(container.querySelectorAll('.ProseMirror img').length).toBe(0);
  });

  it('default (Tasks) still embeds a picked picture inline', async () => {
    setViewport(false);
    const { container } = render(<RichDescription value="" onChange={() => {}} />);
    await act(async () => { fireEvent.change(container.querySelector('input[type="file"][accept="image/*"]'), { target: { files: [png('a.png')] } }); });
    await waitFor(() => expect(container.querySelector('.ProseMirror img')?.getAttribute('src')).toMatch(/^data:image\/png/));
  });
});
