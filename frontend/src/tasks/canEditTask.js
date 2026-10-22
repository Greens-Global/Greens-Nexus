// "May this person edit that task?" for views that act on many tasks at once
// (Oct 22 2026): the Board and Timeline (drag only for editors) and Move To...
// (only tasks you can edit are offered as a new parent). The drawer's rule -
// taskRoleFor - where an unknown role keeps the control: the server stays the
// authority either way.
import { useCallback } from 'react';
import { useRole } from '../contexts/RoleContext';
import { taskRoleFor, roleAtLeast } from './lib';

/** (task) => boolean. `store` is the Tasks store (views get it as a prop). */
export function useCanEditTask(store) {
  const { projects, teams, taskById, myEmail } = store || {};
  const { canAccessModule } = useRole() || {};
  const isManager = typeof canAccessModule === 'function' && !!canAccessModule('tasks', 'manager', 'owner');
  return useCallback((t) => {
    const r = taskRoleFor(t, { projects, teams, taskById, email: myEmail, isManager });
    return r == null || roleAtLeast(r, 'editor');
  }, [projects, teams, taskById, myEmail, isManager]);
}
