// The Ticket module tour is layout-based, same reasoning as the Task
// module's own taskTourSteps.test.js: what it shows depends on what the
// viewer can actually reach, so these pin the filtering rather than the
// wording.
import { describe, it, expect, vi } from 'vitest';
import { buildTicketTourSteps } from './ticketTourSteps';

const build = (over = {}) =>
  buildTicketTourSteps({ setScope: vi.fn(), setView: vi.fn(), isMobile: false, ...over });

const targets = (steps) => steps.map((s) => s.target);

describe('buildTicketTourSteps', () => {
  it('never points at a Manage button, which does not exist in Tickets any more', () => {
    // The module's admin surface moved to the Admin module (Sep 9 2026).
    const t = targets(build());
    expect(t).not.toContain('ticket-manage');
  });

  it('gives everyone the day-to-day screens regardless of layout', () => {
    for (const isMobile of [false, true]) {
      const t = targets(build({ isMobile }));
      expect(t).toEqual(expect.arrayContaining(['ticket-scope', 'ticket-body']));
    }
  });

  it('drops the desktop-only chrome on a phone', () => {
    // Hidden in the mobile layout; spotlighting them would strand the tour on
    // a step with nothing to point at.
    const t = targets(build({ isMobile: true }));
    expect(t).not.toContain('ticket-create');
    expect(t).not.toContain('ticket-views');
    expect(t).not.toContain('ticket-tiles');
    expect(t).not.toContain('ticket-toolbar');
  });

  it('keeps that chrome on desktop', () => {
    const t = targets(build({ isMobile: false }));
    expect(t).toContain('ticket-create');
    expect(t).toContain('ticket-views');
    expect(t).toContain('ticket-tiles');
    expect(t).toContain('ticket-toolbar');
  });

  it('hands GuidedTour only the shape it documents', () => {
    // `when` is our filtering mechanism, not part of GuidedTour's contract.
    for (const step of build()) {
      expect(step).not.toHaveProperty('when');
      expect(typeof step.title).toBe('string');
      expect(typeof step.body).toBe('string');
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });

  it('opens and closes on the scope tabs, so the tour ends where it started', () => {
    const steps = build();
    expect(steps[0].target).toBe('ticket-scope');
    expect(steps[steps.length - 1].target).toBe('ticket-scope');
  });

  it('resets scope and view before pointing at a screen', () => {
    // Without before(), a step could spotlight the right element while it is
    // showing a stale scope/view left over from an earlier step.
    const setScope = vi.fn();
    const setView = vi.fn();
    const steps = buildTicketTourSteps({ setScope, setView, isMobile: false });
    const first = steps[0];
    first.before();
    expect(setScope).toHaveBeenCalledWith('all');
    expect(setView).toHaveBeenCalledWith('list');
  });
});
