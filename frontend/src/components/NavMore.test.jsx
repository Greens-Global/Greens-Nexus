import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NavMore from './NavMore';

// "5 waiting below" (Oct 25 2026): a quiet chip at the edge of a navigation
// list when a busy module is scrolled out of view; nothing when none is.
describe('NavMore', () => {
  it('says how many are waiting out of view, and brings them into view', () => {
    const onReveal = vi.fn();
    render(<NavMore dir="below" n={5} onReveal={onReveal} />);
    const chip = screen.getByRole('button', { name: '5 waiting below - show' });
    expect(chip.textContent).toBe('5 waiting below');
    fireEvent.click(chip);
    expect(onReveal).toHaveBeenCalledWith('below');
  });

  it('is only the number on the folded rail, with the words as its tooltip', () => {
    render(<NavMore dir="above" n={120} compact onReveal={() => {}} />);
    const chip = screen.getByRole('button', { name: '99+ waiting above - show' });
    expect(chip.textContent).toBe('99+');
    expect(chip.getAttribute('title')).toBe('99+ waiting above');
  });

  it('renders nothing when nothing is out of view', () => {
    const { container } = render(<NavMore dir="below" n={0} onReveal={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
