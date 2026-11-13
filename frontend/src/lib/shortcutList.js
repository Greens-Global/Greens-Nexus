// The keyboard shortcuts Nexus has, in ONE list (11/13/2026) - what Help >
// Keyboard Shortcuts shows (support/ShortcutsPage.jsx). Nothing here makes a
// key do anything: each row names a shortcut that already exists where its
// `from` says, and shortcutList.test.js pins the ones that have data to pin
// to. Add a row when a shortcut ships; take it out when the shortcut goes.
//
// The long lists stay where they live and are POINTED to, never copied: a
// document, a sheet, the Shift Planner, Notes and Approvals each have their
// own list (the last group says how to open it).
//
// A row: { label, keys: [alternatives], note? }. A key is written with
// "Mod" for Ctrl (Cmd on a Mac) and "Alt" (Option on a Mac); "C then T" is a
// sequence. `where` instead of `keys` is a place to click, for a list with
// no key of its own.
import { quickNoteKeys } from '../notes/notesModel';

// The same test the rest of the app uses (notes/notesModel.js, sheets/shortcuts.js).
export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** "Mod+K" -> "Ctrl+K", or "Cmd+K" on a Mac; "Alt" reads "Option" there. */
export function keysText(keys, mac = isMac()) {
  return String(keys || '').replace(/\bMod\b/g, mac ? 'Cmd' : 'Ctrl').replace(/\bAlt\b/g, mac ? 'Option' : 'Alt');
}

// Quick Actions' New Task (lib/quickCreate.js ACTIONS, `keys` on the task
// row; the listener is components/QuickCreate.jsx). Kept as text here so the
// Help panel does not pull the whole left menu in; the test keeps the two equal.
export const NEW_TASK_KEYS = 'C T';
const sequence = (keys) => String(keys || '').split(' ').join(' then ');

export function shortcutGroups({ mac = isMac() } = {}) {
  const k = (s) => keysText(s, mac);
  return [
    {
      title: 'Everywhere',
      rows: [
        // lib/keys.js isSearchShortcut; TopHeader.jsx
        { label: 'Search Nexus', keys: [k('Mod+K'), '/'], note: 'On a screen with a search box of its own, / goes there.' },
        // lib/keys.js isFindShortcut; TopHeader.jsx
        { label: 'Search Nexus, when the screen has no find of its own', keys: [k('Mod+F')] },
        // support/HelpMenu.jsx
        { label: 'Open or close Help', keys: ['?'] },
        // components/QuickCreate.jsx
        { label: 'New Task', keys: [sequence(NEW_TASK_KEYS)] },
        // notes/notesModel.js isQuickNoteKey / quickNoteKeys
        { label: 'Quick Note', keys: [quickNoteKeys()] },
        // tasks/components.jsx Modal, support/HelpMenu.jsx, the menus
        { label: 'Close a popup, a menu or Help', keys: ['Esc'] },
      ],
    },
    {
      title: 'Tasks',
      rows: [
        // tasks/HomeUpdates.jsx onCardKey
        { label: 'Next or previous update on Tasks Home', keys: ['J', 'K'], note: 'The arrow keys work too.' },
        { label: 'Resolve the comment on the highlighted update', keys: ['E'] },
        // tasks/views/board.jsx
        { label: 'Open the focused card on the Board', keys: ['Enter'] },
      ],
    },
    {
      title: 'Tickets',
      rows: [
        // tickets/TicketsView.jsx (TicketsView.keys.test.jsx)
        { label: 'Highlight the next or previous ticket', keys: ['Down', 'Up'] },
        { label: 'Open the highlighted ticket', keys: ['Enter'] },
      ],
    },
    {
      title: 'Lists Inside a Screen',
      rows: [
        // components/DocumentBuilder.jsx (Help > Keyboard Shortcuts, docRibbon/MenuBar.jsx ShortcutsCard)
        { label: 'Every shortcut in a document', keys: [k('Mod+/')] },
        // sheets/SheetEditor.jsx (sheets/shortcuts.js)
        { label: 'Every shortcut in a sheet', keys: [k('Mod+/')] },
        // approvals/ApprovalsCenter.jsx
        { label: 'The Approvals shortcuts', where: 'The keyboard button on Approvals' },
        // notes/NotesPage.jsx ShortcutsPop
        { label: 'The Notes shortcuts', where: 'The keyboard button at the top of a note' },
        // components/ShiftSchedule.jsx SHORTCUTS, shifts/ScheduleToolbar.jsx
        { label: 'The Shift Planner shortcuts', where: 'Keyboard Shortcuts in the planner\'s menu' },
      ],
    },
  ];
}

/** Every row, flat - for a search or a count. */
export const allShortcuts = (opts) => shortcutGroups(opts).flatMap((g) => g.rows.map((r) => ({ ...r, group: g.title })));
