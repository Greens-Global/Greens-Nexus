import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import GuidedTour from './GuidedTour';

// GuidedTour on small screens (Oct 2026): the card clamps itself inside the
// visual viewport with a capped height and scrolling text, so Next/Done stay
// reachable even on a phone held landscape (~390px tall). Larger screens keep
// the original placement untouched.

const realMatchMedia = window.matchMedia;
const realW = window.innerWidth;
const realH = window.innerHeight;

function screenSize(w, h) {
  window.innerWidth = w;
  window.innerHeight = h;
  // Evaluates just the two features GuidedTour's compact query uses.
  window.matchMedia = (q) => {
    const maxW = /max-width:\s*(\d+)px/.exec(q);
    const maxH = /max-height:\s*(\d+)px/.exec(q);
    const matches = (maxW && w <= Number(maxW[1])) || (maxH && h <= Number(maxH[1]));
    return { matches: !!matches, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  };
}

function target(rect) {
  const el = document.createElement('div');
  el.setAttribute('data-tour', 'spot');
  el.scrollIntoView = () => {};
  el.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top });
  document.body.appendChild(el);
  return el;
}

const STEPS = [
  { target: 'spot', title: 'First', body: 'A long explanation. '.repeat(30) },
  { target: 'spot', title: 'Second', body: 'Short.' },
];

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-tour="spot"]').forEach((n) => n.remove());
  window.matchMedia = realMatchMedia;
  window.innerWidth = realW;
  window.innerHeight = realH;
});

const px = (v) => parseFloat(v);

describe('GuidedTour on small screens', () => {
  it('carries the guided-tour class on its root dialog', () => {
    screenSize(1400, 900);
    render(<GuidedTour steps={STEPS} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Guided walkthrough' }).classList.contains('guided-tour')).toBe(true);
  });

  it('keeps the whole card inside a 390px-tall landscape phone', async () => {
    screenSize(844, 390);
    target({ top: 300, left: 40, width: 200, height: 40 });   // near the bottom: no room below
    render(<GuidedTour steps={STEPS} onClose={() => {}} />);
    const card = screen.getByTestId('guided-tour-card');
    await waitFor(() => expect(card.style.top).not.toBe('50%'));
    expect(px(card.style.maxHeight)).toBe(390 - 24);
    expect(px(card.style.top)).toBeGreaterThanOrEqual(12);
    expect(px(card.style.top) + 210).toBeLessThanOrEqual(390 - 12);
    // The text scrolls; the buttons do not.
    expect(screen.getByTestId('guided-tour-body').style.overflowY).toBe('auto');
    expect(screen.getByRole('button', { name: /Next/ })).toBeTruthy();
  });

  it('clamps on a portrait phone when the target fills the screen', async () => {
    screenSize(390, 700);
    target({ top: 20, left: 0, width: 390, height: 640 });   // nothing fits above or below
    render(<GuidedTour steps={STEPS} onClose={() => {}} />);
    const card = screen.getByTestId('guided-tour-card');
    await waitFor(() => expect(card.style.top).not.toBe('50%'));
    expect(px(card.style.top) + 210).toBeLessThanOrEqual(700 - 12);
    expect(px(card.style.left)).toBeGreaterThanOrEqual(12);
    expect(px(card.style.left) + px(card.style.width)).toBeLessThanOrEqual(390 - 12);
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByText('Second')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Done/ })).toBeTruthy();
  });

  it('leaves desktop placement as it was', async () => {
    screenSize(1400, 900);
    target({ top: 100, left: 200, width: 300, height: 40 });
    render(<GuidedTour steps={STEPS} onClose={() => {}} />);
    const card = screen.getByTestId('guided-tour-card');
    await waitFor(() => expect(card.style.top).toBe('152px'));   // rect.top + height + 12
    expect(card.style.left).toBe('200px');
    expect(card.style.maxHeight).toBe('');
    expect(screen.getByTestId('guided-tour-body').style.overflowY).toBe('');
  });
});
