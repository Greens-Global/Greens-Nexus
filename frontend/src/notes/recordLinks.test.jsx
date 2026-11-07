// Record Links and note templates (Neil, 11/06/2026): the [[ chip survives a
// round trip through the editor's schema with only a safe ref, the picker
// offers notes / tasks / jobs / Knowledge Base pages and puts a chip, a chip
// opens its record, "Mentioned In" lists the notes that link here (and shows
// nothing when none), and New From Template starts a note from a starter.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  notesList: vi.fn(), noteGet: vi.fn(), noteCreate: vi.fn(), noteUpdate: vi.fn(), noteMentions: vi.fn(),
  searchTaskModule: vi.fn(), searchJobs: vi.fn(), kbSearch: vi.fn(),
  getPeopleDirectory: vi.fn(async () => []),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));

import NoteEditor from './NoteEditor';
import MentionedIn from '../components/MentionedIn';
import NoteTemplatePicker from './NoteTemplatePicker';
import { NOTE_TEMPLATES } from './noteTemplates';
import { normalizeHtml, safeHtml } from './noteSafeHtml';
import { openRecord, safeRef } from './recordLink';

beforeEach(() => {
  Object.values(apiMock).forEach((f) => f.mockReset?.());
  apiMock.notesList.mockResolvedValue({ notes: [] });
  apiMock.searchTaskModule.mockResolvedValue({ tasks: [] });
  apiMock.searchJobs.mockResolvedValue({ jobs: [] });
  apiMock.kbSearch.mockResolvedValue({ results: [] });
  apiMock.noteMentions.mockResolvedValue({ notes: [], total: 0 });
});

const CHIP = '<p>See <a data-type="recordLink" data-ref="task:t-1" title="Fix the gate">Fix the gate</a> today</p>';

describe('the record link in the schema', () => {
  it('keeps the ref and title, and never an href', () => {
    const out = normalizeHtml(CHIP);
    expect(out).toContain('data-type="recordLink"');
    expect(out).toContain('data-ref="task:t-1"');
    expect(out).toContain('title="Fix the gate"');
    expect(normalizeHtml(CHIP.replace('<a ', '<a href="https://evil.example" '))).not.toContain('evil.example');
  });

  it('drops a ref that is not a known kind and plain id', () => {
    for (const bad of ['payroll:1', 'task:javascript:alert(1)', 'https://evil.example', 'task:a b']) {
      expect(safeRef(bad)).toBe('');
      expect(safeHtml(CHIP.replace('task:t-1', bad))).not.toContain('data-ref="');
    }
  });
});

describe('opening a record', () => {
  it('navigates the way the header search does', () => {
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    openRecord('note:note_ab');
    openRecord('job:42');
    openRecord('kb:6f1c');
    openRecord('nope:1');
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([
      { view: 'dashboard', sub: 'notes:note_ab' },
      { view: 'ops', sub: 'project:42' },
      { view: 'sop', sub: 'page:6f1c' },
    ]);
  });
});

