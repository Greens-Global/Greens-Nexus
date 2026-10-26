import { createContext, useContext, useEffect } from 'react';

// One save pattern for Settings (Oct 23 2026): a form inside a setting group
// keeps a draft and says, through this, whether it holds unsaved changes.
// The Settings shell (views/AdminConsole.jsx) binds the context to one
// group, collects every dirty group, and asks before the subject, the
// scope or the top tab changes - and tells lib/dialogGuard.js, so leaving
// the module or closing the tab asks too. Outside Settings (a panel reused
// in a modal or on its own screen) there is no provider and this is a no-op.
export const GroupDirtyContext = createContext(null);

export function useGroupDirty(dirty) {
  const report = useContext(GroupDirtyContext);
  useEffect(() => { report?.(!!dirty); }, [report, dirty]);
  // Unmounting (the subject changed, the panel reloaded) clears the flag.
  useEffect(() => () => report?.(false), [report]);
}
