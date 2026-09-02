import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Modal } from './components';

// A centered card sized in `vh` does not survive mobile Safari: `vh` is the
// LARGE viewport (chrome hidden), so the old 7vh padding + 86vh card measured
// ~109% of what is actually on screen in portrait and the footer - every action
// button in it - sat under the browser's bottom bar, unreachable (Sagar,
// Sept 2 2026). Landscape hid it, because Safari's chrome is thin there.
//
// On a phone the modal is a full-screen sheet in DYNAMIC viewport units, the
// shape the task drawer already had.

vi.mock('../components/PersonHoverCard', () => ({ default: ({ children }) => children }));

function setViewport(isMobile) {
  globalThis.matchMedia = (q) => ({
    matches: isMobile && q.includes('max-width: 640px'),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  });
}

const panelOf = () => document.querySelector('.nx-tasks-portal > div');

function renderModal() {
  render(
    <Modal title="Ticket #000003" onClose={() => {}} footer={<button>Done</button>}>
      <p>body</p>
    </Modal>,
  );
}

describe('Modal on a phone', () => {
  it('fills the visible viewport rather than a vh-sized card', () => {
    setViewport(true);
    renderModal();

    const panel = panelOf();
    // The height itself is .nx-modal-sheet (100vh then 100dvh - two lines the
    // inline style object cannot hold), so what this pins is that the phone
    // takes that class and loses the vh cap that overshot the screen.
    expect(panel.className).toContain('nx-modal-sheet');
    expect(panel.style.maxHeight).toBe('');
    expect(panel.style.borderRadius).toMatch(/^0(px)?$/);   // jsdom drops the unit on 0
  });

  it('keeps the action row on screen, below a body that scrolls', () => {
    setViewport(true);
    renderModal();

    const [body, footer] = [...panelOf().children].slice(1);
    expect(body.style.overflowY).toBe('auto');
    expect(body.style.flex).toContain('1');       // the body absorbs the height…
    expect(body.style.minHeight).toMatch(/^0(px)?$/);   // …and may shrink to do it
    expect(footer.style.flexShrink).toBe('0');    // so the buttons never move off
    expect(footer.style.padding).toContain('env(safe-area-inset-bottom)');
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('is unchanged on desktop', () => {
    setViewport(false);
    renderModal();

    const panel = panelOf();
    expect(panel.style.maxHeight).toBe('86vh');
    expect(panel.style.borderRadius).toBe('16px');
    expect(panel.className).not.toContain('nx-modal-sheet');
  });
});
