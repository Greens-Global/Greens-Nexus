import { describe, it, expect } from 'vitest';
import { parseTaskLines, isTaskList, importRowsFor, countLabel, linesToText } from './batchPaste';

describe('parseTaskLines', () => {
  it('one task per line, blank lines dropped, bullets stripped', () => {
    const lines = parseTaskLines('- Call the bank\n\n* Ask for the statement\r\n1. File the receipts\n2) Pay the invoice\n[ ] Book the room\n☐ Send the agenda\n- [x] Already done');
    expect(lines.map((l) => l.title)).toEqual([
      'Call the bank', 'Ask for the statement', 'File the receipts', 'Pay the invoice', 'Book the room', 'Send the agenda', 'Already done',
    ]);
    expect(lines.every((l) => l.depth === 0)).toBe(true);
  });

  it('a tab or two spaces under a line is its subtask; deeper folds to one level', () => {
    const lines = parseTaskLines('Launch\n\tWrite the post\n\t\tProofread it\n    Schedule it\nWrap up');
    expect(lines).toEqual([
      { title: 'Launch', depth: 0 }, { title: 'Write the post', depth: 1 }, { title: 'Proofread it', depth: 1 },
      { title: 'Schedule it', depth: 1 }, { title: 'Wrap up', depth: 0 },
    ]);
  });

  it('a list pasted with a common indent is flat, and the first line is never a subtask', () => {
    expect(parseTaskLines('    A\n    B\n    C').map((l) => l.depth)).toEqual([0, 0, 0]);
    expect(parseTaskLines('\tA\nB').map((l) => l.depth)).toEqual([0, 0]);
  });

  it('a bullet under a bullet is a subtask', () => {
    expect(parseTaskLines('- Parent\n  - Child\n- Next')).toEqual([
      { title: 'Parent', depth: 0 }, { title: 'Child', depth: 1 }, { title: 'Next', depth: 0 },
    ]);
  });

  it('a lone bullet with no text is dropped', () => {
    expect(parseTaskLines('-\n- Real')).toEqual([{ title: 'Real', depth: 0 }]);
  });

  it('old-Mac line endings, lettered markers and ticked boxes', () => {
    expect(parseTaskLines('One\rTwo\rThree').map((l) => l.title)).toEqual(['One', 'Two', 'Three']);
    expect(parseTaskLines('a. First\nb) Second\n[x] Third').map((l) => l.title)).toEqual(['First', 'Second', 'Third']);
    // "e.g." is not a marker: the marker needs a space or the end after it.
    expect(parseTaskLines('e.g. Call\nx')[0].title).toBe('e.g. Call');
  });

  it('a long title is sent whole - the server cuts it and says so', () => {
    const long = 'x'.repeat(620);
    expect(parseTaskLines(`${long}\nshort`)[0].title).toHaveLength(620);
  });
});

describe('isTaskList', () => {
  it('needs two lines with text', () => {
    expect(isTaskList('One')).toBe(false);
    expect(isTaskList('One\n\n')).toBe(false);
    expect(isTaskList('One\nTwo')).toBe(true);
    expect(isTaskList('One\r\n\r\nTwo')).toBe(true);
    expect(isTaskList('')).toBe(false);
    // A trailing lone dash (editors leave one) does not make a one-liner a list.
    expect(isTaskList('Call the bank\n-')).toBe(false);
  });
});

describe('importRowsFor', () => {
  const lines = parseTaskLines('Launch\n\tWrite the post\n\tSchedule it\nWrap up\n\tThank everyone');

  it('numbers rows from 1 and names a subtask\'s parent by row number', () => {
    const rows = importRowsFor(lines, {});
    expect(rows.map((r) => [r.row, r.title, r.parent])).toEqual([
      [1, 'Launch', undefined], [2, 'Write the post', '1'], [3, 'Schedule it', '1'], [4, 'Wrap up', undefined], [5, 'Thank everyone', '4'],
    ]);
  });

  it('spreads the shared fields over every row, custom values over top-level rows only', () => {
    const rows = importRowsFor(lines, {
      assigneeIds: ['ana@greensglobal.com', 'ben@greensglobal.com'], dueOn: '2026-11-05', priority: 'high',
      tags: ['Q4'], customFieldValues: { 'f-1': 'Austin' },
    });
    expect(rows[0]).toEqual({ row: 1, title: 'Launch', assignees: 'ana@greensglobal.com, ben@greensglobal.com', due: '2026-11-05', priority: 'high', tags: 'Q4', custom: { 'f-1': 'Austin' } });
    expect(rows[1].custom).toBeUndefined();
    expect(rows[1].assignees).toBe('ana@greensglobal.com, ben@greensglobal.com');
    expect(rows[1].due).toBe('2026-11-05');
  });

  it('hands tags, a start date and a status to every row', () => {
    const rows = importRowsFor(parseTaskLines('A\n\tB'), { tags: ['Q4', 'Ops'], startOn: '2026-11-01', status: 'in_progress' });
    expect(rows[0]).toMatchObject({ tags: 'Q4, Ops', start: '2026-11-01', status: 'in_progress' });
    expect(rows[1]).toMatchObject({ parent: '1', tags: 'Q4, Ops', start: '2026-11-01', status: 'in_progress' });
  });

  it('sends nothing for an empty shared field', () => {
    expect(importRowsFor([{ title: 'A', depth: 0 }], { assigneeIds: [], dueOn: '', tags: [] })).toEqual([{ row: 1, title: 'A' }]);
  });
});

describe('countLabel / linesToText', () => {
  it('reads the count as people say it', () => {
    expect(countLabel([])).toBe('no tasks yet');
    expect(countLabel([{ depth: 0 }])).toBe('1 task');
    expect(countLabel([{ depth: 0 }, { depth: 1 }, { depth: 1 }, { depth: 0 }])).toBe('2 tasks, 2 subtasks');
  });
  it('round-trips through the editable box', () => {
    const lines = parseTaskLines('A\n\tB\nC');
    expect(linesToText(lines)).toBe('A\n\tB\nC');
    expect(parseTaskLines(linesToText(lines))).toEqual(lines);
  });
});
