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
  noteShare: vi.fn(), noteUnshare: vi.fn(), noteVersions: vi.fn(), noteRestoreVersion: vi.fn(), noteVersionGet: vi.fn(),
  attachMarkup: vi.fn(),
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
  default: ({ note, isPhone, look, onLook, onScene, onThumb, onApi, presentSignal }) => (
    <div data-testid="board-stub" data-look={look} data-phone={isPhone ? 'true' : 'false'} data-can-edit={note?.canEdit ? 'true' : 'false'} data-present={String(presentSignal || 0)}>
      <button type="button" onClick={() => onApi?.({ fake: true })}>stub-api</button>
      <button type="button" onClick={() => onScene?.(JSON.stringify({ type: 'nexus-board', version: 1, look, elements: [{ id: 'z', type: 'ellipse' }], appState: {}, files: {} }))}>stub-draw</button>
      <button type="button" onClick={() => onThumb?.(new Blob(['x'], { type: 'image/png' }))}>stub-thumb</button>
      <button type="button" onClick={() => onLook?.('clean')}>stub-look</button>
    </div>
  ),
}));

// The live session is its own hook (board/useBoardCollab.test.jsx covers it);
// here only that a shared board turns it on and shows who is drawing.
const boardCollabMock = vi.hoisted(() => ({ useBoardCollab: vi.fn() }));
vi.mock('./board/useBoardCollab', () => boardCollabMock);
// Eligibility (useNoteCollab.collabEligible) needs a Realtime client and WebCrypto.
vi.mock('../lib/supabase', () => ({ supabase: { channel: () => ({}), removeChannel: () => {} } }));
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);

import NotesPage from './NotesPage';
import NotesWidget from './NotesWidget';
import QuickNotePanel from './QuickNotePanel';
import { noteTitle, isBoard, writeDraft } from './notesModel';
import { ACTIONS } from '../lib/quickCreate';

// "+ New" (11/12/2026): the bar's one create button; a row of its menu.
const pickNew = async (label) => {
  fireEvent.click(screen.getByRole('button', { name: 'New' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(`^${label}`) }));
};

beforeEach(() => {
  boardCollabMock.useBoardCollab.mockReset();
  boardCollabMock.useBoardCollab.mockImplementation(({ enabled }) => ({
    enabled: !!enabled, phase: enabled ? 'ready' : 'off', status: enabled ? 'live' : 'off', live: !!enabled,
    peers: enabled ? [{ name: 'Bob Brown', color: '#123456', email: 'bob@greensglobal.com' }] : [],
    attach: vi.fn(), onChange: vi.fn(), pointer: vi.fn(), restart: vi.fn(), resync: vi.fn(), fail: vi.fn(),
    epoch: enabled ? 'ep1' : '', keyTag: '', getHtml: () => null, setHtml: () => true, isRemote: () => false,
    encodeState: () => '', applyState: () => {}, bindEditor: () => {},
  }));
  localStorage.clear();
  Object.values(apiMock).forEach((f) => f.mockReset?.());
  Object.values(exportMock).forEach((f) => f.mockClear?.());
  storeTaskFile.mockClear();
  apiMock.getPeopleDirectory.mockResolvedValue([]);
  apiMock.notesList.mockResolvedValue({ notes: [note(), board()], counts: { all: 2, pinned: 0, today: 2, shared: 0, trash: 0 }, tags: [] });
  apiMock.noteGet.mockImplementation(async (id) => (id === 'board_1' ? board() : note()));
});

