import { describe, it, expect } from 'vitest';
import { buildSupportTourSteps } from './supportTourSteps';

describe('buildSupportTourSteps', () => {
  it('covers Submit a Ticket and Report a Bug specifically', () => {
    const targets = buildSupportTourSteps().map((s) => s.target);
    expect(targets).toContain('support-submit-ticket');
    expect(targets).toContain('support-report-bug');
  });

  it('opens and closes on the options grid, so the tour ends where it started', () => {
    const steps = buildSupportTourSteps();
    expect(steps[0].target).toBe('support-options');
    expect(steps[steps.length - 1].target).toBe('support-options');
  });

  it('hands GuidedTour only the shape it documents', () => {
    for (const step of buildSupportTourSteps()) {
      expect(step).not.toHaveProperty('when');
      expect(typeof step.title).toBe('string');
      expect(typeof step.body).toBe('string');
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });
});
