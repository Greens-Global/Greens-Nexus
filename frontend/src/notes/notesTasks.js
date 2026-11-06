// Make a Task from a note line (Notes, Oct 29 2026) - through the Tasks
// module's own create API, assigned to the writer, and the bell's way of
// opening a task once it exists.
import { api } from '../api';
import { setPendingOpen } from '../lib/pendingOpen';
import { noteTitle } from './notesModel';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function createTaskFrom(text, note, myEmail) {
  const title = (text || '').slice(0, 250);
  const description = note ? `<p>From the note "${esc(noteTitle(note))}".</p>` : '';
  const body = {
    title, description, assignee_emails: myEmail ? [myEmail] : [], status: 'not_started', priority: 'medium', type: 'task',
  };
  // A job's meeting note (Round Two item 10): the action item goes into the
  // job's task project - unless the writer may not add work there (or the
  // job has none), then it is their own task as before.
  if (note?.source?.kind === 'construction_job' && note.source.id) {
    const projectId = await api.getConstructionProject(note.source.id).then((p) => p?.taskProjectId || '').catch(() => '');
    if (projectId) {
      try {
        return await api.createTask({ ...body, project_id: projectId });
      } catch (e) {
        if (e?.status !== 403 && e?.status !== 404) throw e;
      }
    }
  }
  return api.createTask(body);
}

export function openTask(taskId) {
  setPendingOpen('task', taskId);
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub: 'mine' } }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId } })), 0);
}
