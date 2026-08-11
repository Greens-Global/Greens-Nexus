// The Task module tour is access-based: what it shows depends on what the
// viewer can actually reach. Walking somebody through a Manage screen they
// cannot open teaches them a button that is not there, which is worse than no
// tour at all - so these pin the filtering rather than the wording.
import { describe, it, expect, vi } from 'vitest';
import { buildTaskTourSteps } from './taskTourSteps';

const build = (over = {}) =>
  buildTaskTourSteps({ go: vi.fn(), canManage: false, isMobile: false, ...over });

const targets = (steps) => steps.map((s) => s.target);

describe('buildTaskTourSteps', () => {
  it('never shows an employee the Manage steps', () => {
    const t = targets(build({ canManage: false }));
    expect(t).not.toContain('task-manage');
    expect(t).not.toContain('task-manage-tabs');
  });

  it('shows a manager the Manage steps', () => {
    const t = targets(build({ canManage: true }));
    expect(t).toContain('task-manage');
    expect(t).toContain('task-manage-tabs');
  });

  it('gives everyone the day-to-day screens regardless of role', () => {
    for (const canManage of [false, true]) {
      const t = targets(build({ canManage }));
      expect(t).toEqual(expect.arrayContaining([
        'task-tabs', 'task-screen-home', 'task-screen-mine',
        'task-screen-projects', 'task-screen-teams',
      ]));
    }
  });

  it('drops the desktop-only chrome on a phone', () => {
    // Both are hidden in the mobile layout; spotlighting them would strand the
    // tour on a step with nothing to point at.
    const t = targets(build({ isMobile: true }));
    expect(t).not.toContain('task-create');
    expect(t).not.toContain('task-views');
  });

  it('keeps that chrome on desktop', () => {
    const t = targets(build({ isMobile: false }));
    expect(t).toContain('task-create');
    expect(t).toContain('task-views');
  });

  it('hands GuidedTour only the shape it documents', () => {
    // `when` is our filtering mechanism, not part of GuidedTour's contract.
    for (const step of build({ canManage: true })) {
      expect(step).not.toHaveProperty('when');
      expect(typeof step.title).toBe('string');
      expect(typeof step.body).toBe('string');
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });

  it('opens and closes on the tab strip, so the tour ends where it started', () => {
    const steps = build({ canManage: true });
    expect(steps[0].target).toBe('task-tabs');
    expect(steps[steps.length - 1].target).toBe('task-tabs');
  });

  it('switches to the right tab before pointing at a screen', () => {
    // Without before(), a step targeting Projects would spotlight whatever tab
    // happened to be open.
    const go = vi.fn();
    const steps = buildTaskTourSteps({ go, canManage: true, isMobile: false });
    const projects = steps.find((s) => s.target === 'task-screen-projects');
    projects.before();
    expect(go).toHaveBeenCalledWith('projects');
  });

  it('tells a manager and an employee different things at the end', () => {
    const last = (canManage) => build({ canManage }).slice(-1)[0].body;
    expect(last(true)).not.toBe(last(false));
    expect(last(true)).toContain('Manage');
  });
});
