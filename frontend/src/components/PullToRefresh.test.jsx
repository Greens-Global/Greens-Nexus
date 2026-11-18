import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import PullToRefresh from './PullToRefresh';

// The pull only arms at the top. "The top" was window.scrollY alone, but
// Tasks, Tickets and What's New scroll in a container of their own
// (.viewport-flush) where the window never scrolls - so dragging down to
// bring a list back up reloaded the page.

const real = window.matchMedia;
beforeEach(() => { window.matchMedia = (q) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }); });
afterEach(() => { cleanup(); window.matchMedia = real; document.body.innerHTML = ''; });

const touch = (el, type, y) => fireEvent(el, Object.assign(new Event(type, { bubbles: true }), { touches: [{ clientX: 100, clientY: y }] }));
const dragDown = (el) => { touch(el, 'touchstart', 100); touch(el, 'touchmove', 130); touch(el, 'touchmove', 400); };
const indicator = () => document.querySelector('svg');

function page() {
  const scroller = document.body.appendChild(document.createElement('div'));
  const row = scroller.appendChild(document.createElement('div'));
  return { scroller, row };
}

describe('PullToRefresh', () => {
  it('arms when everything under the touch is at its top', () => {
    const { row } = page();
    render(<PullToRefresh />);
    dragDown(row);
    expect(indicator()).toBeTruthy();
  });

  it('does not arm while a list under the touch is scrolled down', () => {
    const { scroller, row } = page();
    scroller.scrollTop = 240;
    render(<PullToRefresh />);
    dragDown(row);
    expect(indicator()).toBeNull();
    fireEvent(row, new Event('touchend', { bubbles: true }));
    expect(indicator()).toBeNull();
  });

  it('does not arm when the touch starts on the scrolled list itself', () => {
    const { scroller } = page();
    scroller.scrollTop = 12;
    render(<PullToRefresh />);
    dragDown(scroller);
    expect(indicator()).toBeNull();
  });
});
