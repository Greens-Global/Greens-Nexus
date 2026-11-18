// Open a task's drawer from anywhere (11/15/2026: the phone's "Task Added"
// message - tasks/TaskCreate.jsx). When the Tasks module is on screen its
// `nexus:open-task` listener (views/Tasks.jsx) takes the event and marks it
// handled, and nothing moves: the drawer opens over the page you are on.
// Otherwise the module is opened on My Tasks with the id left for it
// (lib/pendingOpen.js), the same handoff the bell and search use.
import { setPendingOpen } from '../lib/pendingOpen';

export function openTaskAnywhere(taskId) {
  if (!taskId) return;
  const detail = { taskId };
  window.dispatchEvent(new CustomEvent('nexus:open-task', { detail }));
  if (detail.handled) return;
  setPendingOpen('task', taskId);
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub: 'mine' } }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:open-task', { detail: { taskId } })), 0);
}

/** A row that shows the new task lights up for a moment (style.css .nx-just-added). */
export function flashTaskRow(taskId) {
  if (!taskId || typeof document === 'undefined') return;
  const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(taskId) : String(taskId).replace(/["\\]/g, '\\$&');
  const sel = `[data-row-id="${id}"], [data-myday-row="${id}"], [data-task-line="${id}"]`;
  const light = () => document.querySelectorAll(sel).forEach((el) => {
    if (el.classList.contains('nx-just-added')) return;
    el.classList.add('nx-just-added');
    setTimeout(() => el.classList.remove('nx-just-added'), 2000);
  });
  // The list draws the new row a beat after the save answers.
  [60, 400, 1000].forEach((ms) => setTimeout(light, ms));
}
