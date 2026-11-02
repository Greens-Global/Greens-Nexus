import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import Modal from './Modal';
import { setMotionEnabled } from '../../lib/motion';

// The marketing Modal follows the app's popup rule (Neil, 11/01/2026): a sheet
// from the right on a desktop, a centered card for a question, the phone's
// own shape on a phone, and a sheet over a sheet recedes the one beneath.

function setViewport(isMobile) {
  globalThis.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

const overlays = () => [...document.querySelectorAll('.nx-overlay')];
const panelOf = (i = 0) => overlays()[i].querySelector(':scope > div');

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); setMotionEnabled(false); vi.useRealTimers(); });

describe('marketing Modal', () => {
  it('is a sheet by default: right edge, full height, left corners rounded, cascading body', () => {
    render(<Modal title="Add Facility" onClose={() => {}}><p>body</p></Modal>);
    const overlay = overlays()[0];
    expect(overlay.style.justifyContent).toBe('flex-end');
    expect(overlay.style.alignItems).toBe('stretch');
    const panel = panelOf();
    expect(panel.className).toContain('nx-sheet-right');
    expect(panel.className).toContain('is-entering');
    expect(panel.style.height).toBe('100%');
    expect(panel.style.borderRadius).toBe('16px 0 0 16px');
    expect(panel.style.boxShadow).toContain('-8px 0 40px');
    expect(panel.querySelector('.nx-cascade')).not.toBeNull();
  });

  it('placement="center" keeps the centered card', () => {
    render(<Modal title="Delete this?" placement="center" onClose={() => {}}><p>Sure?</p></Modal>);
    expect(overlays()[0].style.justifyContent).toBe('center');
    const panel = panelOf();
    expect(panel.className).toContain('nx-panel');
    expect(panel.className).not.toContain('nx-sheet-right');
    expect(panel.className).not.toContain('is-entering');
    expect(panel.querySelector('.nx-cascade')).toBeNull();
  });

  it('a phone never gets the desktop sheet', () => {
    setViewport(true);
    render(<Modal title="Add Facility" onClose={() => {}}><p>body</p></Modal>);
    expect(panelOf().className).not.toContain('nx-sheet-right');
  });

  it('a sheet over a sheet recedes the one beneath and brings it back', () => {
    const { rerender } = render(<Modal title="One" onClose={() => {}}><p>one</p></Modal>);
    rerender(<><Modal title="One" onClose={() => {}}><p>one</p></Modal><Modal title="Two" onClose={() => {}}><p>two</p></Modal></>);
    expect(panelOf(0).hasAttribute('data-nx-under')).toBe(true);
    expect(panelOf(0).hasAttribute('inert')).toBe(true);
    expect(panelOf(1).hasAttribute('data-nx-under')).toBe(false);
    rerender(<Modal title="One" onClose={() => {}}><p>one</p></Modal>);
    expect(panelOf(0).hasAttribute('data-nx-under')).toBe(false);
    expect(panelOf(0).hasAttribute('inert')).toBe(false);
  });

  it('a sheet waits its 220ms slide-out before onClose', () => {
    vi.useFakeTimers();
    setMotionEnabled(true);
    const onClose = vi.fn();
    render(<Modal title="One" onClose={onClose}><p>one</p></Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(overlays()[0].className).toContain('is-closing');
    act(() => { vi.advanceTimersByTime(219); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
