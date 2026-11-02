import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import BoardFallback, { EngineBoundary, BoardLoading } from './fallback';

describe('BoardFallback - the board when the drawing tools do not load', () => {
  it('shows the last saved picture full width, read-only, with Retry', () => {
    const onRetry = vi.fn();
    render(<BoardFallback note={{ title: 'Yard', thumbUrl: 'https://api/files/view?u=thumb' }} onRetry={onRetry} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toBe('https://api/files/view?u=thumb');
    expect(screen.getByText('The drawing tools did not load.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(document.body.textContent.toLowerCase()).not.toContain('excalidraw');
  });

  it('is never blank without a picture', () => {
    render(<BoardFallback note={{ title: 'Yard' }} onRetry={() => {}} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/no picture of this board yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('Retry is held while a load is under way', () => {
    render(<BoardFallback note={{}} onRetry={() => {}} busy />);
    expect(screen.getByRole('button', { name: /Retrying/ }).disabled).toBe(true);
  });

  it('the loading view is not blank either', () => {
    const { container } = render(<BoardLoading />);
    expect(container.querySelector('.nx-skel')).toBeTruthy();
  });
});

describe('EngineBoundary - an engine crash never reaches the page boundary', () => {
  const Boom = () => { throw new Error('canvas loop'); };
  it('catches the crash, shows the fallback with the picture, and Retry mounts the children again', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onCrash = vi.fn(); const onRetry = vi.fn();
    let crash = true;
    const Child = () => (crash ? <Boom /> : <div>drawing</div>);
    render(<EngineBoundary note={{ thumbUrl: 'https://api/files/view?u=t' }} onCrash={onCrash} onRetry={onRetry}><Child /></EngineBoundary>);
    expect(screen.getByRole('img')).toBeTruthy();
    expect(onCrash).toHaveBeenCalledWith(expect.any(Error));
    crash = false;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('drawing')).toBeTruthy();
    spy.mockRestore();
  });
});
