import { describe, it, expect } from 'vitest';
import { taskExportRows, EMPTY_FILTER } from './lib';

// Exporting a task list. The list nests subtasks under an expandable parent, so
// the visible rows are top-level only - and the first cut of Export inherited
// that, producing a file with every subtask missing (Neil, Sept 8). A dropped
// subtask on screen is a collapsed row; in a spreadsheet it is missing work.

const T = (id, over = {}) => ({ id, title: id, status: 'not_started', priority: 'medium', ...over });
const parent = T('Rewire keypad');
const kid1 = T('Order parts', { parentTaskId: 'Rewire keypad' });
const kid2 = T('Book electrician', { parentTaskId: 'Rewire keypad', status: 'completed', completed: true });
const grandkid = T('Collect quote', { parentTaskId: 'Order parts' });
const loner = T('File taxes');
const ALL = [parent, kid1, kid2, grandkid, loner];

const shape = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.task.id}`);

describe('taskExportRows', () => {
  it('follows a visible parent down to its subtasks and theirs', () => {
    expect(shape(taskExportRows([parent], ALL, EMPTY_FILTER, null)))
      .toEqual(['Rewire keypad', '  Order parts', '    Collect quote', '  Book electrician']);
  });

  it('names each row parent, since a spreadsheet loses the indent when sorted', () => {
    const rows = taskExportRows([parent], ALL, EMPTY_FILTER, null);
    expect(rows.find((r) => r.task.id === 'Collect quote').parent.id).toBe('Order parts');
    expect(rows.find((r) => r.task.id === 'Rewire keypad').parent).toBeNull();
  });

  it('leaves a task with no subtasks exactly as it was', () => {
    expect(shape(taskExportRows([loner], ALL, EMPTY_FILTER, null))).toEqual(['File taxes']);
  });

  it('applies the same filter to subtasks as to their parents', () => {
    // Filtered to "not started": the completed subtask must not ride along just
    // because its parent matched.
    const filter = { ...EMPTY_FILTER, statuses: ['not_started'] };
    expect(shape(taskExportRows([parent], ALL, filter, null)))
      .toEqual(['Rewire keypad', '  Order parts', '    Collect quote']);
  });

  it('never lists a task twice when it is both visible and a subtask', () => {
    // A search flattens the list, so a parent AND its child can both be visible.
    const rows = taskExportRows([parent, kid1], ALL, EMPTY_FILTER, null);
    expect(rows.filter((r) => r.task.id === 'Order parts')).toHaveLength(1);
  });

  it('does not hang on a cyclically parented task', () => {
    const a = T('A', { parentTaskId: 'B' });
    const b = T('B', { parentTaskId: 'A' });
    expect(taskExportRows([a], [a, b], EMPTY_FILTER, null).length).toBeLessThanOrEqual(2);
  });
});
