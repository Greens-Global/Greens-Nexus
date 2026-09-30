// Render-smoke for the shared loading pieces (Sep 29): every screen's loader
// now comes from here, so a crash in Spinner or LoadingState would take the
// whole app's waiting states with it. Pins the sizes, the 150 ms silent wait,
// the 8 s long-wait note and the modal scrim.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Spinner, LoadingState, ModalLoading, SkeletonBlocks, LOADER_SIZES } from './AsyncState';

describe('Spinner', () => {
  it('renders the ring at a named size', () => {
    render(<Spinner size="view" label="Loading Tasks" />);
    const ring = screen.getByRole('img', { name: 'Loading Tasks' });
    expect(ring.className).toContain('nxl');
    expect(ring.style.getPropertyValue('--s')).toBe(`${LOADER_SIZES.view}px`);
    expect(ring.querySelectorAll('circle')).toHaveLength(2);
  });

  it('accepts a pixel size for an icon slot and marks small rings', () => {
    render(<Spinner size={14} />);
    const ring = screen.getByRole('img', { name: 'Loading' });
    expect(ring.style.getPropertyValue('--s')).toBe('14px');
    expect(ring.className).toContain('nxl-sm');
  });
});

describe('LoadingState', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows nothing for the first 150 ms, then the ring, then the long-wait note', () => {
    const onRetry = vi.fn();
    render(<LoadingState label="Loading Checkouts" onRetry={onRetry} />);
    expect(screen.queryByRole('img')).toBeNull();
    act(() => vi.advanceTimersByTime(160));
    expect(screen.getByRole('img', { name: 'Loading Checkouts' })).toBeTruthy();
    expect(screen.getByText('Loading Checkouts')).toBeTruthy();
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByText(/taking longer than usual/)).toBeTruthy();
    screen.getByRole('button', { name: 'Try Again' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('compact form puts the label beside an inline ring', () => {
    render(<LoadingState compact label="Loading folders…" />);
    act(() => vi.advanceTimersByTime(160));
    const ring = screen.getByRole('img', { name: 'Loading folders…' });
    expect(ring.style.getPropertyValue('--s')).toBe(`${LOADER_SIZES.inline}px`);
    expect(screen.getByText('Loading folders…')).toBeTruthy();
  });
});

describe('ModalLoading and SkeletonBlocks', () => {
  it('dims the screen at once and adds a white ring after the wait', () => {
    vi.useFakeTimers();
    render(<ModalLoading />);
    const scrim = screen.getByRole('status');
    expect(scrim.style.position).toBe('fixed');
    expect(screen.queryByRole('img')).toBeNull();
    act(() => vi.advanceTimersByTime(160));
    expect(screen.getByRole('img').style.color).toMatch(/fff|white|255, 255, 255/i);
    vi.useRealTimers();
  });

  it('renders one sheen block per row with a cascade index', () => {
    const { container } = render(<SkeletonBlocks count={4} height={30} />);
    const blocks = container.querySelectorAll('.nx-skel');
    expect(blocks).toHaveLength(4);
    expect(blocks[3].style.getPropertyValue('--i')).toBe('3');
  });
});
