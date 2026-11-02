import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Modal } from './components';
import { setMotionEnabled } from '../lib/motion';

// Popups are sheets from the right (Neil, 11/01/2026): on a desktop the
// shared Modal docks to the right edge, full height, and slides in; a
// question (placement="center") keeps the centered card; phones keep their
// bottom sheet.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

function setViewport(isMobile) {
  globalThis.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

const overlays = () => [...document.querySelectorAll('.nx-tasks-portal.nx-overlay')];
const panelOf = (i = 0) => overlays()[i].querySelector(':scope > div');

beforeEach(() => setViewport(false));
afterEach(() => { cleanup(); setMotionEnabled(false); vi.useRealTimers(); });

describe('Modal as a sheet', () => {
  it('docks to the right edge, full height, with the body set to cascade', () => {
    render(<Modal title="Ticket #000003" onClose={() => {}} footer={<button>Done</button>}><p>body</p></Modal>);
    const overlay = overlays()[0];
    expect(overlay.style.justifyContent).toBe('flex-end');
    expect(overlay.style.alignItems).toBe('stretch');
    expect(overlay.style.padding).toBe('0px');
    const panel = panelOf();
    expect(panel.className).toContain('nx-sheet-right');
    expect(panel.className).not.toContain('nx-panel');
    expect(panel.style.height).toBe('100%');
    expect(panel.style.maxHeight).toBe('100%');
    expect(panel.style.borderRadius).toBe('16px 0 0 16px');
    expect(panel.style.width).toMatch(/60vw/);   // the 60% rule's size, unchanged (jsdom folds max() to calc())
    expect(panel.querySelector('.nx-scroll').className).toContain('nx-cascade');
  });

  it('placement="center" keeps the centered card for a question', () => {
    render(<Modal title="Delete this?" placement="center" onClose={() => {}}><p>Sure?</p></Modal>);
    const overlay = overlays()[0];
    expect(overlay.style.justifyContent).toBe('center');
    const panel = panelOf();
    expect(panel.className).toContain('nx-panel');
    expect(panel.className).not.toContain('nx-sheet-right');
    expect(panel.style.borderRadius).toBe('16px');
    expect(panel.querySelector('.nx-scroll').className).not.toContain('nx-cascade');
  });

  it('a phone keeps the full-screen bottom sheet', () => {
    setViewport(true);
    render(<Modal title="Ticket" onClose={() => {}}><p>body</p></Modal>);
    const panel = panelOf();
    expect(panel.className).toContain('nx-modal-sheet');
    expect(panel.className).not.toContain('nx-sheet-right');
  });

  it('leaves through the shared exit: the overlay is marked is-closing, then onClose fires', () => {
    vi.useFakeTimers();
    setMotionEnabled(true);
    const onClose = vi.fn();
    render(<Modal title="Ticket" onClose={onClose}><p>body</p></Modal>);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(overlays()[0].className).toContain('is-closing');
    expect(onClose).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a sheet over a sheet recedes the one beneath, and brings it back when the top one goes', () => {
    const { rerender } = render(
      <>
        <Modal title="Ticket" onClose={() => {}}><p>one</p></Modal>
        <Modal title="Create Task" onClose={() => {}}><p>two</p></Modal>
      </>,
    );
    expect(panelOf(0).hasAttribute('data-nx-under')).toBe(true);
    expect(panelOf(1).hasAttribute('data-nx-under')).toBe(false);
    rerender(<Modal title="Ticket" onClose={() => {}}><p>one</p></Modal>);
    expect(panelOf(0).hasAttribute('data-nx-under')).toBe(false);
  });

  it('a centered question over a sheet does not recede the sheet', () => {
    render(
      <>
        <Modal title="Ticket" onClose={() => {}}><p>one</p></Modal>
        <Modal title="Delete this?" placement="center" onClose={() => {}}><p>two</p></Modal>
      </>,
    );
    expect(panelOf(0).hasAttribute('data-nx-under')).toBe(false);
  });
});
