// Boards in Notes (Neil, 11/02/2026) - the UI wiring around the whiteboard
// engine, with the engine itself mocked (board/Board.jsx is jsdom-hostile and
// its own tests cover it): New Board everywhere New Note exists, a board note
// renders the Board in place of the editor, the scene saves with the rev,
// the thumbnail lands in the bucket and on the note, the export menu offers
// pictures instead of Markdown, and the list rows show the picture.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const SCENE = JSON.stringify({ type: 'nexus-board', version: 1, look: 'sketch', elements: [{ id: 'a', type: 'rectangle' }, { id: 'b', type: 'text', isDeleted: true }], appState: {}, files: {} });

const note = (over = {}) => ({
  id: 'note_1', kind: 'note', title: 'Budget Review', preview: 'Quarterly numbers', body: '<p>Quarterly numbers</p>',
  day: TODAY, tags: [], color: '', pinned: false, owner: 'neil@greensglobal.com', mine: true, can: 'owner',
  shared: false, sharedWith: [], trashedAt: '', rev: 3, words: 2, updatedAt: new Date().toISOString(), updatedBy: 'neil@greensglobal.com', ...over,
});
const board = (over = {}) => note({ id: 'board_1', kind: 'board', title: 'Yard Layout', preview: '', body: '', scene: SCENE, thumbUrl: 'https://api.test/files/view?u=thumb.png', ...over });

const apiMock = vi.hoisted(() => ({
  notesList: vi.fn(), noteGet: vi.fn(), noteCreate: vi.fn(), noteUpdate: vi.fn(), noteDaily: vi.fn(),
  noteDailyAppend: vi.fn(), noteTrash: vi.fn(), noteRestore: vi.fn(), noteDeleteForever: vi.fn(),
  noteShare: vi.fn(), noteUnshare: vi.fn(), noteVersions: vi.fn(), noteRestoreVersion: vi.fn(),
  getPeopleDirectory: vi.fn(async () => []),
}));
const storeTaskFile = vi.hoisted(() => vi.fn(async () => 'https://api.test/files/view?u=new-thumb.png'));
const exportMock = vi.hoisted(() => ({
  exportPng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  exportSvg: vi.fn(async () => '<svg/>'),
  copyPng: vi.fn(async () => {}),
  downloadScene: vi.fn(),
}));
vi.mock('../api', () => ({ api: apiMock }));
vi.mock('../tasks/lib', async (importOriginal) => ({ ...(await importOriginal()), storeTaskFile }));
vi.mock('./board/exportBoard', () => exportMock);
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ myEmail: 'neil@greensglobal.com' }) }));
vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [{ name: 'Neil Kadakia', username: 'neil@greensglobal.com' }] }) }));
vi.mock('../contexts/NotificationContext.jsx', () => ({ useNotifications: () => ({ openPanel: vi.fn() }) }));
// The engine, as a stub that lets a test drive the props the real one calls.
vi.mock('./board/Board', () => ({
  default: ({ note, isPhone, look, onLook, onScene, onThumb, onApi }) => (
    <div data-testid="board-stub" data-look={look} data-phone={isPhone ? 'true' : 'false'} data-can-edit={note?.canEdit ? 'true' : 'false'}>
      <button type="button" onClick={() => onApi?.({ fake: true })}>stub-api</button>
      <button type="button" onClick={() => onScene?.(JSON.stringify({ type: 'nexus-board', version: 1, look, elements: [{ id: 'z', type: 'ellipse' }], appState: {}, files: {} }))}>stub-draw</button>
      <button type="button" onClick={() => onThumb?.(new Blob(['x'], { type: 'image/png' }))}>stub-thumb</button>
      <button type="button" onClick={() => onLook?.('clean')}>stub-look</button>
    </div>
  ),
}));

import NotesPage from './NotesPage';
import NotesWidget from './NotesWidget';
import QuickNotePanel from './QuickNotePanel';
import { noteTitle, isBoard } from './notesModel';
import { CREATE_ITEMS } from '../lib/quickCreate';