describe('the [[ picker', () => {
  it('searches notes, tasks, jobs and pages and puts a chip that saves', async () => {
    apiMock.notesList.mockResolvedValue({ notes: [{ id: 'note_me', kind: 'note', title: 'This Note', mine: true }, { id: 'note_2', kind: 'note', title: 'Gate Plan', mine: true }] });
    apiMock.searchTaskModule.mockResolvedValue({ tasks: [{ id: 't-1', title: 'Gate repair', projectName: 'Yard' }] });
    apiMock.searchJobs.mockResolvedValue({ jobs: [{ id: 'j1', name: 'Gate Job', code: 'GJ-1' }] });
    apiMock.kbSearch.mockResolvedValue({ results: [{ id: 'kb1', title: 'Gate SOP', type_label: 'SOP' }] });
    const onChange = vi.fn();
    render(<NoteEditor value="<p></p>" onChange={onChange} noteId="note_me" />);
    const pm = await waitFor(() => { const el = document.querySelector('.ProseMirror'); if (!el) throw new Error('no editor'); return el; });
    const editor = pm.editor;
    await act(async () => { editor.chain().focus().insertContent('[[ga').run(); });
    expect(await screen.findByText('Gate repair')).toBeTruthy();
    expect(screen.getByText('Gate Plan')).toBeTruthy();
    expect(screen.getByText('Gate Job')).toBeTruthy();
    expect(screen.getByText('Gate SOP')).toBeTruthy();
    expect(screen.queryByText('This Note')).toBeNull();           // never the note itself
    expect(apiMock.kbSearch).toHaveBeenCalledWith('ga', expect.objectContaining({ log: false }));
    fireEvent.mouseDown(screen.getByText('Gate repair'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const html = onChange.mock.calls.at(-1)[0];
    expect(html).toContain('data-ref="task:t-1"');
    expect(html).toContain('Gate repair');
    expect(html).not.toContain('[[');
  });

  it('says when nothing matches', async () => {
    render(<NoteEditor value="<p></p>" onChange={vi.fn()} />);
    const pm = await waitFor(() => { const el = document.querySelector('.ProseMirror'); if (!el) throw new Error('no editor'); return el; });
    await act(async () => { pm.editor.chain().focus().insertContent('[[zzz').run(); });
    expect(await screen.findByText('Nothing matches "zzz"')).toBeTruthy();
  });
});

describe('Mentioned In', () => {
  it('lists the notes that link here and opens one', async () => {
    apiMock.noteMentions.mockResolvedValue({ notes: [{ id: 'note_9', kind: 'note', title: 'Site Walk', owner: 'bob@greensglobal.com', mine: false, updatedAt: '' }], total: 1 });
    render(<MentionedIn refKey="task:t-1" nameOf={(e) => (e.startsWith('bob') ? 'Bob Brown' : e)} />);
    expect(await screen.findByText('Mentioned In (1)')).toBeTruthy();
    expect(screen.getByText('from Bob Brown')).toBeTruthy();
    expect(apiMock.noteMentions).toHaveBeenCalledWith('task:t-1');
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('nexus:navigate', on);
    fireEvent.click(screen.getByText('Site Walk'));
    window.removeEventListener('nexus:navigate', on);
    expect(seen).toEqual([{ view: 'dashboard', sub: 'notes:note_9' }]);
  });

  it('shows nothing when no note links here, or the ref is bad', async () => {
    const { container } = render(<MentionedIn refKey="task:t-1" />);
    await waitFor(() => expect(apiMock.noteMentions).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    render(<MentionedIn refKey="nope" />);
    expect(apiMock.noteMentions).toHaveBeenCalledTimes(1);
  });
});

describe('New From Template', () => {
  it('lists your templates above the starters', async () => {
    apiMock.notesList.mockResolvedValue({ notes: [{ id: 'note_t', kind: 'note', title: 'My 1:1', preview: 'Wins' }, { id: 'note_b', kind: 'board', title: 'A Board' }] });
    const onPick = vi.fn(), onPickNote = vi.fn();
    render(<NoteTemplatePicker onPick={onPick} onPickNote={onPickNote} onClose={vi.fn()} />);
    expect(apiMock.notesList).toHaveBeenCalledWith({ view: 'templates' });
    fireEvent.click(await screen.findByRole('button', { name: /My 1:1 - your template/ }));
    expect(onPickNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'note_t' }));
    expect(screen.queryByText('A Board')).toBeNull();               // boards are New Board's
    fireEvent.click(screen.getByRole('button', { name: /^Site Walk/ }));
    expect(onPick).toHaveBeenCalledWith('site-walk');
  });

  it('every starter is valid note HTML with a dated US title', () => {
    for (const t of NOTE_TEMPLATES) {
      expect(t.title()).toMatch(/ - \d{2}\/\d{2}\/\d{4}$/);
      expect(normalizeHtml(t.body())).toContain('<h2>');
      expect(t.body()).not.toMatch(/—/);
    }
  });
});
