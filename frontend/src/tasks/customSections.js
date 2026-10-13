// The Custom grouping's sections (Oct 13 2026): named categories people make
// themselves to organize tasks - "Annual Recurring" apart from the weekly
// ones, which Miranda had in Asana and lost.
//
// Two kinds, one interface:
//   - in a PROJECT they are the project's own sections (task_sections), shared
//     by everyone on it; a task's sectionId says where it is filed.
//   - in MY TASKS they are the person's own, kept with their view settings
//     (the same profile store as their columns and grouping) - their way of
//     sorting their own list moves nothing for anyone else.
//
// useCustomSections(projectId) -> { sections, sectionOf, add, rename, remove,
// move, personal }. sections = [{ id, name }] in order; move(taskIds, sectionId)
// files tasks ('' / '-' = No Section).
import { useCallback, useMemo } from 'react';
import { useTasks } from './TasksContext';
import { useTableValue } from './tableCols';

const EMPTY = { list: [], assign: {} };
const newId = () => `sec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function useCustomSections(projectId = '') {
  const store = useTasks();
  const [mine, setMine] = useTableValue('mytasks', 'customSections', EMPTY);
  const personal = !projectId;

  const projectSections = useMemo(() => (store.sections || [])
    .filter((x) => x.projectId === projectId)
    .sort((a, b) => (a.position || 0) - (b.position || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
  [store.sections, projectId]);
  const personalSections = useMemo(() => (Array.isArray(mine?.list) ? mine.list : []), [mine]);
  const sections = personal ? personalSections : projectSections;

  const sectionOf = useCallback((t) => (personal ? (mine?.assign || {})[t.id] || '' : t.sectionId || ''), [personal, mine]);

  const add = useCallback(async (name) => {
    const n = String(name || '').trim();
    if (!n) return null;
    if (personal) {
      const sec = { id: newId(), name: n };
      setMine((cur) => ({ ...EMPTY, ...cur, list: [...(cur?.list || []), sec] }));
      return sec;
    }
    const last = projectSections[projectSections.length - 1];
    return store.createSection({ projectId, name: n, position: (last?.position || 0) + 1 });
  }, [personal, setMine, projectSections, store, projectId]);

  const rename = useCallback(async (id, name) => {
    const n = String(name || '').trim();
    if (!n) return;
    if (personal) setMine((cur) => ({ ...EMPTY, ...cur, list: (cur?.list || []).map((x) => (x.id === id ? { ...x, name: n } : x)) }));
    else await store.updateSection(id, { name: n });
  }, [personal, setMine, store]);

  // Its tasks go back to No Section - nothing is deleted with it.
  const remove = useCallback(async (id) => {
    if (personal) {
      setMine((cur) => {
        const assign = { ...(cur?.assign || {}) };
        for (const k of Object.keys(assign)) if (assign[k] === id) delete assign[k];
        return { list: (cur?.list || []).filter((x) => x.id !== id), assign };
      });
    } else await store.deleteSection(id);
  }, [personal, setMine, store]);

  const move = useCallback(async (taskIds, sectionId) => {
    const sid = sectionId === '-' ? '' : (sectionId || '');
    const ids = [...(taskIds || [])];
    if (!ids.length) return;
    if (personal) {
      setMine((cur) => {
        const assign = { ...(cur?.assign || {}) };
        for (const id of ids) { if (sid) assign[id] = sid; else delete assign[id]; }
        return { ...EMPTY, ...cur, assign };
      });
    } else if (ids.length === 1) await store.updateTask(ids[0], { sectionId: sid });
    else await store.bulkUpdate(ids, { sectionId: sid });
  }, [personal, setMine, store]);

  return { sections, sectionOf, add, rename, remove, move, personal };
}
