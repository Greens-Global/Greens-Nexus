import { describe, it, expect } from 'vitest';
import { ACTIONS, GROUPS, TOP, TOP_FILL, layoutActions } from './quickCreate';

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
