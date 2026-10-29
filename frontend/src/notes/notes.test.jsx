// Notes (Oct 29 2026) - render-smoke for the three surfaces (the Notes page,
// the dashboard tile, Quick Note) plus the pieces that must not regress: the
// autosave carries the rev and a 409 shows Keep Mine / Use Theirs, the old
// tile text moves into a note, the shortcut, and the Markdown round trip.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

const note = (over = {}) => ({
  id: 'note_1', kind: 'note', title: 'Budget Review', preview: 'Quarterly numbers', body: '<p>Quarterly numbers</p>',
  day: TODAY, tags: ['Finance'], color: 'green', pinned: true, owner: 'neil@greensglobal.com', mine: true, can: 'owner',
  shared: false, sharedWith: [], trashedAt: '', rev: 3, words: 2, updatedAt: new Date().toISOString(), updatedBy: 'neil@greensglobal.com', ...over,
});

const apiMock = vi.hoisted(() => ({
  notesList: vi.fn(), noteGet: vi.fn(), noteCreate: vi.fn(), noteUpdate: vi.fn(), noteDaily: vi.fn(),
  noteDailyAppend: vi.fn(), noteTrash: vi.fn(), noteRestore: vi.fn(), noteDeleteForever: vi.fn(),
  noteShare: vi.fn(), noteUnshare: vi.fn(), noteVersions: vi.fn(), noteRestoreVersion: vi.fn(),
  getPeopleDirectory: vi.fn(async () => [{ email: 'bob@greensglobal.com', name: 'Bob Brown' }]),
  createTask: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));

import NotesPage from './NotesPage';
import NotesWidget from './NotesWidget';
import QuickNotePanel from './QuickNotePanel';
import { isQuickNoteKey, htmlToMarkdown, markdownToHtml, groupByDay, dayHeading, addDays } from './notesModel';

beforeEach(() => {
  localStorage.clear();
  Object.values(apiMock).forEach((f) => f.mockReset?.());
  apiMock.getPeopleDirectory.mockResolvedValue([{ email: 'bob@greensglobal.com', name: 'Bob Brown' }]);
  apiMock.notesList.mockResolvedValue({ notes: [note()], counts: { all: 1, pinned: 1, today: 1, shared: 0, trash: 0 }, tags: ['Finance'] });
  apiMock.noteGet.mockResolvedValue(note());
});

describe('Notes page', () => {
  it('lists notes by day with the view counts and opens one from its sub', async () => {
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    expect(await screen.findByDisplayValue('Budget Review')).toBeTruthy();
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: /Pinned/ }).textContent).toContain('1');
    expect(screen.getByText('#Finance')).toBeTruthy();
    expect(apiMock.notesList).toHaveBeenCalledWith(expect.objectContaining({ view: 'all', month: TODAY.slice(0, 7), today: TODAY }));
    await waitFor(() => expect(document.querySelector('.ProseMirror')?.textContent).toContain('Quarterly numbers'));
  });

  it('shows the empty state with no notes and no note open', async () => {
    apiMock.notesList.mockResolvedValue({ notes: [], counts: { all: 0, pinned: 0, today: 0, shared: 0, trash: 0 }, tags: [] });
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/No notes in/)).toBeTruthy();
    expect(screen.getByText('Pick a note or start a new one')).toBeTruthy();
  });

  it('autosaves the title with the rev it read, and offers Keep Mine / Use Theirs on a 409', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const theirs = note({ rev: 4, title: 'Their Title', updatedBy: 'bob@greensglobal.com' });
      apiMock.noteUpdate.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409, detail: { note: theirs } }));
      render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
      const title = await screen.findByDisplayValue('Budget Review');
      fireEvent.change(title, { target: { value: 'Budget Review Q4' } });
      await act(async () => { vi.advanceTimersByTime(900); });
      await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledWith('note_1', expect.objectContaining({ rev: 3, title: 'Budget Review Q4' })));
      expect(await screen.findByRole('button', { name: 'Keep Mine' })).toBeTruthy();
      expect(screen.getByText(/by bob@greensglobal.com/)).toBeTruthy();
      apiMock.noteUpdate.mockResolvedValueOnce(note({ rev: 5, title: 'Budget Review Q4' }));
      fireEvent.click(screen.getByRole('button', { name: 'Keep Mine' }));
      await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenLastCalledWith('note_1', expect.objectContaining({ rev: 4, title: 'Budget Review Q4' })));
    } finally { vi.useRealTimers(); }
  });

  it('puts back an unsaved local draft when the note opens', async () => {
    localStorage.setItem('nx-note-draft:note_1', JSON.stringify({ rev: 3, title: 'Budget Review', body: '<p>Typed offline</p>' }));
    apiMock.noteUpdate.mockResolvedValue(note({ rev: 4, body: '<p>Typed offline</p>' }));
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/Unsaved words from your last visit/)).toBeTruthy();
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledWith('note_1', expect.objectContaining({ rev: 3, body: '<p>Typed offline</p>' })), { timeout: 3000 });
  });

  it('a trashed note reads only, with Restore and Delete Forever', async () => {
    apiMock.noteGet.mockResolvedValue(note({ trashedAt: new Date().toISOString(), pinned: false }));
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/This note is in the Trash/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Restore/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Delete Forever/ }));
    expect(screen.getByText(/This cannot be undone/)).toBeTruthy();
  });

  it('a note shared to read shows who shared it and no editing controls', async () => {
    apiMock.noteGet.mockResolvedValue(note({ mine: false, can: 'read', owner: 'bob@greensglobal.com', pinned: false }));
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    expect(await screen.findByText(/Shared by bob@greensglobal.com · Can Read/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Formatting' })).toBeNull();
  });
});

