import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { IMPL_PHASES, IMPL_CHECK_IDS } from './implementationContent';
import { MODULES } from '../contexts/RoleContext';

// Support > Implementation Guide (Neil, 10/06): how to set Nexus up for an
// organization, phase by phase, with a done-list shared by every administrator.

const setCheck = vi.fn((id, done) => Promise.resolve({ done: done ? { [id]: { by: 'a@x.com', at: '2026-10-07T12:00:00+00:00' } } : {} }));
vi.mock('../api', () => ({
  api: {
    getImplementationProgress: () => Promise.resolve({ done: { 'kickoff.owner': { by: 'a@x.com', at: '2026-10-06T12:00:00+00:00' } } }),
    setImplementationCheck: (...a) => setCheck(...a),
    getRolesDirectory: () => Promise.resolve([]),
    getPeopleDirectory: () => Promise.resolve([]),
  },
}));

const { default: ImplementationGuide } = await import('./ImplementationGuide');

afterEach(() => { cleanup(); vi.clearAllMocks(); try { localStorage.clear(); } catch { /* */ } });

describe('Implementation Guide content', () => {
  it('has unique, stable check ids and every phase is complete', () => {
    expect(new Set(IMPL_CHECK_IDS).size).toBe(IMPL_CHECK_IDS.length);
    IMPL_PHASES.forEach((p, i) => {
      expect(p.n).toBe(i);
      expect(p.why.length).toBeGreaterThan(40);
      expect(p.steps.length).toBeGreaterThan(0);
      expect(p.checks.length).toBeGreaterThan(0);
      p.checks.forEach((c) => expect(c.id).toMatch(/^[a-z0-9][a-z0-9._-]{0,79}$/));
    });
  });

  it('opens only screens that exist, and uses no em dashes', () => {
    const views = new Set([...MODULES.map((m) => m.id), 'admin-console', 'support', 'legal', 'myhr', 'employee-tracking', 'egnyte', 'sop', 'shifts']);
    const text = JSON.stringify(IMPL_PHASES);
    expect(text).not.toContain('—');
    IMPL_PHASES.flatMap((p) => p.steps).filter((s) => s.view).forEach((s) => expect(views.has(s.view)).toBe(true));
  });
});

describe('Implementation Guide screen', () => {
  it('shows overall progress, opens a phase, and ticks a shared check', async () => {
    render(<ImplementationGuide />);
    expect((await screen.findAllByText(`1 of ${IMPL_CHECK_IDS.length} checks done`)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText('Companies, Departments, Locations and Holidays')[0]);
    expect(screen.getByText('Why This Matters')).toBeTruthy();
    expect(screen.getByText('Decide With the Client First')).toBeTruthy();
    const box = screen.getByLabelText(/Holiday calendar filled/);
    fireEvent.click(box);
    await waitFor(() => expect(setCheck).toHaveBeenCalledWith('company.holidays', true));
  });

  it('an Open button takes you to the screen', async () => {
    const nav = vi.fn();
    window.addEventListener('nexus:navigate', nav);
    render(<ImplementationGuide />);
    fireEvent.click((await screen.findAllByText('Job Roles and Access'))[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /Open/ })[0]);
    expect(nav.mock.calls.at(-1)[0].detail).toEqual({ view: 'admin-console', sub: 'company' });
    window.removeEventListener('nexus:navigate', nav);
  });
});
