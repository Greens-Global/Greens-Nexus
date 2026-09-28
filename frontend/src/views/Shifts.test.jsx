import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Shifts module (Sep 29): its own page in My Desk with Schedule and
// Presets & Groups tabs. Render smoke test + tab switching.

vi.mock('../api', () => ({ api: { getPeopleDirectory: vi.fn().mockResolvedValue([{ email: 'a@x.com', name: 'Amy' }]) } }));
vi.mock('../components/ShiftSchedule', () => ({ default: () => <div>Schedule grid</div> }));
vi.mock('../components/ShiftsPanel', () => ({ default: ({ people }) => <div>Presets panel ({people.length})</div> }));

const Shifts = (await import('./Shifts')).default;

describe('Shifts module', () => {
  it('opens on the schedule and switches tabs through the address bar', async () => {
    const onSubChange = vi.fn();
    const { rerender } = render(<Shifts activeSub={null} onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Shifts' })).toBeTruthy();
    expect(screen.getByText('Schedule grid')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Presets & Groups/ }));
    expect(onSubChange).toHaveBeenCalledWith('presets');
    rerender(<Shifts activeSub="presets" onSubChange={onSubChange} />);
    expect(await screen.findByText('Presets panel (1)')).toBeTruthy();
  });
});
