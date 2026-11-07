import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SettingsSkeleton from './SettingsSkeleton';

// What App.jsx shows while the Settings chunk loads (11/05/2026): the page's
// own frame - a rail of subjects and the subject's groups - as a busy status,
// never a blank page or a lone ring.
describe('SettingsSkeleton', () => {
  it('draws the rail and the groups as one busy status', () => {
    const { container } = render(<SettingsSkeleton />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Loading Settings…')).toBeTruthy();
    expect(container.querySelector('.nx-set-shell .nx-set-rail')).toBeTruthy();
    expect(container.querySelectorAll('.nx-set-rail .nx-set-rail-item').length).toBeGreaterThan(5);
    expect(container.querySelector('.nx-set-main .nx-set-head')).toBeTruthy();
    expect(container.querySelectorAll('.nx-set-main .nx-set-group').length).toBe(3);
    expect(container.querySelector('svg')).toBeNull();          // no spinner ring
  });
});
