// The interior.dev effects rebuilt house-style (Neil, 11/07/2026): each one
// does its job without a mouse, says what happened, and never blocks.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import CopyButton from './CopyButton';
import LoadingButton from './LoadingButton';
import NewItemsPill, { useHeldItems } from './NewItemsPill';
import { useFieldCheck, FieldNote } from './FieldCheck';
import ReorderList, { landingIndex, moved } from './ReorderList';

// jsdom has no PointerEvent, and the plain Event it falls back to drops clientY.
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends MouseEvent { constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Copy Button', () => {
  it('copies and turns into Copied, then back', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CopyButton value="000042" what="ticket number" iconOnly />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy ticket number' })); });
    expect(writeText).toHaveBeenCalledWith('000042');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1700); });
    expect(screen.getByRole('button', { name: 'Copy ticket number' })).toBeTruthy();
  });

  it('says so when the clipboard is blocked', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('no'); }) }, configurable: true });
    render(<CopyButton value="x" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy/ })); });
    expect(screen.getByRole('button', { name: /Copy Failed/ })).toBeTruthy();
  });
});

describe('Loading Button', () => {
  it('runs Saving… then Saved from the promise its click returns', async () => {
    let finish;
    const onClick = () => new Promise((r) => { finish = r; });
    render(<LoadingButton onClick={onClick}>Save</LoadingButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const busy = screen.getByRole('button', { name: /Saving…/ });
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await act(async () => { finish(); });
    expect(screen.getByRole('button', { name: /Saved/ })).toBeTruthy();
  });

  it('goes back to its label when the save fails', async () => {
    let fail;
    render(<LoadingButton onClick={() => new Promise((_, r) => { fail = r; })}>Save</LoadingButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { fail(new Error('no')); });
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false);
  });

  it('shows Saved when the caller says a save landed', () => {
    vi.useFakeTimers();
    const { rerender } = render(<LoadingButton busy>Save</LoadingButton>);
    rerender(<LoadingButton busy={false} done>Save</LoadingButton>);
    expect(screen.getByRole('button', { name: /Saved/ })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1700); });
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

function Feed({ items, scrolled }) {
  const ref = useRef(null);
  const { shown, held, release } = useHeldItems(items, (x) => x, ref);
  return (
    <div ref={(el) => { ref.current = el; if (el && scrolled) Object.defineProperty(el, 'scrollTop', { value: 200, configurable: true }); }}>
      <NewItemsPill count={held} noun="Update" onClick={release} />
      {shown.map((x) => <p key={x}>{x}</p>)}
    </div>
  );
}

describe('New Items Pill', () => {
  it('holds new rows behind the pill while the reader is scrolled down', () => {
    const { rerender } = render(<Feed items={['b', 'c']} scrolled />);
    rerender(<Feed items={['a', 'b', 'c']} scrolled />);
    expect(screen.queryByText('a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /1 New Update/ }));
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New Update/ })).toBeNull();
  });

  it('shows new rows at once to a reader at the top', () => {
    const { rerender } = render(<Feed items={['b']} />);
    rerender(<Feed items={['a', 'b']} />);
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /New Update/ })).toBeNull();
  });
});

const digits = (v) => (/^\d*$/.test(v || '') ? '' : 'Numbers only');
function Box({ serverError = '' }) {
  const [v, setV] = useState('');
  const { message, ok, onBlur, onChange } = useFieldCheck(v, digits, serverError);
  return <div onBlur={onBlur} onChange={onChange}><input aria-label="Count" value={v} onChange={(e) => setV(e.target.value)} /><FieldNote message={message} ok={ok} /></div>;
}

