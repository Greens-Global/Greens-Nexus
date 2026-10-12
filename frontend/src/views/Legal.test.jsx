import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Legal from './Legal';

// Legal (Neil, 10/06): the Privacy Policy and Terms & Conditions on one page,
// opened from the profile menu instead of two cards on Support.

describe('Legal', () => {
  it('opens on the Privacy Policy and switches to the Terms', () => {
    const onSubChange = vi.fn();
    const { rerender } = render(<Legal activeSub={null} onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Terms & Conditions/ }));
    expect(onSubChange).toHaveBeenCalledWith('terms');
    rerender(<Legal activeSub="terms" onSubChange={onSubChange} />);
    expect(screen.getByRole('heading', { name: 'Terms & Conditions' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Terms & Conditions/ }).getAttribute('aria-selected')).toBe('true');
  });
});
