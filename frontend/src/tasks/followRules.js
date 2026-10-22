// Follow a project (Oct 22 2026) - the small rules the Follow control and the
// Projects list share. The server is the authority (task_project_follow.py,
// routers/task_projects.py); these only decide what to show.
import { projectRoleOf, roleAtLeast } from './lib';

/** The project's followers, lowercased. */
export function projectFollowers(project) {
  return (Array.isArray(project?.followerIds) ? project.followerIds : [])
    .map((e) => String(e || '').toLowerCase()).filter(Boolean);
}

export function isFollowing(project, email) {
  const me = String(email || '').toLowerCase();
  return !!me && projectFollowers(project).includes(me);
}

/** Owners and editors (and managers) may add or remove other followers -
 *  the server's rule (require_project_access(..., "editor")). */
export function canManageFollowers(project, email, isManager = false) {
  return roleAtLeast(projectRoleOf(project, email, isManager), 'editor');
}