beforeEach(() => {
  localStorage.clear();
  Object.values(apiMock).forEach((f) => f.mockReset?.());
  Object.values(exportMock).forEach((f) => f.mockClear?.());
  storeTaskFile.mockClear();
  apiMock.getPeopleDirectory.mockResolvedValue([]);
  apiMock.notesList.mockResolvedValue({ notes: [note(), board()], counts: { all: 2, pinned: 0, today: 2, shared: 0, trash: 0 }, tags: [] });
  apiMock.noteGet.mockImplementation(async (id) => (id === 'board_1' ? board() : note()));
});

describe('Boards in the Notes list and bar', () => {
  it('New Board creates a board note and opens it', async () => {
    apiMock.noteCreate.mockResolvedValue(board({ id: 'board_2', title: '', scene: '', thumbUrl: '' }));
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes" onSubChange={onSubChange} />);
    await screen.findByText('Budget Review');
    fireEvent.click(screen.getByRole('button', { name: /New Board/ }));
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'board', scene: '', day: TODAY })));
    await waitFor(() => expect(onSubChange).toHaveBeenLastCalledWith('notes:board_2'));
  });

  it('a board row shows its picture and says Board; a note row keeps its words', async () => {
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    const row = (await screen.findByRole('button', { name: /Yard Layout/ }));
    const img = row.querySelector('img.nt-row-thumb');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toContain('thumb.png');
    expect(row.textContent).toContain('Board ·');
    expect(screen.getByRole('button', { name: /Budget Review/ }).textContent).toContain('Quarterly numbers');
  });

  it('a board with no picture yet shows a quiet placeholder', async () => {
    apiMock.notesList.mockResolvedValue({ notes: [board({ thumbUrl: '' })], counts: { all: 1 }, tags: [] });
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    const row = await screen.findByRole('button', { name: /Yard Layout/ });
    expect(row.querySelector('.nt-row-thumb.is-empty')).toBeTruthy();
  });

  it('names an untitled board', () => {
    expect(noteTitle({ kind: 'board', title: '' })).toBe('Untitled Board');
    expect(noteTitle({ kind: 'note', title: '' })).toBe('Untitled Note');
    expect(isBoard({ kind: 'board' })).toBe(true);
  });

  it('the + menu lists New Board right after New Note', () => {
    const keys = CREATE_ITEMS.map((it) => it.key);
    expect(keys.indexOf('board')).toBe(keys.indexOf('note') + 1);
    expect(CREATE_ITEMS.find((it) => it.key === 'board').label).toBe('New Board');
  });
});

describe('An open board', () => {
  it('renders the whiteboard in place of the editor, with the look from its scene and the title row above', async () => {
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    const stub = await screen.findByTestId('board-stub');
    expect(stub.getAttribute('data-look')).toBe('sketch');
    expect(stub.getAttribute('data-can-edit')).toBe('true');
    expect(document.querySelector('.ProseMirror')).toBeNull();
    expect(screen.getByDisplayValue('Yard Layout')).toBeTruthy();
    expect(screen.getByLabelText('Board title')).toBeTruthy();
    expect(screen.getByText('1 shape')).toBeTruthy();   // the deleted one is not counted
    expect(document.querySelector('.nt-doc.is-board .nt-board')).toBeTruthy();
  });

  it('a board shared to read opens the whiteboard in view mode', async () => {
    apiMock.noteGet.mockResolvedValue(board({ mine: false, can: 'read', owner: 'bob@greensglobal.com' }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    const stub = await screen.findByTestId('board-stub');
    expect(stub.getAttribute('data-can-edit')).toBe('false');
  });

  it('saves the drawn scene with the rev it read, like a body', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.noteUpdate.mockResolvedValue(board({ rev: 4 }));
      render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
      await screen.findByTestId('board-stub');
      fireEvent.click(screen.getByRole('button', { name: 'stub-draw' }));
      await act(async () => { vi.advanceTimersByTime(900); });
      await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledWith('board_1', expect.objectContaining({ rev: 3, scene: expect.stringContaining('"ellipse"') })));
    } finally { vi.useRealTimers(); }
  });

  it('a 409 on a board takes the server rev and saves the scene drawn here again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const theirs = board({ rev: 7, updatedBy: 'bob@greensglobal.com' });
      apiMock.noteUpdate.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409, detail: { note: theirs } }));
      apiMock.noteUpdate.mockResolvedValueOnce(board({ rev: 8 }));
      render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
      await screen.findByTestId('board-stub');
      fireEvent.click(screen.getByRole('button', { name: 'stub-draw' }));
      await act(async () => { vi.advanceTimersByTime(900); });
      await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledTimes(2));
      expect(apiMock.noteUpdate.mock.calls[1][1]).toEqual(expect.objectContaining({ rev: 7, scene: expect.stringContaining('"ellipse"') }));
      expect(screen.queryByRole('button', { name: 'Keep Mine' })).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('the thumbnail goes to the bucket under the board and onto the note', async () => {
    apiMock.noteUpdate.mockResolvedValue(board({ rev: 4, thumbUrl: 'https://api.test/files/view?u=new-thumb.png' }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'stub-thumb' }));
    await waitFor(() => expect(storeTaskFile).toHaveBeenCalled());
    expect(storeTaskFile.mock.calls[0][2]).toBe('notes/boards/board_1');
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledWith('board_1', expect.objectContaining({ thumbUrl: 'https://api.test/files/view?u=new-thumb.png' })));
  });

  it('the look picked on the board shows at once', async () => {
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    const stub = await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'stub-look' }));
    await waitFor(() => expect(stub.getAttribute('data-look')).toBe('clean'));
  });

  it('exports pictures, never Markdown', async () => {
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'stub-api' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: /Export as PNG/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Export as SVG/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Copy as Picture/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Download Board File/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Markdown/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Print/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Version History/ })).toBeTruthy();
    // jsdom has no object URLs; the export hands the blob to one.
    const url = vi.fn(() => 'blob:x');
    URL.createObjectURL = url;
    URL.revokeObjectURL = vi.fn();
    fireEvent.click(screen.getByRole('menuitem', { name: /Export as PNG/ }));
    await waitFor(() => expect(exportMock.exportPng).toHaveBeenCalledWith({ fake: true }, { scale: 2, background: true }));
    await waitFor(() => expect(url).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Download Board File/ }));
    expect(exportMock.downloadScene).toHaveBeenCalledWith(expect.objectContaining({ id: 'board_1' }));
  });
});

