// Checklist lines that are tasks (Neil, 11/07/2026 - Macro's "any [ ] line can
// be a task"). A checklist item whose own line holds a [[ link to a task is
// that task's box:
//   - ticking or clearing the box in the note completes or reopens the task
//     (the Tasks module's own PATCH, inside the ticker's own rights - a task
//     they may not change says so and the box goes back);
//   - when an editor has the note open, a box whose task was finished or
//     reopened somewhere else is put right (an ordinary edit, saved and
//     shared like typing). A reader sees the boxes as last saved.
import { api } from '../api';
import { splitRef } from './recordLink';

/** The checklist items in `doc` whose own line links a task:
 *  [{ pos, node, taskId }]. A nested item's line is its own, not its parent's. */
export function taskBoxes(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return true;
    const line = node.firstChild;
    let taskId = '';
    line?.forEach?.((child) => {
      if (!taskId && child.type.name === 'recordLink') {
        const { kind, id } = splitRef(child.attrs.ref);
        if (kind === 'task') taskId = id;
      }
    });
    if (taskId) out.push({ pos, node, taskId });
    return true;
  });
  return out;
}

/** A key that changes when the set of task boxes does (not when a box ticks). */
export const boxesKey = (doc) => taskBoxes(doc).map((b) => b.taskId).sort().join(',');

/** Tick or clear each task box to match its task now. `meta` marks the
 *  transaction as the person's edit (so it is saved). Returns how many moved. */
export async function syncBoxesFromTasks(editor, meta) {
  if (!editor || editor.isDestroyed) return 0;
  const ids = [...new Set(taskBoxes(editor.state.doc).map((b) => b.taskId))];
  if (!ids.length) return 0;
  const states = (await api.taskStates(ids).catch(() => null))?.tasks || {};
  if (editor.isDestroyed) return 0;
  const tr = editor.state.tr;
  let moved = 0;
  // Read again: the note may have changed while the states were on their way.
  for (const { pos, node, taskId } of taskBoxes(editor.state.doc)) {
    const s = states[taskId];
    if (!s || !!node.attrs.checked === !!s.done) continue;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !!s.done });
    moved += 1;
  }
  if (moved) editor.view.dispatch(tr.setMeta(meta, true));
  return moved;
}

/** The DOM half: a box ticked by hand in the editor completes its task.
 *  Returns the remover. `onError(message)` shows a refusal; the box goes back. */
export function listenForBoxTicks(editor, meta, onError) {
  const dom = editor?.view?.dom;
  if (!dom) return () => {};
  const onChange = (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
    // The editor draws a checklist item as a bare <li> under its list.
    const li = input.closest('ul[data-type="taskList"] > li');
    const chip = li?.querySelector(':scope > div > p .nt-reclink[data-ref^="task:"]');
    if (!chip) return;
    const taskId = splitRef(chip.getAttribute('data-ref')).id;
    const done = input.checked;
    api.updateTask(taskId, { completed: done }).catch((err) => {
      onError?.(err?.status === 403 || err?.status === 404
        ? 'You cannot change that task, so its box was put back.'
        : `The task did not save: ${err?.message || 'try again'}`);
      if (editor.isDestroyed) return;
      // Put the box back to what the task still is.
      const box = taskBoxes(editor.state.doc).find((b) => b.taskId === taskId && !!b.node.attrs.checked === done);
      if (box) editor.view.dispatch(editor.state.tr.setNodeMarkup(box.pos, undefined, { ...box.node.attrs, checked: !done }).setMeta(meta, true));
    });
  };
  dom.addEventListener('change', onChange);
  return () => dom.removeEventListener('change', onChange);
}