describe('Boards in the Notes list and bar', () => {
  it('New Board asks what to start from, then creates the board from the template and opens it', async () => {
    apiMock.noteCreate.mockResolvedValue(board({ id: 'board_2', title: '', scene: '', thumbUrl: '' }));
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes" onSubChange={onSubChange} />);
    await screen.findByText('Budget Review');
    await pickNew('Board');
    expect(apiMock.noteCreate).not.toHaveBeenCalled();
    const picker = await screen.findByRole('dialog', { name: 'New Board' });
    expect(within(picker).queryAllByRole('listitem')).toEqual([]);
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Blank'), expect.stringContaining('Kanban'), expect.stringContaining('Floor Plan')]));
    fireEvent.click(within(picker).getByRole('button', { name: /^Kanban/ }));
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledTimes(1));
    const body = apiMock.noteCreate.mock.calls[0][0];
    expect(body).toMatchObject({ kind: 'board', day: TODAY, templateKey: 'kanban' });
    const scene = JSON.parse(body.scene);
    expect(scene.type).toBe('nexus-board');
    expect(scene.elements.filter((e) => e.type === 'frame').map((e) => e.name)).toEqual(['To Do', 'Doing', 'Done']);
    await waitFor(() => expect(onSubChange).toHaveBeenLastCalledWith('notes:board_2'));
    expect(screen.queryByRole('dialog', { name: 'New Board' })).toBeNull();
  });

  it('Blank starts an empty Clean board', async () => {
    apiMock.noteCreate.mockResolvedValue(board({ id: 'board_3', title: '', scene: '', thumbUrl: '' }));
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    await screen.findByText('Budget Review');
    await pickNew('Board');
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'New Board' })).getByRole('button', { name: /^Blank/ }));
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledTimes(1));
    const scene = JSON.parse(apiMock.noteCreate.mock.calls[0][0].scene);
    expect(scene.elements).toEqual([]);
    expect(scene.look).toBe('clean');
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

  it('the Boards tab lists the boards and, with nothing open, shows them as a grid of pictures', async () => {
    apiMock.notesList.mockImplementation(async ({ view }) => ({
      notes: view === 'boards' ? [board()] : [note(), board()], counts: { all: 2, boards: 1 }, tags: [],
    }));
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes" onSubChange={onSubChange} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Boards/ }));
    await waitFor(() => expect(apiMock.notesList).toHaveBeenCalledWith(expect.objectContaining({ view: 'boards' })));
    const grid = await screen.findByRole('list', { name: 'Boards' });
    fireEvent.click(within(grid).getByRole('listitem'));
    expect(onSubChange).toHaveBeenCalledWith('notes:board_1');
  });

  it('a right-click on a row offers Duplicate, which copies the note and opens the copy', async () => {
    apiMock.noteCreate.mockResolvedValue(note({ id: 'note_2', title: 'Budget Review (Copy)' }));
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes" onSubChange={onSubChange} />);
    const row = (await screen.findByText('Budget Review')).closest('button');
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 });
    const menu = screen.getByRole('menu', { name: 'Note actions' });
    expect(within(menu).getByRole('menuitem', { name: /Rename/ })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Duplicate/ }));
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'note', title: 'Budget Review (Copy)', body: '<p>Quarterly numbers</p>' })));
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('notes:note_2'));
    expect(screen.queryByRole('menu', { name: 'Note actions' })).toBeNull();
  });

  it('a note with two or more headings has an Outline that lists them', async () => {
    apiMock.noteGet.mockResolvedValue(note({ body: '<h1>Plan</h1><p>x</p><h2>Budget</h2><h4>no</h4>' }));
    render(<NotesPage activeSub="notes:note_1" onSubChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Outline' }));
    const pop = screen.getByRole('menu', { name: 'Outline' });
    expect(within(pop).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Plan', 'Budget']);
  });

  it('names an untitled board', () => {
    expect(noteTitle({ kind: 'board', title: '' })).toBe('Untitled Board');
    expect(noteTitle({ kind: 'note', title: '' })).toBe('Untitled Note');
    expect(isBoard({ kind: 'board' })).toBe(true);
  });

  it('Quick Actions lists New Board right after New Note', () => {
    const keys = ACTIONS.map((it) => it.key);
    expect(keys.indexOf('board')).toBe(keys.indexOf('note') + 1);
    expect(ACTIONS.find((it) => it.key === 'board').label).toBe('New Board');
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

  it('the list collapses to a rail and comes back, remembered in this browser (Neil, 11/06/2026)', async () => {
    const { unmount } = render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the list' }));
    expect(document.querySelector('.nt-list')).toBeNull();
    expect(localStorage.getItem('nx-notes-list-open')).toBe('0');
    unmount();
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    expect(document.querySelector('.nt-list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the list' }));
    expect(document.querySelector('.nt-list')).toBeTruthy();
    expect(localStorage.getItem('nx-notes-list-open')).toBe('1');
  });

  it('full screen shows Back to Notes and a labeled Exit Full Screen, and either one leaves it', async () => {
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    expect(screen.queryByRole('button', { name: /Back to Notes/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Full Screen' }));
    expect(document.querySelector('.nt-page.is-full')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Back to Notes/ }));
    expect(document.querySelector('.nt-page.is-full')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Full Screen' }));
    fireEvent.click(screen.getByRole('button', { name: /Exit Full Screen/ }));
    expect(document.querySelector('.nt-page.is-full')).toBeNull();
  });

  it('Ctrl+\\ hides and shows the list', async () => {
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    expect(document.querySelector('.nt-list')).toBeNull();
    fireEvent.keyDown(window, { key: '\\', ctrlKey: true });
    expect(document.querySelector('.nt-list')).toBeTruthy();
  });

  it('Present hands the board a new signal each press', async () => {
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    const stub = await screen.findByTestId('board-stub');
    expect(stub.getAttribute('data-present')).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    expect(screen.getByTestId('board-stub').getAttribute('data-present')).toBe('1');
  });

  it('Use as Template marks the board (owner only), and New Board lists it under Your Templates to start from', async () => {
    apiMock.noteUpdate.mockImplementation(async (id, p) => board({ ...p, rev: 3, template: !!p.template }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Use as Template/ }));
    await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledWith('board_1', expect.objectContaining({ template: true })));

    apiMock.notesList.mockImplementation(async ({ view }) => (view === 'templates'
      ? { notes: [board({ id: 'board_t', title: 'Site Walk', template: true })], counts: {}, tags: [] }
      : { notes: [note(), board()], counts: {}, tags: [] }));
    apiMock.noteGet.mockImplementation(async (id) => (id === 'board_t' ? board({ id: 'board_t', title: 'Site Walk' }) : board()));
    apiMock.noteCreate.mockResolvedValue(board({ id: 'board_new', title: 'Site Walk' }));
    await pickNew('Board');
    const picker = await screen.findByRole('dialog', { name: 'New Board' });
    fireEvent.click(await within(picker).findByRole('button', { name: /Site Walk - your template/ }));
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'board', title: 'Site Walk', scene: SCENE })));
  });

  it('a board opened from a note\'s embed shows Back to that note', async () => {
    sessionStorage.setItem('nx-board-back', JSON.stringify({ board: 'board_1', note: 'note_1' }));
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes:board_1" onSubChange={onSubChange} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(await screen.findByRole('button', { name: /Back to Budget Review/ }));
    expect(onSubChange).toHaveBeenCalledWith('notes:note_1');
    sessionStorage.clear();
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

  it('a 409 on a board takes the server rev and saves both sides\' shapes, never this copy whole over theirs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Tab A saved three shapes meanwhile; tab B (here) drew one.
      const theirScene = JSON.stringify({ type: 'nexus-board', version: 1, look: 'sketch', appState: {},
        elements: [{ id: 'a', type: 'rectangle', version: 1 }, { id: 'c1', type: 'diamond', version: 1 }, { id: 'c2', type: 'line', version: 1 }, { id: 'c3', type: 'arrow', version: 1 }],
        files: { f9: { id: 'f9', mimeType: 'image/png', url: 'https://api.test/files/view?u=f9.png', created: 1 } } });
      const theirs = board({ rev: 7, updatedBy: 'bob@greensglobal.com', scene: theirScene });
      apiMock.noteUpdate.mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409, detail: { note: theirs } }));
      apiMock.noteUpdate.mockResolvedValueOnce(board({ rev: 8 }));
      render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
      await screen.findByTestId('board-stub');
      fireEvent.click(screen.getByRole('button', { name: 'stub-draw' }));
      await act(async () => { vi.advanceTimersByTime(900); });
      await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledTimes(2));
      const second = apiMock.noteUpdate.mock.calls[1][1];
      expect(second.rev).toBe(7);
      expect(second).not.toHaveProperty('body');
      const saved = JSON.parse(second.scene);
      expect(saved.elements.map((e) => e.id).sort()).toEqual(['a', 'c1', 'c2', 'c3', 'z']);
      expect(Object.keys(saved.files)).toEqual(['f9']);
      expect(screen.queryByRole('button', { name: 'Keep Mine' })).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('a board drawn here at rev 3 and reopened at rev 7 reconciles the draft into the server copy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // The draft: the old copy of `a` plus a new shape `d`, never saved.
      writeDraft('board_1', { rev: 3, title: 'Yard Layout', baseTitle: 'Yard Layout', body: '',
        scene: JSON.stringify({ type: 'nexus-board', version: 1, look: 'sketch', appState: {}, files: {},
          elements: [{ id: 'a', type: 'rectangle', version: 1, x: 0 }, { id: 'd', type: 'diamond', version: 1 }] }) });
      // The server moved on: Bob moved `a` (version 5) and drew `s`.
      const serverScene = JSON.stringify({ type: 'nexus-board', version: 1, look: 'sketch', appState: {}, files: {},
        elements: [{ id: 'a', type: 'rectangle', version: 5, x: 99 }, { id: 's', type: 'line', version: 1 }] });
      apiMock.noteGet.mockResolvedValue(board({ rev: 7, scene: serverScene, updatedBy: 'bob@greensglobal.com' }));
      apiMock.noteUpdate.mockResolvedValue(board({ rev: 8 }));
      render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
      await screen.findByTestId('board-stub');
      await act(async () => { vi.advanceTimersByTime(900); });
      await waitFor(() => expect(apiMock.noteUpdate).toHaveBeenCalledTimes(1));
      const sent = apiMock.noteUpdate.mock.calls[0][1];
      expect(sent.rev).toBe(7);
      expect(sent).not.toHaveProperty('body');
      const saved = JSON.parse(sent.scene);
      expect(saved.elements.map((e) => e.id).sort()).toEqual(['a', 'd', 's']);
      expect(saved.elements.find((e) => e.id === 'a')).toMatchObject({ version: 5, x: 99 });
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
    expect(within(sheet).getByRole('button', { name: 'Close Board' })).toBeTruthy();
  });

  it('the bar has ONE + New, its menu starts a note, a board, a template or an import - on a phone too', async () => {
    window.matchMedia = (q) => ({ matches: q === '(max-width: 768px)', media: q, addEventListener() {}, removeEventListener() {} });
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    await screen.findByText('Budget Review');
    expect(screen.queryByRole('button', { name: 'New Board' })).toBeNull();
    expect(screen.queryByRole('button', { name: /From Template/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull();
    const btn = screen.getByRole('button', { name: 'New' });
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(btn);
    const rows = (await screen.findAllByRole('menuitem')).map((r) => r.querySelector('.nt-new-label').textContent);
    expect(rows).toEqual(['Note', 'Board', 'Note From a Template...', 'Import a File...']);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Board/ }));
    expect(await screen.findByRole('dialog', { name: 'New Board' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('today is lit gently and keeps its place even before a note is written in it; other days stay as they are', async () => {
    const d = new Date(); d.setDate(d.getDate() - 3);
    const earlier = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    apiMock.notesList.mockResolvedValue({ notes: [note({ day: earlier })], counts: { all: 1 }, tags: [] });
    apiMock.noteCreate.mockResolvedValue(note({ id: 'note_new', title: '' }));
    render(<NotesPage activeSub="notes" onSubChange={vi.fn()} />);
    await screen.findByText('Budget Review');
    const sections = [...document.querySelectorAll('.nt-list section')];
    expect(sections.map((x) => x.classList.contains('is-today'))).toEqual([true, false]);
    expect(sections[0].getAttribute('aria-current')).toBe('date');
    expect(sections[0].textContent).toContain('Nothing written today yet.');
    fireEvent.click(within(sections[0]).getByRole('button', { name: 'Start a Note' }));
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledWith(expect.objectContaining({ day: TODAY })));
  });

  it('Back closes the sheet and puts the list\'s address in place of the note\'s (no loop back into the note)', async () => {
    window.matchMedia = (q) => ({ matches: q === '(max-width: 768px)', media: q, addEventListener() {}, removeEventListener() {} });
    window.history.replaceState({ depth: 1 }, '', '/dashboard/notes:board_1');
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes:board_1" onSubChange={onSubChange} />);
    await screen.findByRole('dialog', { name: 'Board' });
    // the sheet pushed its own entry; Back pops it
    expect(window.history.state?.nxSheet).toBeTruthy();
    await act(async () => { window.history.back(); });
    // Wait for the pop instead of a fixed 20 ms (flaky under full-suite load).
    await waitFor(() => expect(onSubChange).toHaveBeenLastCalledWith('notes'));
    await waitFor(() => expect(window.location.pathname).toBe('/dashboard/notes'));
  });
});

describe('New Board elsewhere asks the same question', () => {
  it('Quick Note opens Notes with the template question, making nothing yet', async () => {
    apiMock.noteDaily.mockResolvedValue({ note: null });
    const onClose = vi.fn();
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    try {
      render(<QuickNotePanel onClose={onClose} />);
      fireEvent.click(await screen.findByRole('button', { name: /New Board/ }));
      await waitFor(() => expect(nav).toHaveBeenCalled());
      expect(nav.mock.calls[0][0].detail).toEqual({ view: 'dashboard', sub: 'notes:new-board' });
      expect(apiMock.noteCreate).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    } finally { window.removeEventListener('nexus:navigate', nav); }
  });

  it('the Dashboard tile offers New Board (to the question) and shows a board with its picture', async () => {
    apiMock.notesList.mockResolvedValue({ notes: [board()], counts: { all: 1 }, tags: [] });
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    try {
      render(<NotesWidget config={{}} saveConfig={vi.fn()} canSaveConfig />);
      expect(await screen.findByText('Yard Layout')).toBeTruthy();
      expect(document.querySelector('img.nt-row-thumb')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /New Board/ }));
      await waitFor(() => expect(nav).toHaveBeenCalled());
      expect(nav.mock.calls[0][0].detail).toEqual({ view: 'dashboard', sub: 'notes:new-board' });
      expect(apiMock.noteCreate).not.toHaveBeenCalled();
    } finally { window.removeEventListener('nexus:navigate', nav); }
  });

  it('Quick Actions\' New Board goes to the same question', async () => {
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    try {
      await ACTIONS.find((it) => it.key === 'board').run();
      expect(nav.mock.calls[0][0].detail).toEqual({ view: 'dashboard', sub: 'notes:new-board' });
      expect(apiMock.noteCreate).not.toHaveBeenCalled();
    } finally { window.removeEventListener('nexus:navigate', nav); }
  });

  it('Notes opened at notes:new-board shows the template picker; closing it settles on the list', async () => {
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes:new-board" onSubChange={onSubChange} />);
    const picker = await screen.findByRole('dialog', { name: 'New Board' });
    expect(apiMock.noteGet).not.toHaveBeenCalledWith('new-board');
    expect(apiMock.noteCreate).not.toHaveBeenCalled();
    fireEvent.keyDown(picker, { key: 'Escape' });
    await waitFor(() => expect(onSubChange).toHaveBeenCalledWith('notes'));
  });

  it('picking a template at notes:new-board makes the board and opens it', async () => {
    apiMock.noteCreate.mockResolvedValue(board({ id: 'board_5', title: '', scene: '', thumbUrl: '' }));
    const onSubChange = vi.fn();
    render(<NotesPage activeSub="notes:new-board" onSubChange={onSubChange} />);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'New Board' })).getByRole('button', { name: /^Grid/ }));
    await waitFor(() => expect(apiMock.noteCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'board', templateKey: 'grid' })));
    await waitFor(() => expect(onSubChange).toHaveBeenLastCalledWith('notes:board_5'));
  });
});