describe('Field Check', () => {
  it('waits for a pause, then explains, then thanks the fix', () => {
    vi.useFakeTimers();
    render(<Box />);
    const box = screen.getByRole('textbox', { name: 'Count' });
    fireEvent.change(box, { target: { value: '12a' } });
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => { vi.advanceTimersByTime(750); });
    expect(screen.getByRole('alert').textContent).toBe('Numbers only');
    fireEvent.change(box, { target: { value: '12' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Looks Good')).toBeTruthy();
  });

  it('shows the problem as soon as the person leaves the field', () => {
    render(<Box />);
    const box = screen.getByRole('textbox', { name: 'Count' });
    fireEvent.change(box, { target: { value: 'x' } });
    fireEvent.blur(box);
    expect(screen.getByRole('alert').textContent).toBe('Numbers only');
  });

  it('does not count a value set by code as typing', () => {
    vi.useFakeTimers();
    function Shifted({ v }) { const { message } = useFieldCheck(v, digits); return <FieldNote message={message} />; }
    const { rerender } = render(<Shifted v="" />);
    rerender(<Shifted v="abc" />);
    act(() => { vi.advanceTimersByTime(800); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('never scolds an untouched field, but always shows the server', () => {
    const { rerender } = render(<Box />);
    fireEvent.blur(screen.getByRole('textbox', { name: 'Count' }));
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<Box serverError="This field is required" />);
    expect(screen.getByRole('alert').textContent).toBe('This field is required');
  });
});

const ITEMS = ['IT', 'Construction', 'Admin', 'Operations'];
const list = (onReorder = vi.fn()) => {
  render(<ReorderList items={ITEMS} getKey={(x) => x} onReorder={onReorder} label="department"
    renderItem={(x, handle) => <div>{handle}<span>{x}</span><input aria-label={`name ${x}`} /></div>} />);
  // jsdom has no layout: rows 40px tall, 46px apart.
  ITEMS.forEach((k, i) => { screen.getByTestId(`drag-row-${k}`).getBoundingClientRect = () => ({ top: i * 46, height: 40 }); });
  return onReorder;
};
const grip = (k) => screen.getAllByRole('button', { name: /Drag to reorder/ })[ITEMS.indexOf(k)];

describe('Reorder List', () => {
  it('works out where a row lands', () => {
    const rects = ITEMS.map((_, i) => ({ top: i * 46, height: 40 }));
    expect(landingIndex(rects, 0, 100)).toBe(2);
    expect(landingIndex(rects, 3, -140)).toBe(0);
    expect(landingIndex(rects, 1, 5)).toBe(1);
    expect(moved(ITEMS, 0, 2)).toEqual(['Construction', 'Admin', 'IT', 'Operations']);
  });

  it('drags a row by its grip and drops it where the others made room', () => {
    const onReorder = list();
    fireEvent.pointerDown(grip('IT'), { clientY: 20, button: 0 });
    fireEvent.pointerMove(grip('IT'), { clientY: 120 });
    expect(screen.getByTestId('drag-row-Admin').style.transform).toBe('translateY(-46px)');
    fireEvent.pointerUp(grip('IT'), { clientY: 120 });
    expect(onReorder).toHaveBeenCalledWith(['Construction', 'Admin', 'IT', 'Operations']);
  });

  it('does nothing when dropped back where it was, or on Escape', () => {
    const onReorder = list();
    fireEvent.pointerDown(grip('Admin'), { clientY: 100, button: 0 });
    fireEvent.pointerUp(grip('Admin'), { clientY: 104 });
    fireEvent.pointerDown(grip('Admin'), { clientY: 100, button: 0 });
    fireEvent.pointerMove(grip('Admin'), { clientY: 0 });
    fireEvent.keyDown(grip('Admin'), { key: 'Escape' });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('moves with the arrow keys on the grip and says where', () => {
    const onReorder = list();
    fireEvent.keyDown(grip('Admin'), { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenCalledWith(['IT', 'Admin', 'Construction', 'Operations']);
    expect(screen.getByText('Moved to position 2 of 4')).toBeTruthy();
    fireEvent.keyDown(grip('IT'), { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it('moves the row it picked up even when the list changed under the drag', () => {
    const onReorder = vi.fn();
    const ui = (items) => <ReorderList items={items} getKey={(x) => x} onReorder={onReorder} label="department" renderItem={(x, h) => <div>{h}{x}</div>} />;
    const { rerender } = render(ui(ITEMS));
    ITEMS.forEach((k, i) => { screen.getByTestId(`drag-row-${k}`).getBoundingClientRect = () => ({ top: i * 46, height: 40 }); });
    fireEvent.pointerDown(grip('IT'), { clientY: 20, button: 0 });
    fireEvent.pointerMove(grip('IT'), { clientY: 120 });
    rerender(ui(['New', ...ITEMS]));
    fireEvent.pointerUp(screen.getAllByRole('button', { name: /Drag to reorder/ })[1], { clientY: 120 });
    expect(onReorder).toHaveBeenCalledWith(['New', 'Construction', 'IT', 'Admin', 'Operations']);
  });

  it('cancels with Escape even when the grip never took focus', () => {
    const onReorder = list();
    const onKey = vi.fn();
    window.addEventListener('keydown', onKey);
    fireEvent.pointerDown(grip('IT'), { clientY: 20, button: 0 });
    fireEvent.pointerMove(grip('IT'), { clientY: 120 });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.pointerUp(grip('IT'), { clientY: 120 });
    window.removeEventListener('keydown', onKey);
    expect(onReorder).not.toHaveBeenCalled();
    expect(onKey).not.toHaveBeenCalled();
  });

  it('leaves text inside the rows alone', () => {
    const onReorder = list();
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'name IT' }), { clientY: 20 });
    fireEvent.pointerMove(screen.getByRole('textbox', { name: 'name IT' }), { clientY: 120 });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
