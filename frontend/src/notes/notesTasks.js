// Make a Task from a note line (Notes, Oct 29 2026) - through the Tasks
// module's own create API, assigned to the writer, and the bell's way of
// opening a task once it exists.
import { api } from '../api';
import { setPendingOpen } from '../lib/pendingOpen';
import { noteTitle } from './notesModel';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function createTaskFrom(text, note, myEmail) {
  const title = (text || '').slice(0, 250);
  const description = note ? `<p>From the note "${esc(noteTitle(note))}".</p>` : '';
  return api.createTask({
    title, description, assignee_emails: myEmail ? [myEmail] : [], status: 'not_started', priority: 'medium', type: 'task',
  });
}

export function openTask(taskId) {
  setPendingOpen('task', taskId);
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub: 'mine' } }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId } })), 0);
}