describe('A board on a phone', () => {
  const realMatch = window.matchMedia;
  afterEach(() => { window.matchMedia = realMatch; });
  it('opens in the full-screen sheet titled Board, the whiteboard filling it', async () => {
    window.matchMedia = (q) => ({ matches: q === '(max-width: 768px)', media: q, addEventListener() {}, removeEventListener() {} });
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    const sheet = await screen.findByRole('dialog', { name: 'Board' });
    const stub = await within(sheet).findByTestId('board-stub');
    expect(stub.getAttribute('data-phone')).toBe('true');
    expect(within(sheet).getByRole('button', { name: 'Close Note' })).toBeTruthy();
  });
});

describe('New Board elsewhere', () => {
  it('Quick Note starts a board and opens it on Notes', async () => {
    apiMock.noteDaily.mockResolvedValue({ note: null });
    apiMock.noteCreate.mockResolvedValue(board({ id: 'board_9', title: '', scene: '' }));
    const onClose = vi.fn();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    try {
      render(<QuickNotePanel onClose={onClose} />);
      fireEvent.click(await screen.findByRole('button', { name: /New Board/ }));
      await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'board' })));
      await waitFor(() => expect(nav).toHaveBeenCalled());
      expect(nav.mock.calls[0][0].detail).toEqual({ view: 'dashboard', sub: 'notes:board_9' });
      expect(onClose).toHaveBeenCalled();
    } finally { window.removeEventListener('nexus:navigate', nav); }
  });

  it('the Dashboard tile offers New Board and shows a board with its picture', async () => {
    apiMock.notesList.mockResolvedValue({ notes: [board()], counts: { all: 1 }, tags: [] });
    apiMock.noteCreate.mockResolvedValue(board({ id: 'board_3', title: '', scene: '' }));
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    try {
      render(<NotesWidget config={{}} saveConfig={vi.fn()} canSaveConfig />);
      expect(await screen.findByText('Yard Layout')).toBeTruthy();
      expect(document.querySelector('img.nt-row-thumb')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /New Board/ }));
      await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'board' })));
      await waitFor(() => expect(nav).toHaveBeenCalled());
      expect(nav.mock.calls[0][0].detail).toEqual({ view: 'dashboard', sub: 'notes:board_3' });
    } finally { window.removeEventListener('nexus:navigate', nav); }
  });
});
