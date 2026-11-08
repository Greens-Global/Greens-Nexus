// Sheets: the keyboard shortcuts (Excel's, with Cmd for Ctrl on a Mac). The
// help dialog lists this table; keyId() is how SheetEditor matches a key.

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** A key press as 'Mod+Shift+Digit4' / 'Alt+Equal' / 'Shift+F2' / 'Mod+KeyC'. */
export function keyId(e) {
  const code = e.code || '';
  let k;
  if (/^(Key|Digit)/.test(code) || ['Minus', 'Equal', 'Semicolon', 'Backquote', 'Slash', 'Space', 'Backslash', 'Period', 'Comma'].includes(code)) k = code;
  else if (/^[a-z]$/i.test(e.key || '')) k = 'Key' + e.key.toUpperCase();
  else if (/^\d$/.test(e.key || '')) k = 'Digit' + e.key;
  else k = e.key === ' ' ? 'Space' : e.key;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}

/** What a shortcut is called on this computer: Ctrl on Windows, Cmd and Option on a Mac. */
export const keyLabel = (keys, mac = isMac) => keys.replace(/Ctrl/g, mac ? 'Cmd' : 'Ctrl').replace(/Alt/g, mac ? 'Option' : 'Alt');

export const SHORTCUTS = [
  ['Edit', [
    ['Ctrl+C', 'Copy'], ['Ctrl+X', 'Cut'], ['Ctrl+V', 'Paste'], ['Ctrl+Shift+V', 'Paste Values Only'],
    ['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Redo'], ['Ctrl+Shift+Z', 'Redo'],
    ['F2', 'Edit the Cell'], ['Esc', 'Cancel Editing'], ['Enter', 'Save and Move Down'], ['Tab', 'Save and Move Right'],
    ['Alt+Enter', 'New Line in the Cell'], ['Ctrl+Enter', 'Fill the Selection With the Entry'],
    ['Ctrl+D', 'Fill Down'], ['Ctrl+R', 'Fill Right'], ['Delete', 'Clear the Cells'],
    ['Ctrl+;', "Insert Today's Date"], ['Ctrl+Shift+;', 'Insert the Time'],
    ['F4', 'Cycle $ in a Reference (While Editing a Formula)'], ['Alt+=', 'AutoSum'],
  ]],
  ['Move and Select', [
    ['Arrows', 'Move'], ['Shift+Arrows', 'Extend the Selection'], ['Ctrl+Arrows', 'Jump to the Edge of the Data'],
    ['Ctrl+Shift+Arrows', 'Extend to the Edge of the Data'], ['Ctrl+A', 'Select All'], ['Ctrl+Space', 'Select the Column'],
    ['Shift+Space', 'Select the Row'], ['Ctrl+Home', 'Go to A1'], ['Ctrl+End', 'Go to the Last Cell With Data'],
    ['Home', 'Start of the Row'], ['Page Up / Page Down', 'Move One Screen'],
    ['Ctrl+Page Up / Ctrl+Page Down', 'Previous / Next Tab'], ['Alt+Up / Alt+Down', 'Previous / Next Tab'], ['Shift+F11', 'New Tab'],
  ]],
  ['Format', [
    ['Ctrl+B', 'Bold'], ['Ctrl+I', 'Italic'], ['Ctrl+U', 'Underline'], ['Ctrl+5', 'Strikethrough'], ['Ctrl+1', 'Format Cells'],
    ['Ctrl+Shift+$', 'Currency'], ['Ctrl+Shift+%', 'Percent'], ['Ctrl+Shift+#', 'Date'], ['Ctrl+Shift+@', 'Time'],
    ['Ctrl+Shift+!', 'Number'], ['Ctrl+Shift+~', 'Automatic'], ['Ctrl+Shift+&', 'Outline Border'], ['Ctrl+Shift+_', 'Remove Borders'],
  ]],
  ['Rows, Columns and Data', [
    ['Ctrl+Shift+=', 'Insert Rows or Columns'], ['Ctrl+-', 'Delete Rows or Columns'],
    ['Ctrl+9', 'Hide Rows'], ['Ctrl+Shift+9', 'Unhide Rows'], ['Ctrl+0', 'Hide Columns'], ['Ctrl+Shift+0', 'Unhide Columns'],
    ['Ctrl+Shift+L', 'Turn the Filter On or Off'], ['Ctrl+K', 'Insert a Link'], ['Ctrl+Alt+M', 'Insert a Note'], ['Shift+F2', 'Edit the Note'],
  ]],
  ['Find and View', [
    ['Ctrl+F', 'Find'], ['Ctrl+H', 'Find and Replace'], ['Ctrl+`', 'Show Formulas'], ['Ctrl+/', 'Keyboard Shortcuts'],
  ]],
];
