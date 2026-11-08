// Callouts and toggles in the Notes editor (Neil, 11/07/2026): both survive a
// round trip through the schema with only their checked attributes, the "/"
// menu makes them, Enter on an empty last line steps out, an editor's fold
// saves while a reader's does not, and the Markdown export reads well.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ notesList: vi.fn(async () => ({ notes: [] })) }));
vi.mock('../api', () => ({ api: apiMock }));

import NoteEditor from './NoteEditor';
import { normalizeHtml, safeHtml } from './noteSafeHtml';
import { htmlToMarkdown } from './notesModel';

const editorOf = async () => waitFor(() => { const el = document.querySelector('.ProseMirror'); if (!el?.editor) throw new Error('no editor'); return el.editor; });

beforeEach(() => { apiMock.notesList.mockClear(); });

describe('the schema', () => {
  it('keeps a callout tone and a toggle title and fold, and nothing else', () => {
    const out = normalizeHtml('<div data-type="callout" data-tone="tip" onclick="x"><p>Use the side gate</p></div>'
      + '<div data-type="toggle" data-summary="Gate codes" data-open="false"><p>1234</p></div>');
    expect(out).toContain('<div data-tone="tip" data-type="callout"><p>Use the side gate</p></div>');
    expect(out).toContain('data-summary="Gate codes"');
    expect(out).toContain('data-open="false"');
    expect(out).not.toContain('onclick');
    expect(safeHtml('<div data-type="callout" data-tone="red"><p>a</p></div>')).toContain('data-tone="info"');
  });

  it('exports to Markdown as a labeled quote and a bold title', () => {
    const md = htmlToMarkdown('<div data-type="callout" data-tone="warning"><p>Hard hats on</p></div><div data-type="toggle" data-summary="Codes"><p>1234</p></div>', 'T');
    expect(md).toContain('> **Warning:** Hard hats on');
    expect(md).toContain('**Codes**\n\n1234');
  });
});

describe('in the editor', () => {
  it('the "/" menu makes a callout, and Enter on an empty last line steps out of it', async () => {
    const onChange = vi.fn();
    render(<NoteEditor value="<p></p>" onChange={onChange} />);
    const ed = await editorOf();
    await act(async () => { ed.chain().focus().insertContent('/warn').run(); });
    fireEvent.mouseDown(await screen.findByText('Warning Callout'));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-type="callout"'));
    expect(onChange.mock.calls.at(-1)[0]).toContain('data-tone="warning"');
    await act(async () => { ed.chain().focus().insertContent('Watch the step').run(); });
    await act(async () => { ed.commands.enter(); });
    await act(async () => { ed.commands.enter(); });   // the empty last line leaves the callout
    expect(ed.state.selection.$from.depth).toBe(1);
    expect(ed.getHTML()).toMatch(/Watch the step<\/p><\/div><p><\/p>/);
  });

  it('a toggle folds: an editor saves the fold, a reader folds only their own view', async () => {
    const onChange = vi.fn();
    const html = '<div data-type="toggle" data-summary="Codes" data-open="true"><p>1234</p></div>';
    const { unmount } = render(<NoteEditor value={html} onChange={onChange} />);
    await editorOf();
    expect(screen.getByLabelText('Toggle title').value).toBe('Codes');
    fireEvent.click(screen.getByRole('button', { name: 'Fold Codes' }));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-open="false"'));
    fireEvent.change(screen.getByLabelText('Toggle title'), { target: { value: 'Gate Codes' } });
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-summary="Gate Codes"'));
    unmount();

    const onRead = vi.fn();
    render(<NoteEditor value={html} onChange={onRead} readOnly />);
    await editorOf();
    const fold = screen.getByRole('button', { name: 'Fold Codes' });
    fireEvent.click(fold);
    expect(screen.getByRole('button', { name: 'Unfold Codes' }).getAttribute('aria-expanded')).toBe('false');
    expect(onRead).not.toHaveBeenCalled();
  });
});
