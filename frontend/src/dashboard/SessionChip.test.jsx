import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionChip } from './SessionChip';

// The dashboard header's time chip (Neil, Oct 14 2026): nothing for someone
// who is not time-tracked, nothing before the status is known, and On Break
// when they are on one.
const mine = (state, extra = {}) => ({ state, exempt: state === 'exempt', todayMin: 65, ...extra });

describe('SessionChip', () => {
  it('renders nothing for a time-exempt person', () => {
    const { container } = render(<SessionChip mine={mine('exempt')} onOpen={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing until the status has loaded', () => {
    const { container } = render(<SessionChip mine={mine('unknown')} onOpen={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('says Clocked In with the hours, and opens the time clock', () => {
    const onOpen = vi.fn();
    render(<SessionChip mine={mine('in')} onOpen={onOpen} />);
    const chip = screen.getByRole('button', { name: /Clocked In/ });
    expect(chip.textContent).toContain('1:05');
    expect(chip.className).toContain('dk-session-chip--on');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says On Break on a break, not Clocked In', () => {
    render(<SessionChip mine={mine('break')} onOpen={() => {}} />);
    expect(screen.getByRole('button').textContent).toMatch(/^On Break/);
    expect(screen.queryByText(/Clocked In/)).toBeNull();
  });

  it('says Clocked Out with the way in for a tracked person off the clock', () => {
    render(<SessionChip mine={mine('out')} onOpen={() => {}} />);
    const chip = screen.getByRole('button');
    expect(chip.textContent).toContain('Clocked Out');
    expect(chip.textContent).toContain('Open Time Clock');
    expect(chip.className).not.toContain('--on');
  });
});
