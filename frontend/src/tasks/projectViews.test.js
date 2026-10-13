import { describe, it, expect } from 'vitest';
import { projectRoleOf, roleAtLeast, effectiveProjectView, projectToForm } from './lib';

// Project default views and the role the client uses to decide what to
// OFFER (the server enforces) - Oct 2026.

const me = 'me@greensglobal.com';

describe('projectRoleOf', () => {
  it('owner, explicit role, bare membership, org-level, nothing', () => {
    expect(projectRoleOf({ ownerId: me, accessLevel: 'restricted' }, me)).toBe('owner');
    expect(projectRoleOf({ ownerId: 'x', memberRoles: { [me]: 'viewer' }, memberIds: [me], accessLevel: 'restricted' }, me)).toBe('viewer');
    expect(projectRoleOf({ ownerId: 'x', memberIds: [me], accessLevel: 'restricted' }, me)).toBe('editor');
    expect(projectRoleOf({ ownerId: 'x', accessLevel: 'org' }, me)).toBe('editor');
    expect(projectRoleOf({ ownerId: 'x', accessLevel: 'restricted' }, me)).toBeNull();
    expect(projectRoleOf({ ownerId: 'x', accessLevel: 'restricted' }, me, true)).toBe('owner');
    expect(projectRoleOf(null, me)).toBeNull();
  });

  it('ranks roles', () => {
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast(null, 'viewer')).toBe(false);
  });
});

describe('effectiveProjectView', () => {
  const project = { id: 'p1', defaultView: { view: 'board', group: 'assignee' } };

  it('my own choice in the project wins', () => {
    expect(effectiveProjectView({ p1: { view: 'calendar' } }, project, 'list', 'status'))
      .toEqual({ view: 'calendar', group: 'assignee', source: 'mine' });
  });

  it('then the project default', () => {
    expect(effectiveProjectView({}, project, 'list', 'status')).toEqual({ view: 'board', group: 'assignee', source: 'project' });
  });

  it('then my general preference', () => {
    expect(effectiveProjectView({}, { id: 'p2' }, 'list', 'status')).toEqual({ view: 'list', group: 'status', source: 'global' });
    expect(effectiveProjectView(undefined, null, 'timeline', 'none')).toEqual({ view: 'timeline', group: 'none', source: 'global' });
  });

  it('the project form carries the default view', () => {
    expect(projectToForm({ id: 'p1', defaultView: { view: 'board' } }).defaultView).toEqual({ view: 'board' });
    expect(projectToForm({ id: 'p1' }).defaultView).toBeNull();
  });
});
