// Cross-view jump to one person's page in the Task module (tasks/PersonView:
// their open work, stats and teams). The header search's People results land
// here for anyone with Tasks (Neil, Oct 18 2026 - "a critical requirement";
// the Oct 9 Contact Directory change had sent them to the contact card).
//
// Same two-channel handoff as lib/contactNav.js: the person is written down
// for a Task module that has yet to mount (it is lazy, so the first jump
// arrives before its listener exists) AND announced for one that is mounted.
import { setPendingOpen } from './pendingOpen';

export const PERSON_TASKS_KIND = 'task-person';

// Opened from outside the Task module (Sagar, Oct 27): their page then reads
// as a page of its own - no Home / Tasks / Projects strip - and Back returns
// to the screen the search was made from (views/Tasks.jsx).
// Fired by views/Tasks.jsx with { outside } while such a page shows, so the
// phone bottom bar (components/MobileNav.jsx) drops the module tabs too.
export const TASKS_PERSON_PAGE = 'nexus:tasks-person-page';

export const inTasksModule = () => /^\/tasks(\/|$)/.test(window.location.pathname || '');

export function openPersonTasks(email, name = '') {
  const em = (email || '').trim().toLowerCase();
  if (!em) return;
  const who = { email: em, name: name || em, fromOutside: !inTasksModule() };
  setPendingOpen(PERSON_TASKS_KIND, who);
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: 'tasks', sub: 'home' } }));
  setTimeout(() => window.dispatchEvent(new CustomEvent('nexus:tasks-person', { detail: who })), 0);
}
