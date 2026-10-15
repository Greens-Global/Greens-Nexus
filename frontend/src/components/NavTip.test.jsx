import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, createEvent, act, cleanup } from '@testing-library/react';
import NavTip from './NavTip';
import ClockChip from './ClockChip';

// The sidebar's tooltips (Neil, Oct 14 2026): "Punch In" says just "Punch In",
// large; a button you cannot press says why; nothing is clipped by the folded
// rail because the tip lives on the page, not inside the sidebar.

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  // let any warm-up window lapse so one test's tip never opens the next one's instantly
  act(() => { vi.advanceTimersByTime(5000); });
  cleanup();
  vi.useRealTimers();
});

const tip = () => screen.queryByRole('tooltip');
const hover = (el) => fireEvent.pointerEnter(el, { pointerType: 'mouse' });
const wait = (ms) => act(() => { vi.advanceTimersByTime(ms); });

describe('NavTip', () => {
  it('opens after a short pause, on the page body - not inside the control', () => {
    render(<div style={{ overflow: 'hidden' }}><NavTip label="Tasks"><button type="button">T</button></NavTip></div>);
    hover(screen.getByRole('button'));
    expect(tip()).toBeNull();                   // a pass-over does not flash it
    wait(300);
    expect(tip().textContent).toBe('Tasks');
    expect(tip().parentElement).toBe(document.body);
  });

  it('a sweep across the pointer path never opens one', () => {
    render(<NavTip label="Tasks"><button type="button">T</button></NavTip>);
    const b = screen.getByRole('button');
    hover(b);
    wait(150);
    fireEvent.pointerLeave(b);
    wait(400);
    expect(tip()).toBeNull();
  });

  it('once one has shown, the next opens at once - scanning down the rail', () => {
    render(<><NavTip label="Tasks"><button type="button">A</button></NavTip><NavTip label="Tickets"><button type="button">B</button></NavTip></>);
    const [a, b] = screen.getAllByRole('button');
    hover(a); wait(300);
    fireEvent.pointerLeave(a);
    hover(b);
    expect(tip().textContent).toBe('Tickets');
  });

  it('opens on keyboard focus, not on a mouse click', () => {
    render(<NavTip label="Punch Out"><button type="button">S</button></NavTip>);
    const b = screen.getByRole('button');
    const realMatches = b.matches.bind(b);
    b.matches = (sel) => (sel === ':focus-visible' ? true : realMatches(sel));
    fireEvent.focus(b);
    wait(300);
    expect(tip().textContent).toBe('Punch Out');
    fireEvent.blur(b);
    expect(tip()).toBeNull();
  });

  it('Escape closes it, and so does pressing the control', () => {
    render(<NavTip label="Start Break"><button type="button">P</button></NavTip>);
    const b = screen.getByRole('button');
    hover(b); wait(300);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tip()).toBeNull();
    wait(5000);
    hover(b); wait(300);
    fireEvent.pointerDown(b);
    expect(tip()).toBeNull();
  });

  it('never opens for a touch - the tap is the action', () => {
    render(<NavTip label="Punch In"><button type="button">I</button></NavTip>);
    // jsdom drops pointerType from the init dict, and React builds its
    // enter event from pointerover - so set it on that event by hand.
    const b = screen.getByRole('button');
    const over = createEvent.pointerOver(b);
    Object.defineProperty(over, 'pointerType', { value: 'touch' });
    fireEvent(b, over);
    wait(1000);
    expect(tip()).toBeNull();
  });

  it("keeps the control's own ref and handlers", () => {
    const ref = { current: null };
    const onPointerEnter = vi.fn();
    render(<NavTip label="Tasks"><button ref={ref} type="button" onPointerEnter={onPointerEnter}>T</button></NavTip>);
    expect(ref.current).toBe(screen.getByRole('button'));
    hover(screen.getByRole('button'));
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
  });
});

describe('the clock buttons', () => {
  const off = { state: 'out', sinceLabel: 'Last clocked out at 4:30 PM', busy: false, actions: { punchIn: vi.fn(), openClock: vi.fn() } };

  it('Punch In says just "Punch In", with the green rule', () => {
    render(<ClockChip vm={off} variant="rail" />);
    hover(screen.getByRole('button', { name: 'Punch In' }));
    wait(300);
    expect(tip().textContent).toBe('Punch In');
    expect(tip().querySelector('.navtip-detail')).toBeNull();
    expect(tip().dataset.tone).toBe('in');
    expect(tip().dataset.side).toBe('right');   // the folded rail opens it beside the button
  });

  it('a button you cannot press says why, underneath', () => {
    render(<ClockChip vm={off} variant="wide" />);
    hover(screen.getByRole('button', { name: 'Start Break' }));
    wait(300);
    expect(tip().querySelector('.navtip-label').textContent).toBe('Start Break');
    expect(tip().querySelector('.navtip-detail').textContent).toBe('Punch in first');
    expect(screen.getByRole('button', { name: 'Start Break' }).getAttribute('aria-describedby')).toBe(tip().id);
  });
});
