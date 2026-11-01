// Full Screen for the workflow builder and Operations (Neil, 10/31/2026).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FullScreenButton, { useFullScreen } from './FullScreenButton';

function Host({ module = 'workflows' }) {
  const [on, toggle] = useFullScreen(module);
  return <FullScreenButton on={on} onToggle={toggle} />;
}

function desktop() {
  window.matchMedia = vi.fn().mockImplementation((q) => ({
    matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {},
  }));
}

describe('Full Screen', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('nx-fullscreen');
    desktop();
  });

  it('folds the navigation away, remembers it per module, and puts it back on leaving', () => {
    const { unmount } = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /Full Screen/ }));
    expect(document.documentElement.classList.contains('nx-fullscreen')).toBe(true);
    expect(screen.getByRole('button', { name: /Exit Full Screen/ })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('nexus.fullScreen.workflows')).toBe('1');
    expect(localStorage.getItem('nexus.fullScreen.operations')).toBeNull();
    unmount();
    expect(document.documentElement.classList.contains('nx-fullscreen')).toBe(false);
    render(<Host />);
    expect(document.documentElement.classList.contains('nx-fullscreen')).toBe(true);
  });

  it('Exit Full Screen brings the navigation back and forgets the choice', () => {
    localStorage.setItem('nexus.fullScreen.operations', '1');
    render(<Host module="operations" />);
    fireEvent.click(screen.getByRole('button', { name: /Exit Full Screen/ }));
    expect(document.documentElement.classList.contains('nx-fullscreen')).toBe(false);
    expect(localStorage.getItem('nexus.fullScreen.operations')).toBeNull();
  });

  it('shows nothing on a phone, which is full width already', () => {
    localStorage.setItem('nexus.fullScreen.workflows', '1');
    window.matchMedia = vi.fn().mockImplementation((q) => ({
      matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {},
    }));
    render(<Host />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.documentElement.classList.contains('nx-fullscreen')).toBe(false);
  });
});
