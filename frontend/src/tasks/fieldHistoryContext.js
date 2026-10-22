// Field history (Oct 22 2026) - what the drawer shares with its field rows.
import { createContext, useMemo } from 'react';
import { useTasks } from './TasksContext';

/** { taskId, nameOf } of the drawer's task - each row's clock only names its field. */
export const FieldHistoryContext = createContext(null);

/** The lookups a change's values are read through (fieldHistory.historyValueParts). */
export function useHistoryCtx(nameOf) {
  const { statusMeta = {}, customFields = [], projects = [], projectName } = useTasks() || {};
  return useMemo(() => {
    const byId = new Map((projects || []).map((p) => [p.id, p.name]));
    return { nameOf, statusMeta, customFields, projectName: (id) => (projectName && projectName(id)) || byId.get(id) || '' };
  }, [nameOf, statusMeta, customFields, projects, projectName]);
}
