import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Shifts module (Sep 29): everyone opens on My Shifts. One tab strip, like
// Teams Shifts (Sep 30): My Shifts and Requests for everyone, Schedule and
// Presets & Groups for managers and above. Employees never see the manager
// pages, even by address.

const role = { level: 1 };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: (r) => role.level >= ({ manager: 3 }[r] ?? 1) }) }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'a@x.com', name: 'Amy' }]) } }));
vi.mock('../components/MyShifts', () => ({ default: () => <div>My week</div> }));
vi.mock('../components/ShiftSchedule', () => ({ default: () => <div>Schedule grid</div> }));
vi.mock('../components/ShiftsPanel', () => ({ default: ({ people }) => <div>Presets panel ({people.length})</div> }));
vi.mock('../components/ShiftRequestsPage', () => ({ default: ({ canManage }) => <div>Requests page ({canManage ? 'manager' : 'staff'})</div> }));

const Shifts = (await import('./Shifts')).default;
const tabNames = () => screen.getAllByRole('tab').map(t => t.textContent.trim());

describe('Shifts module', () => {
  it('shows an employee their shifts and requests, and no way to change the schedule', () => {
    role.level = 1;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub={null} onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Shifts' })).toBeTruthy();
    expect(screen.getByText('My week')).toBeTruthy();
    expect(tabNames()).toEqual(['My Shifts', 'Requests']);
    // A manager page's address falls back to My Shifts.
    rerender(<Shifts activeSub="schedule" onSubChange={onSubChange} />);
    expect(screen.getByText('My week')).toBeTruthy();
    expect(screen.queryByText('Schedule grid')).toBeNull();
    rerender(<Shifts activeSub="presets" onSubChange={onSubChange} />);
    expect(screen.queryByText(/Presets panel/)).toBeNull();
    // Requests is theirs.
    fireEvent.click(screen.getByRole('tab', { name: /Requests/ }));
    expect(onSubChange).toHaveBeenCalledWith('requests');
    rerender(<Shifts activeSub="requests" onSubChange={onSubChange} />);
    expect(screen.getByText('Requests page (staff)')).toBeTruthy();
  });

  it('gives a manager all four pages on one tab strip', async () => {
    role.level = 3;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub="mine" onSubChange={onSubChange} />);
    expect(tabNames()).toEqual(['My Shifts', 'Schedule', 'Requests', 'Presets & Groups']);
    expect(screen.getByRole('tab', { name: /My Shifts/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: /Schedule/ }));
    expect(onSubChange).toHaveBeenCalledWith('schedule');
    rerender(<Shifts activeSub="schedule" onSubChange={onSubChange} />);
    expect(screen.getByText('Schedule grid')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Presets & Groups/ }));
    expect(onSubChange).toHaveBeenCalledWith('presets');
    rerender(<Shifts activeSub="presets" onSubChange={onSubChange} />);
    expect(await screen.findByText('Presets panel (1)')).toBeTruthy();   // the People list loads for it
    rerender(<Shifts activeSub="requests" onSubChange={onSubChange} />);
    expect(screen.getByText('Requests page (manager)')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /My Shifts/ }));
    expect(onSubChange).toHaveBeenCalledWith('mine');
  });
});
