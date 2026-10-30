import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import HoldButton, { HOLD_MAJOR_MS, HOLD_RECORD_MS } from './HoldButton';
import { dialog, DialogHost } from './dialog';

// Hold to confirm (Neil, Oct 30 2026).
const btn = () => screen.getByRole('button', { name: /press and hold/ });
const press = (el) => fireEvent.pointerDown(el, { button: 0, pointerId: 1 });
const release = (el) => fireEvent.pointerUp(el, { pointerId: 1 });

describe('HoldButton', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('holds shorter for one record than for a major action', () => {
    expect(HOLD_RECORD_MS).toBeLessThan(HOLD_MAJOR_MS);
    expect(HOLD_MAJOR_MS).toBeLessThanOrEqual(2000);
  });

  it('fires once a full hold completes, and shows the past tense', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<HoldButton label="Delete Forever" doneLabel="Deleted" onConfirm={onConfirm} />);
    expect(btn().getAttribute('aria-label')).toBe('Delete Forever, press and hold');
    press(btn());
    expect(btn().hasAttribute('data-holding')).toBe(true);
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(btn().hasAttribute('data-done')).toBe(true);
    expect(btn().textContent).toContain('Deleted');
    // a second hold while it shows Deleted does nothing
    press(btn());
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('letting go early cancels, and a quick tap says to hold', async () => {
    const onConfirm = vi.fn();
    render(<HoldButton label="Delete Forever" onConfirm={onConfirm} />);
    press(btn());
    act(() => { vi.advanceTimersByTime(100); });
    release(btn());
    expect(btn().hasAttribute('data-holding')).toBe(false);
    expect(screen.getByText('Hold to delete')).toBeTruthy();
    press(btn());
    act(() => { vi.advanceTimersByTime(HOLD_RECORD_MS - 200); });
    release(btn());
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('holds with the keyboard, ignoring key repeat', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<HoldButton label="Void" onConfirm={onConfirm} holdMs={HOLD_MAJOR_MS} />);
    fireEvent.keyDown(btn(), { key: ' ' });
    fireEvent.keyDown(btn(), { key: ' ', repeat: true });
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a refusal from the server rewinds the button and says why', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Only an owner can delete this project.'));
    render(<HoldButton label="Delete Project" onConfirm={onConfirm} />);
    press(btn());
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    expect(screen.getByRole('alert').textContent).toBe('Only an owner can delete this project.');
    expect(btn().hasAttribute('data-done')).toBe(false);
  });
});

describe('HoldButton without a press (assistive tech)', () => {
  it('asks with the ordinary dialog instead', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<><DialogHost /><HoldButton label="End Access" onConfirm={onConfirm} fallbackMessage="End Sam's access?" /></>);
    await act(async () => { fireEvent.click(btn(), { detail: 0 }); });
    expect(await screen.findByText("End Sam's access?")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'End Access' })); });
    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('dialog.confirm({ hold: true })', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits for the action, then resolves true; Enter alone never confirms', async () => {
    render(<DialogHost />);
    const work = vi.fn().mockResolvedValue(undefined);
    let result;
    await act(async () => { result = dialog.confirm('148 tasks go with it.', { title: 'Delete Project?', hold: true, confirmText: 'Delete Project', doneText: 'Deleted', onConfirm: work }); });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(work).not.toHaveBeenCalled();
    press(btn());
    await act(async () => { vi.advanceTimersByTime(HOLD_MAJOR_MS); });
    expect(work).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(await result).toBe(true);
  });

  it('shows an Undo toast when the action hands one back', async () => {
    render(<DialogHost />);
    const undo = vi.fn();
    render(<HoldButton label="End Access" doneLabel="Ended" onConfirm={async () => ({ undo, undoMessage: 'Access ended.' })} />);
    press(btn());
    await act(async () => { vi.advanceTimersByTime(HOLD_RECORD_MS); });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
