import { describe, it, expect } from 'vitest';
import { ACTIONS, GROUPS, TOP, TOP_FILL, layoutActions, findActions } from './quickCreate';

// The header's Quick Actions (Neil, 11/12/2026): the list and its layout.
describe('ACTIONS', () => {
  it('offers Fill a Form landing on Workday form:pick, under Request', () => {
    // Forms & Checklists (Neil, 11/02/2026): beside the other asks.
    const row = ACTIONS.find((it) => it.key === 'form');
    expect(row).toMatchObject({ group: 'request', label: 'Fill a Form', module: 'myhr', go: ['timeclock', 'form:pick'] });
  });

  it('keeps three groups, and every action sits in one of them with a way to start', () => {
    expect(GROUPS.map((g) => g.label)).toEqual(['New', 'Request', 'Send']);
    const groups = new Set(GROUPS.map((g) => g.key));
    ACTIONS.forEach((it) => {
      expect(groups.has(it.group), it.key).toBe(true);
      expect(!!(it.compose || it.run || it.go), it.key).toBe(true);
      expect(it.label && it.short, it.key).toBeTruthy();
    });
    expect(new Set(ACTIONS.map((it) => it.key)).size).toBe(ACTIONS.length);
    [...TOP, ...TOP_FILL].forEach((k) => expect(ACTIONS.some((it) => it.key === k), k).toBe(true));
  });

  it('the top row is New Task, New Ticket, New Note, New Board (Neil, 11/12/2026)', () => {
    const { tiles, rows } = layoutActions(ACTIONS);
    expect(tiles.map((t) => t.label)).toEqual(['New Task', 'New Ticket', 'New Note', 'New Board']);
    expect(rows.map((r) => r.label)).toEqual(['New', 'Request', 'Send']);
    expect(rows[1].hint).toBe('Time Off, Reimbursement, Purchase Request, Item, Fill a Form, Time Sheet Fix');
  });

  it('lays out what a person has: the row fills, a group of one is its action, a covered group is left out', () => {
    const only = (...keys) => ACTIONS.filter((it) => keys.includes(it.key));
    // No Tasks: the next thing they can start takes the fourth place.
    expect(layoutActions(only('ticket', 'note', 'board', 'form', 'item')).tiles.map((t) => t.key)).toEqual(['ticket', 'note', 'board', 'form']);
    // New holds nothing the top row does not; Request is one action; Send is a choice.
    const { rows } = layoutActions(only('task', 'ticket', 'note', 'board', 'item', 'email', 'event'));
    expect(rows.map((r) => (r.kind === 'group' ? r.label : r.item.label))).toEqual(['Request an Item', 'Send']);
    // Four or fewer actions: the top row is the whole menu.
    expect(layoutActions(only('note', 'board', 'email')).rows).toEqual([]);
    expect(layoutActions([])).toEqual({ tiles: [], rows: [] });
  });
});

// The header search answers with the same actions (11/13/2026).
describe('findActions', () => {
  const labels = (q, items = ACTIONS) => findActions(items, q).map((h) => h.item.label);

  it('names an action by the words of its name, whatever their order or case', () => {
    expect(labels('time off')).toEqual(['Request Time Off']);
    expect(labels('Off Time')).toEqual(['Request Time Off']);
    expect(labels('new ticket')).toEqual(['New Ticket']);
    expect(labels('kud')).toEqual(['Give Kudos']);
    expect(labels('request item')).toEqual(['Request an Item']);
    expect(labels('event invite')).toEqual(['New Event']);       // its short name counts
  });

  it('is plain: no guesses, no small words, two characters at least, three rows at most', () => {
    expect(labels('expense')).toEqual([]);
    expect(labels('an')).toEqual([]);
    expect(labels('t')).toEqual([]);
    expect(labels('ime')).toEqual([]);                            // a word must START with what was typed
    expect(labels('new')).toEqual(['New Task', 'New Ticket', 'New Note']);   // the menu's own order
    expect(findActions(ACTIONS, 'new', 10).length).toBeGreaterThan(3);
  });

  it('offers only what it is given - the person\'s own actions', () => {
    expect(labels('time off', ACTIONS.filter((it) => it.module !== 'myhr'))).toEqual([]);
    expect(findActions(null, 'time off')).toEqual([]);
  });

  it('`starts` is a typed name gone past its first word', () => {
    const starts = (q) => findActions(ACTIONS, q).filter((h) => h.starts).map((h) => h.item.label);
    expect(starts('new ti')).toEqual(['New Ticket']);
    expect(starts('request time')).toEqual(['Request Time Off']);
    expect(starts('fill a')).toEqual(['Fill a Form']);
    expect(starts('new')).toEqual([]);
    expect(starts('ticket')).toEqual([]);
    expect(starts('time off')).toEqual([]);
    // The ones that start the name sort first.
    expect(findActions(ACTIONS, 'new t').map((h) => [h.item.label, h.starts])).toEqual([['New Task', true], ['New Ticket', true]]);
  });
});