describe('A markup board\'s way back', () => {
  const SRC = { kind: 'ticket', id: 't_1', label: 'Ticket #4 Leak', url: '/tickets?ticket=t_1' };
  it('Attach to <ticket> and Open <ticket> sit in the header beside More, and Attach posts a PNG back', async () => {
    apiMock.noteGet.mockResolvedValue(board({ source: SRC }));
    apiMock.attachMarkup.mockResolvedValue({ id: 'att_1' });
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'stub-api' }));
    const open = screen.getByRole('link', { name: 'Open Ticket #4 Leak' });
    expect(open.getAttribute('href')).toBe('/tickets?ticket=t_1');
    const attach = screen.getByRole('button', { name: 'Attach to Ticket #4 Leak' });
    expect(attach.className).toContain('is-primary');
    await act(async () => { fireEvent.click(attach); });
    await waitFor(() => expect(apiMock.attachMarkup).toHaveBeenCalledTimes(1));
    expect(exportMock.exportPng).toHaveBeenCalledWith({ fake: true }, { scale: 2, background: true });
    expect(storeTaskFile.mock.calls.at(-1)[2]).toBe('notes/boards/board_1');
    expect(apiMock.attachMarkup).toHaveBeenCalledWith(SRC, expect.objectContaining({ name: 'Yard Layout.png' }));
    expect(await screen.findByText('Attached to Ticket #4 Leak')).toBeTruthy();
  });

  it('a walkthrough or file source has no Attach; a link that is not ours has no Open', async () => {
    apiMock.noteGet.mockResolvedValue(board({ source: { kind: 'walkthrough', id: 'p1', label: 'Walkthrough: lobby', url: '//evil.example/tickets' } }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    expect(screen.queryByRole('button', { name: /^Attach to/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Open / })).toBeNull();
  });

  it('a file source with a Nexus link offers Open only', async () => {
    apiMock.noteGet.mockResolvedValue(board({ source: { kind: 'file', id: 'f1', label: 'floor.png', url: '/tasks?task=k1' } }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    expect(screen.getByRole('link', { name: 'Open floor.png' }).getAttribute('href')).toBe('/tasks?task=k1');
    expect(screen.queryByRole('button', { name: /^Attach to/ })).toBeNull();
  });
});

describe('Board saves the server refused, thumbnails, history', () => {
  it('a 413 shows the server\'s own sentence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiMock.noteUpdate.mockRejectedValue(Object.assign(new Error('The board is too large to save (2 MB at most).'), { status: 413, detail: 'The board is too large to save (2 MB at most).' }));
      render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
      await screen.findByTestId('board-stub');
      fireEvent.click(screen.getByRole('button', { name: 'stub-draw' }));
      await act(async () => { vi.advanceTimersByTime(900); });
      expect(await screen.findByText(/The board is too large to save \(2 MB at most\)\./)).toBeTruthy();
      expect(screen.queryByText(/retrying when you type/)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('the same thumbnail picture twice is uploaded once', async () => {
    apiMock.noteUpdate.mockResolvedValue(board({ rev: 4 }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'stub-thumb' }));
    await waitFor(() => expect(storeTaskFile).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    fireEvent.click(screen.getByRole('button', { name: 'stub-thumb' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(storeTaskFile).toHaveBeenCalledTimes(1);
  });

  it('a board\'s Version History lists shapes and dates, says the drawing comes back on Restore, and reads the one version only then', async () => {
    apiMock.noteVersions.mockResolvedValue([
      { id: 'v2', title: 'Yard Layout', body: '', rev: 5, savedBy: 'bob@greensglobal.com', createdAt: '2026-10-30T15:00:00Z', words: 0, shapes: 4 },
      { id: 'v1', title: 'Yard Layout', body: '', rev: 2, savedBy: 'neil@greensglobal.com', createdAt: '2026-10-29T15:00:00Z', words: 0, shapes: 1 },
    ]);
    apiMock.noteVersionGet.mockResolvedValue({ id: 'v2', scene: SCENE, shapes: 4 });
    apiMock.noteRestoreVersion.mockResolvedValue(board({ rev: 9 }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Version History/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Version History' });
    expect((await within(dlg).findAllByText(/4 shapes/)).length).toBeGreaterThan(0);
    expect(within(dlg).getByText(/· 1 shape$/)).toBeTruthy();
    expect(within(dlg).getByText('A board version keeps the drawing; restore it to see it.')).toBeTruthy();
    expect(within(dlg).queryByText(/words/)).toBeNull();
    expect(apiMock.noteVersionGet).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole('button', { name: /Restore This Version/ }));
    await waitFor(() => expect(apiMock.noteRestoreVersion).toHaveBeenCalledWith('board_1', 'v2'));
    expect(apiMock.noteVersionGet).toHaveBeenCalledWith('board_1', 'v2');
  });

  it('a version that is not a board is refused before restoring', async () => {
    apiMock.noteVersions.mockResolvedValue([{ id: 'v1', title: 'x', body: '', rev: 2, savedBy: 'neil@greensglobal.com', createdAt: '2026-10-29T15:00:00Z', words: 0, shapes: 1 }]);
    apiMock.noteVersionGet.mockResolvedValue({ id: 'v1', scene: '{"type":"something-else"}' });
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Version History/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Version History' });
    fireEvent.click(await within(dlg).findByRole('button', { name: /Restore This Version/ }));
    expect(await within(dlg).findByText(/could not be read as a board/)).toBeTruthy();
    expect(apiMock.noteRestoreVersion).not.toHaveBeenCalled();
  });
});

describe('A shared board draws together', () => {
  it('turns the live session on for a board shared with Can Edit and shows who is drawing', async () => {
    apiMock.noteGet.mockResolvedValue(board({ shared: true, sharedWith: [{ email: 'bob@greensglobal.com', can: 'edit' }] }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    const calls = boardCollabMock.useBoardCollab.mock.calls.map((c) => c[0]);
    expect(calls.at(-1)).toMatchObject({ enabled: true, canEdit: true });
    expect(calls.at(-1).note.id).toBe('board_1');
    expect(await screen.findByText(/Bob Brown is editing/)).toBeTruthy();
    expect(screen.getByText(/· Live/)).toBeTruthy();
  });

  it('stays off for a private board and for a board shared to read', async () => {
    apiMock.noteGet.mockResolvedValue(board());
    const { unmount } = render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    expect(boardCollabMock.useBoardCollab.mock.calls.at(-1)[0].enabled).toBe(false);
    unmount();
    apiMock.noteGet.mockResolvedValue(board({ mine: false, can: 'read', owner: 'bob@greensglobal.com', shared: true }));
    render(<NotesPage activeSub="notes:board_1" onSubChange={vi.fn()} />);
    await screen.findByTestId('board-stub');
    expect(boardCollabMock.useBoardCollab.mock.calls.at(-1)[0].enabled).toBe(false);
  });
});

describe('Insert Board in the note editor', () => {
  it('lists the person\'s boards and inserts the picked one as a boardEmbed', async () => {
    const { default: NoteEditor } = await import('./NoteEditor');
    apiMock.notesList.mockResolvedValue({ notes: [note(), board({ id: 'note_b7', title: 'Yard Layout' }), board({ id: 'note_b8', title: 'Trashed', trashedAt: '2026-11-01' })], counts: {}, tags: [] });
    const onChange = vi.fn();
    render(<NoteEditor value="<p>Hello</p>" onChange={onChange} people={[]} />);
    fireEvent.mouseDown(screen.getByRole('button', { name: /Insert Board/ }));
    const picker = await screen.findByRole('dialog', { name: 'Insert Board' });
    expect(await within(picker).findByText('Yard Layout')).toBeTruthy();
    expect(within(picker).queryByText('Trashed')).toBeNull();
    expect(within(picker).queryByText('Budget Review')).toBeNull();
    fireEvent.click(within(picker).getByText('Yard Layout'));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const html = onChange.mock.calls.at(-1)[0];
    expect(html).toContain('data-type="boardEmbed"');
    expect(html).toContain('data-note="note_b7"');
    expect(screen.queryByRole('dialog', { name: 'Insert Board' })).toBeNull();
  });
});

describe('The board picker', () => {
  it('lists the person\'s own boards first and marks one shared with them', async () => {
    const { default: BoardPicker } = await import('./board/BoardPicker');
    apiMock.notesList.mockResolvedValue({ notes: [
      board({ id: 'b_shared', title: 'Bob Plan', mine: false, owner: 'bob@greensglobal.com' }),
      board({ id: 'b_mine', title: 'My Plan' }),
    ], counts: {}, tags: [] });
    render(<BoardPicker onClose={vi.fn()} onPick={vi.fn()} />);
    const picker = await screen.findByRole('dialog', { name: 'Insert Board' });
    await within(picker).findByText('My Plan');
    const titles = within(picker).getAllByRole('button').filter((b) => b.closest('li')).map((b) => b.textContent);
    expect(titles[0]).toContain('My Plan');
    expect(titles[1]).toContain('Bob Plan');
    expect(titles[1]).toContain('Shared with you');
    expect(titles[0]).not.toContain('Shared with you');
  });

  it('on a phone it is a bottom sheet over the note, and the overlay closes it', async () => {
    const { default: BoardPicker } = await import('./board/BoardPicker');
    apiMock.notesList.mockResolvedValue({ notes: [board()], counts: {}, tags: [] });
    const onClose = vi.fn();
    const { container } = render(<div><BoardPicker phone onClose={onClose} onPick={vi.fn()} /></div>);
    const picker = await screen.findByRole('dialog', { name: 'Insert Board' });
    expect(picker.classList.contains('is-sheet')).toBe(true);
    expect(container.contains(picker)).toBe(false);          // portaled to the body, not inside the editor
    fireEvent.pointerDown(document.querySelector('.nt-board-pick-overlay'));
    expect(onClose).toHaveBeenCalled();
  });
});
