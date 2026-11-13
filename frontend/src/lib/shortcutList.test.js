import { describe, it, expect } from 'vitest';
import { shortcutGroups, allShortcuts, keysText, NEW_TASK_KEYS } from './shortcutList';
import { ACTIONS } from './quickCreate';
import { quickNoteKeys, isQuickNoteKey } from '../notes/notesModel';
import { isSearchShortcut, isFindShortcut } from './keys';

// Help > Keyboard Shortcuts (11/13/2026) lists only shortcuts that exist.
// Where the shortcut has data or a predicate of its own, the row is pinned
// to it here - a shortcut that changes or goes fails this file.
const row = (label, opts) => allShortcuts(opts).find((r) => r.label === label);
const key = (init) => ({ key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: document.body, ...init });

describe('shortcutGroups', () => {
  it('is grouped, Everywhere first, and every row says what it does and how', () => {
    const groups = shortcutGroups({ mac: false });
    expect(groups.map((g) => g.title)).toEqual(['Everywhere', 'Tasks', 'Tickets', 'Lists Inside a Screen']);
    for (const g of groups) {
      expect(g.rows.length, g.title).toBeGreaterThan(0);
      for (const r of g.rows) {
        expect(r.label, g.title).toBeTruthy();
        expect(!!(r.keys?.length) !== !!r.where, r.label).toBe(true);   // keys, or a place to click - never both, never neither
        expect(r.label).not.toMatch(/—/);                            // no em dashes
      }
    }
    const labels = allShortcuts({ mac: false }).map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('shows Ctrl on Windows and Cmd on a Mac', () => {
    expect(row('Search Nexus', { mac: false }).keys).toEqual(['Ctrl+K', '/']);
    expect(row('Search Nexus', { mac: true }).keys).toEqual(['Cmd+K', '/']);
    expect(row('Every shortcut in a document', { mac: true }).keys).toEqual(['Cmd+/']);
    expect(keysText('Mod+Alt+M', false)).toBe('Ctrl+Alt+M');
    expect(keysText('Mod+Alt+M', true)).toBe('Cmd+Option+M');
  });
});

describe('each listed shortcut is the real one', () => {
  it('Search: Ctrl/Cmd+K and "/" (lib/keys.js isSearchShortcut), Ctrl/Cmd+F (isFindShortcut)', () => {
    expect(isSearchShortcut(key({ key: 'k', ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(key({ key: 'k', metaKey: true }))).toBe(true);
    expect(isSearchShortcut(key({ key: '/' }))).toBe(true);
    expect(isFindShortcut(key({ key: 'f', ctrlKey: true }))).toBe(true);
    expect(row('Search Nexus, when the screen has no find of its own', { mac: false }).keys).toEqual(['Ctrl+F']);
  });

  it('New Task: the keys on Quick Actions\' own task row', () => {
    expect(ACTIONS.find((a) => a.key === 'task')?.keys).toBe(NEW_TASK_KEYS);
    expect(row('New Task').keys).toEqual(['C then T']);
  });

  it('Quick Note: what Notes itself says, and the key it listens for', () => {
    expect(row('Quick Note').keys).toEqual([quickNoteKeys()]);
    expect(quickNoteKeys()).toBe('Ctrl+Alt+N');                         // jsdom is not a Mac
    expect(isQuickNoteKey(key({ key: 'n', ctrlKey: true, altKey: true }))).toBe(true);
  });

  it('Help is "?" and Esc closes', () => {
    expect(row('Open or close Help').keys).toEqual(['?']);
    expect(row('Close a popup, a menu or Help').keys).toEqual(['Esc']);
  });

  it('the long lists are pointed to, not copied', () => {
    const lists = shortcutGroups({ mac: false }).find((g) => g.title === 'Lists Inside a Screen').rows;
    expect(lists.map((r) => r.label)).toEqual(['Every shortcut in a document', 'Every shortcut in a sheet',
      'The Approvals shortcuts', 'The Notes shortcuts', 'The Shift Planner shortcuts']);
    expect(allShortcuts().length).toBeLessThan(20);                     // compact
  });
});
