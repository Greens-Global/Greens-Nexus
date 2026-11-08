// Confetti (Neil, 11/08/2026): one canvas, drawn by rAF, gone when the last
// piece dies; nothing under reduced motion. jsdom has no canvas, so a stub
// context counts the draws.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { burstConfetti } from './Confetti';

const RECT = { left: 1000, top: 600, width: 380, height: 300 };
let frames, ctx, reduce;

beforeEach(() => {
  frames = [];
  reduce = false;
  ctx = { clearRect: vi.fn(), fillRect: vi.fn(), setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(),
    rotate: vi.fn(), scale: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn() };
  HTMLCanvasElement.prototype.getContext = () => ctx;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  window.matchMedia = () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => { vi.restoreAllMocks(); document.querySelectorAll('canvas').forEach((c) => c.remove()); });

// Run the queued frames at `t` milliseconds after the burst started.
const tick = (t) => { const cbs = frames.splice(0); cbs.forEach((cb) => cb(performance.now() + t)); };

describe('Confetti', () => {
  it('mounts a canvas, draws both bursts, and removes the canvas after the life ends', () => {
    const t0 = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(t0);
    burstConfetti(RECT);
    const canvas = document.querySelector('canvas[data-nx-confetti]');
    expect(canvas).toBeTruthy();
    expect(canvas.style.pointerEvents).toBe('none');
    tick(16);
    const firstBurst = ctx.fillRect.mock.calls.length + ctx.arc.mock.calls.length;
    expect(firstBurst).toBeGreaterThan(40);
    tick(200);   // the second burst, 150 ms later
    expect(ctx.fillRect.mock.calls.length + ctx.arc.mock.calls.length).toBeGreaterThan(firstBurst + 100);
    expect(document.querySelector('canvas[data-nx-confetti]')).toBeTruthy();
    tick(2300);  // every piece's life is over
    expect(document.querySelector('canvas[data-nx-confetti]')).toBeNull();
    expect(frames.length).toBe(0);   // nothing queued: it never loops
  });

  it('does nothing under reduced motion', () => {
    reduce = true;
    burstConfetti(RECT);
    expect(document.querySelector('canvas')).toBeNull();
    expect(frames.length).toBe(0);
  });

  it('stop drops the canvas early', () => {
    const stop = burstConfetti(RECT);
    expect(document.querySelector('canvas')).toBeTruthy();
    stop();
    expect(document.querySelector('canvas')).toBeNull();
  });
});
