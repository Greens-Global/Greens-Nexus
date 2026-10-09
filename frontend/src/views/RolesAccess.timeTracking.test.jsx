import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { timeTrackingText } from '../lib/timeTracking';
import hrSource from './HR.jsx?raw';

// Exempt from time tracking (no clock, no timesheet) moved from People > Pay &
// Benefits to the role editor in Settings > Access, beside the screen-share
// exemption (Visesh, 10/02).

const updateJobRole = vi.fn((id, body) => Promise.resolve({ id, ...body }));
vi.mock('../api', () => ({
  api: new Proxy({}, {
    get: (_, key) => (key === 'updateJobRole' ? updateJobRole : vi.fn(() => Promise.resolve([]))),
  }),
}));
vi.mock('../ui/dialog', () => ({ dialog: { confirm: vi.fn(() => Promise.resolve(true)) } }));

const { RoleEditor } = await import('./RolesAccess');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Role editor - Exempt from time tracking', () => {
  it('loads the flag, toggles it, and saves it with the role', async () => {
    const role = { id: 'r-mp', name: 'Managing Principal', tier: 'owner', department: '', description: '',
      monitoring_exempt: true, bod_exempt: false, time_tracking_exempt: true, allowed_modules: [] };
    const onSaved = vi.fn();
    render(<RoleEditor role={role} jobRoles={[role]} onClose={() => {}} onSaved={onSaved} onErr={() => {}} />);

    const toggle = screen.getByRole('button', { name: /Exempt from time tracking/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/have no time clock and no timesheet/)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: /Save Job Role/ }));
    await waitFor(() => expect(updateJobRole).toHaveBeenCalled());
    const [id, body] = updateJobRole.mock.calls[0];
    expect(id).toBe('r-mp');
    expect(body.time_tracking_exempt).toBe(false);
    expect(body.monitoring_exempt).toBe(true);

    cleanup();
    updateJobRole.mockClear();
    render(<RoleEditor role={{ ...role, time_tracking_exempt: false }} jobRoles={[]} onClose={() => {}} onSaved={onSaved} onErr={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Exempt from time tracking/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save Job Role/ }));
    await waitFor(() => expect(updateJobRole).toHaveBeenCalled());
    expect(updateJobRole.mock.calls[0][1].time_tracking_exempt).toBe(true);
  });
});

describe('Pay & Benefits - time tracking is read-only', () => {
  it('no longer offers a Tracked / Exempt control', () => {
    expect(hrSource).not.toMatch(/setC\('timeTrackingExempt'/);
    expect(hrSource).not.toMatch(/Exempt \(salaried - no time tracking\)/);
  });

  it('names the role that sets the exemption', () => {
    expect(timeTrackingText({ timeTrackingExempt: true, timeTrackingExemptVia: 'Managing Principal' }))
      .toBe('Exempt (set by role: Managing Principal)');
    expect(timeTrackingText({ timeTrackingExempt: false })).toBe('Tracked');
    expect(timeTrackingText(undefined)).toBe('Tracked');
  });
});
