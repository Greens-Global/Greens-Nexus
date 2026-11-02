// Starting a Board (Notes whiteboard, Neil 11/02/2026) from anywhere New Note
// exists: the Notes page, the + menu, Quick Note and the Dashboard tile - all
// of them through the Notes page's template question (NEW_BOARD_SUB).
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

/** The sub that opens Notes with the New Board question up (NotesPage). */
export const NEW_BOARD_SUB = 'notes:new-board';

/** New Board from anywhere (the + menu, Quick Note, the Dashboard tile):
 *  Notes opens and asks what to start from - the same question the Notes
 *  page's own New Board asks (board/TemplatePicker.jsx); nothing is made
 *  until a template is picked. */
export function newBoardFromAnywhere() {
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'dashboard', sub: NEW_BOARD_SUB } }));
}