describe('Notes widget', () => {
  it('shows pinned notes and adds a line to today\'s scratchpad', async () => {
    apiMock.noteDailyAppend.mockResolvedValue(note({ kind: 'daily' }));
    render(<NotesWidget config={{}} saveConfig={vi.fn()} canSaveConfig />);
    expect(await screen.findByText('Budget Review')).toBeTruthy();
    expect(screen.getByText('Pinned')).toBeTruthy();
    const input = screen.getByLabelText("Add to today's scratchpad");
    fireEvent.change(input, { target: { value: 'Call the plumber' } });
    fireEvent.submit(input.closest('form'));
    await waitFor(() => expect(apiMock.noteDailyAppend).toHaveBeenCalledWith(TODAY, 'Call the plumber'));
  });

  it('moves the tile\'s old text into a note once', async () => {
    apiMock.noteCreate.mockResolvedValue(note({ id: 'note_2', title: 'Dashboard Notes' }));
    const saveConfig = vi.fn(async () => ({}));
    render(<NotesWidget config={{ text: 'old line one\nold <two>' }} saveConfig={saveConfig} canSaveConfig />);
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Dashboard Notes', body: '<p>old line one</p><p>old &lt;two&gt;</p>',
    })));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith({ text: '' }));
    expect(apiMock.noteCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps old text read-only on a view it cannot save', async () => {
    render(<NotesWidget config={{ text: 'shared view text' }} canSaveConfig={false} />);
    expect(await screen.findByText('shared view text')).toBeTruthy();
    expect(apiMock.noteCreate).not.toHaveBeenCalled();
  });
});

describe('Quick Note', () => {
  it('opens today\'s scratchpad when there is one', async () => {
    apiMock.noteDaily.mockResolvedValue({ note: note({ kind: 'daily', title: '', body: '<p>Morning list</p>' }) });
    apiMock.noteGet.mockResolvedValue(note({ kind: 'daily', title: '', body: '<p>Morning list</p>' }));
    render(<QuickNotePanel onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Quick Note' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.ProseMirror')?.textContent).toContain('Morning list'));
    expect(screen.getByRole('button', { name: /Open in Notes/ })).toBeTruthy();
  });

  it('with no scratchpad yet shows an empty editor and makes nothing until you type', async () => {
    apiMock.noteDaily.mockResolvedValue({ note: null });
    render(<QuickNotePanel onClose={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
    expect(apiMock.noteCreate).not.toHaveBeenCalled();
  });

  it('Escape closes it', async () => {
    apiMock.noteDaily.mockResolvedValue({ note: null });
    const onClose = vi.fn();
    render(<QuickNotePanel onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('the shortcut is Ctrl+Alt+N (Ctrl+Cmd+N on a Mac), never an AltGr letter or Shift', () => {
    expect(isQuickNoteKey({ ctrlKey: true, altKey: true, key: 'n' })).toBe(true);
    expect(isQuickNoteKey({ ctrlKey: true, metaKey: true, code: 'KeyN', key: 'n' })).toBe(true);
    expect(isQuickNoteKey({ ctrlKey: true, altKey: true, key: 'ń', code: 'KeyN' })).toBe(false);
    expect(isQuickNoteKey({ ctrlKey: true, shiftKey: true, key: 'N' })).toBe(false);
    expect(isQuickNoteKey({ altKey: true, key: 'n' })).toBe(false);
  });
});

describe('notesModel', () => {
  it('round-trips Markdown through note HTML', () => {
    const md = '# Plan\n\nSome **bold** and *soft* text with [a link](https://greensglobal.com)\n\n- [ ] Open item\n- [x] Done item\n\n1. First\n2. Second\n\n> Quoted\n\n```\ncode()\n```';
    const html = markdownToHtml(md);
    expect(html).toContain('<h1>Plan</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li data-type="taskItem" data-checked="true"><p>Done item</p></li>');
    expect(html).toContain('<ol><li><p>First</p></li>');
    const back = htmlToMarkdown(html, 'Plan Title');
    expect(back.startsWith('# Plan Title\n\n# Plan')).toBe(true);
    expect(back).toContain('- [ ] Open item');
    expect(back).toContain('- [x] Done item');
    expect(back).toContain('1. First');
    expect(back).toContain('[a link](https://greensglobal.com)');
    expect(back).toContain('```\ncode()\n```');
  });

  it('escapes HTML in imported text and drops unsafe links', () => {
    const html = markdownToHtml('<script>x</script> [bad](javascript:alert(1))');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript');
  });

  it('groups by day newest first, pinned first inside a day, with US day headings', () => {
    const g = groupByDay([
      note({ id: 'a', day: '2026-10-27', pinned: false }),
      note({ id: 'b', day: '2026-10-29', pinned: false, updatedAt: '2026-10-29T10:00:00Z' }),
      note({ id: 'c', day: '2026-10-29', pinned: true, updatedAt: '2026-10-29T09:00:00Z' }),
    ]);
    expect(g.map((x) => x.day)).toEqual(['2026-10-29', '2026-10-27']);
    expect(g[0].notes.map((n) => n.id)).toEqual(['c', 'b']);
    expect(dayHeading('2026-10-29', '2026-10-29')).toBe('Today');
    expect(dayHeading('2026-10-28', '2026-10-29')).toBe('Yesterday');
    expect(dayHeading('2026-10-27', '2026-10-29')).toBe('Tuesday, 10/27/2026');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});
