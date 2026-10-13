import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, act, cleanup, screen } from '@testing-library/react';
import SavedCheck from './SavedCheck';
import { setMotionEnabled } from '../lib/motion';

afterEach(() => { cleanup(); setMotionEnabled(false); vi.useRealTimers(); });

describe('SavedCheck', () => {
  it('shows the word and a check only while the caller says so', () => {
    const { rerender } = render(<SavedCheck show={false} />);
    expect(screen.queryByText('Saved')).toBeNull();
    rerender(<SavedCheck show />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    expect(document.querySelector('.nx-saved svg path')).not.toBeNull();
    rerender(<SavedCheck show={false} />);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('fades out before it goes when motion is on', () => {
    vi.useFakeTimers(); setMotionEnabled(true);
    const { rerender } = render(<SavedCheck show label="Done" />);
    rerender(<SavedCheck show={false} label="Done" />);
    expect(document.querySelector('.nx-saved.is-closing')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByText('Done')).toBeNull();
  });
});
