// A document or sheet starts with no name (Neil, 11/10/2026: "create a
// document or a sheet without requiring a name - you should still have to
// name it at the end before closing it"). It is stored as "Untitled Document"
// / "Untitled Sheet" - the server needs a title and the list must show
// something - and the editors ask for a real name on Close while it still
// reads like this. One rule, read by the list and both editors.
export const UNTITLED_DOCUMENT = 'Untitled Document';
export const UNTITLED_SHEET = 'Untitled Sheet';

export function isUntitled(title) {
  const t = String(title ?? '').trim();
  return !t || /^untitled (document|sheet)(\s*\(\d+\))?$/i.test(t);
}

// A first guess at a name: the first line of text, up to 60 characters,
// cut at a word. '' when there is no text worth using.
export function suggestName(text) {
  const line = String(text ?? '').split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).find((l) => /[A-Za-z0-9]/.test(l)) || '';
  if (line.length <= 60) return line.replace(/[.:;,\s]+$/, '');
  const cut = line.slice(0, 60);
  const sp = cut.lastIndexOf(' ');
  return (sp > 30 ? cut.slice(0, sp) : cut).replace(/[.:;,\s]+$/, '');
}

// The question both editors ask on Close. Resolves to the new name, or null
// when the person chose Keep Editing.
export async function askForName(dialog, { kind = 'document', suggestion = '' } = {}) {
  const what = kind === 'sheet' ? 'Sheet' : 'Document';
  const name = await dialog.prompt(`Give this ${what.toLowerCase()} a name before you close it, so it is easy to find in Files.`, {
    title: `Name This ${what}`,
    defaultValue: suggestion,
    placeholder: kind === 'sheet' ? 'e.g. Q3 Budget' : 'e.g. Vendor Agreement',
    required: true,
    confirmText: 'Save & Close',
    cancelText: 'Keep Editing',
  });
  const t = String(name ?? '').trim();
  return t && !isUntitled(t) ? t.slice(0, 200) : null;
}
