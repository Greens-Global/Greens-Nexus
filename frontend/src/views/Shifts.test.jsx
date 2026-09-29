import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Shifts module (Sep 29): everyone opens on My Shifts; managers and above get
// Manage - the schedule grid and Presets & Groups. Employees never see the
// Manage pages, even by address.

const role = { level: 1 };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => ({ can: (r) => role.level >= ({ manager: 3 }[r] ?? 1) }) }));
vi.mock('../api', () => ({ api: { getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'a@x.com', name: 'Amy' }]) } }));
vi.mock('../components/MyShifts', () => ({ default: () => <div>My week</div> }));
vi.mock('../components/ShiftSchedule', () => ({ default: () => <div>Schedule grid</div> }));
vi.mock('../components/ShiftsPanel', () => ({ default: ({ people }) => <div>Presets panel ({people.length})</div> }));

const Shifts = (await import('./Shifts')).default;

describe('Shifts module', () => {
  it('shows an employee their shifts and no way to change them', () => {
    role.level = 1;
    const { rerender } = render(<Shifts activeSub={null} onSubChange={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Shifts' })).toBeTruthy();
    expect(screen.getByText('My week')).toBeTruthy();
    expect(screen.queryByText('Manage')).toBeNull();
    // A Manage address falls back to My Shifts.
    rerender(<Shifts activeSub="schedule" onSubChange={() => {}} />);
    expect(screen.getByText('My week')).toBeTruthy();
    expect(screen.queryByText('Schedule grid')).toBeNull();
  });

  it('gives a manager Manage, its two pages, and the way back', async () => {
    role.level = 3;
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub="mine" onSubChange={onSubChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Manage/ }));
    expect(onSubChange).toHaveBeenCalledWith('schedule');
    rerender(<Shifts activeSub="schedule" onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Manage Shifts' })).toBeTruthy();
    expect(screen.getByText('Schedule grid')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Presets & Groups/ }));
    expect(onSubChange).toHaveBeenCalledWith('presets');
    rerender(<Shifts activeSub="presets" onSubChange={onSubChange} />);
    expect(await screen.findByText('Presets panel (1)')).toBeTruthy();
    fireEvent.click(screen.getByText('Back to My Shifts'));
    expect(onSubChange).toHaveBeenCalledWith('mine');
  });
});
