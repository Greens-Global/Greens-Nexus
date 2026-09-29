import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import AnchoredMenu, { MENU_Z } from './AnchoredMenu';

// The "..." menu on the phone dashboard opened clipped under the card below
// (Sep 28): an in-place absolute menu inside a scrolling toolbar. These pin
// the fix - rendered at <body>, fixed, top layer - plus touch-friendly close.

function Harness({ onPick = () => {}, wrapStyle }) {
  const btn = useRef(null);
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="clipper" style={wrapStyle}>
      <button ref={btn} onClick={() => setOpen(o => !o)}>More</button>
      <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)} align="end">
        <button role="menuitem" onClick={() => { setOpen(false); onPick(); }}>Rename view</button>
      </AnchoredMenu>
      <div>Outside</div>
    </div>
  );
}

describe('AnchoredMenu', () => {
  it('renders at <body>, outside any clipping ancestor, on the top layer', () => {
    render(<Harness wrapStyle={{ overflowX: 'auto', transform: 'translateY(0)' }} />);
    fireEvent.click(screen.getByText('More'));
    const menu = screen.getByRole('menu');
    expect(screen.getByTestId('clipper').contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe('fixed');
    expect(Number(menu.style.zIndex)).toBe(MENU_Z);
  });

  it('runs an item and closes', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByText('More'));
    fireEvent.pointerDown(screen.getByText('Rename view'));
    fireEvent.click(screen.getByText('Rename view'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a tap outside and on Escape; the trigger toggles', () => {
    render(<Harness />);
    const more = screen.getByText('More');
    fireEvent.click(more);
    fireEvent.pointerDown(screen.getByText('Outside'));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(more);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(more);
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('treats a tap in a nested portaled picker as inside', () => {
    function Nested() {
      const btn = useRef(null);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={btn}>Add</button>
          <AnchoredMenu anchorRef={btn} open={open} onClose={() => setOpen(false)}>
            {createPortal(<div>Ash Ben</div>, document.body)}
          </AnchoredMenu>
          <div>Elsewhere</div>
        </>
      );
    }
    render(<Nested />);
    fireEvent.pointerDown(screen.getByText('Ash Ben'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes only the menu, not the modal listening behind it', () => {
    const modalEscape = vi.fn();
    const onKey = (e) => { if (e.key === 'Escape') modalEscape(); };
    document.addEventListener('keydown', onKey);
    render(<Harness />);
    fireEvent.click(screen.getByText('More'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(modalEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(modalEscape).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', onKey);
  });
});
