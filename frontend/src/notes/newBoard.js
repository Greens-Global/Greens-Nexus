// Starting a Board (Notes whiteboard, Neil 11/02/2026) from anywhere New Note
// exists: the Notes page, the + menu, Quick Note and the Dashboard tile.
// A Board is a note of kind 'board' (backend routers/notes.py); it opens on
// Dashboard > Notes like any note. The scene starts empty ('' = a Clean
// board, see board/scene.js); the title is typed on the board.
import { api } from '../api';
import { localDay } from './notesModel';

export const BOARD_THUMB_FOLDER = (noteId) => `notes/boards/${noteId}`;

export async function createBoard(extra = {}) {
  return api.noteCreate({ kind: 'board', title: '', body: '', scene: '', day: localDay(), ...extra });
}

export function openBoard(id) {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'dashboard', sub: id ? `notes:${id}` : 'notes' } }));
}

/** The + menu's New Board: make it, then open it on Notes. Errors are told
 *  through the app's dialog so the menu never swallows a failure. */
export async function newBoardFromAnywhere() {
  try {
    const n = await createBoard();
    openBoard(n.id);
    return n;
  } catch (e) {
    const { dialog } = await import('../ui/dialog');
    dialog.alert(e?.message || 'Could not start a board', { title: 'New Board' });
    return null;
  }
}
