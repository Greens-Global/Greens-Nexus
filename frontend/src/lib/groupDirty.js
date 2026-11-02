import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

// One save pattern for Settings (Oct 23 2026): a form inside a setting group
// keeps a draft and says, through this, whether it holds unsaved changes.
// The Settings shell (views/AdminConsole.jsx) binds the context to one
// group, collects every dirty group, and asks before the subject, the
// scope or the top tab changes - and tells lib/dialogGuard.js, so leaving
// the module or closing the tab asks too. Outside Settings (a panel reused
// in a modal or on its own screen) there is no provider and this is a no-op.
//
// Several forms may sit in one group (the Ticket Manager's tabs, a company
// page's tabs): each hook is its own reporter, and the group is dirty while
// ANY of them is - a clean form mounting never clears another's flag.
//
// `save` (optional): how the form saves its draft, for the prompt's Save and
// Leave. It must resolve `true` once everything saved and anything else
// (false, a throw) when it did not - the person then stays on the page. The
// prompt offers Save and Leave only when every dirty form gave one.
export const GroupDirtyContext = createContext(null);

// The shell's reporter for one group (a context value): `onChange(dirty,
// saves)` hears the group's state - `saves` lists each dirty form's save,
// null for a form without one. Callers that report a plain boolean
// (`report(dirty)`, the company page's onDirtyChange) share one slot.
const LONE = Symbol('lone');
export function makeGroupReporter(onChange) {
  const dirty = new Map();   // reporter -> save | null
  return (isDirty, who = LONE, save = null) => {
    const had = dirty.has(who);
    const was = dirty.get(who);
    if (isDirty) dirty.set(who, save || null); else dirty.delete(who);
    if (had === dirty.has(who) && was === dirty.get(who)) return;
    onChange(dirty.size > 0, [...dirty.values()]);
  };
}

// Run every save of the dirty forms; true only when each one said it saved.
export async function saveAll(saves) {
  if (!saves.length || saves.some(s => typeof s !== 'function')) return false;
  try {
    const results = await Promise.all(saves.map(s => s()));
    return results.every(r => r === true);
  } catch {
    return false;
  }
}

export function useGroupDirty(dirty, save) {
  const report = useContext(GroupDirtyContext);
  const who = useMemo(() => Symbol('form'), []);
  const saveRef = useRef(save);
  useLayoutEffect(() => { saveRef.current = save; });
  const canSave = typeof save === 'function';
  const stableSave = useMemo(() => (canSave ? () => saveRef.current?.() : null), [canSave]);
  useEffect(() => { report?.(!!dirty, who, stableSave); }, [report, dirty, who, stableSave]);
  // Unmounting (the subject changed, the panel reloaded) clears this form's flag only.
  useEffect(() => () => report?.(false, who), [report, who]);
}
