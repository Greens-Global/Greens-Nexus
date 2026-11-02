import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSheetStack, sheetStackSize } from './sheetStack';

// A sheet registers itself; every sheet under the newest one carries
// data-nx-under so it recedes, and the newest one never does.
function Sheet({ id, active = true, closing = false, z }) {
  const ref = useRef(null);
  useSheetStack(ref, active, closing, z);
  return <div ref={ref} data-testid={id} className="nx-sheet-right" />;
}

// A sheet the way the Modal draws one: an overlay portaled to <body>, the
// panel inside it, and the caller's children inside the panel.
function PortalSheet({ id, z = 4000, children }) {
  const ref = useRef(null);
  useSheetStack(ref, true, false, z);
  return createPortal(
    <div data-overlay={id}><div ref={ref} data-testid={id} className="nx-sheet-right">{children}</div></div>,
    document.body,
  );
}
const under = (el) => el.hasAttribute('data-nx-under');

afterEach(() => { cleanup(); });

describe('useSheetStack', () => {
  it('marks every sheet under the newest one, and clears it when the top one unmounts', () => {
    const { getByTestId, rerender } = render(<><Sheet id="a" /><Sheet id="b" /></>);
    expect(getByTestId('a').hasAttribute('data-nx-under')).toBe(true);
    expect(getByTestId('b').hasAttribute('data-nx-under')).toBe(false);
    expect(sheetStackSize()).toBe(2);
    rerender(<><Sheet id="a" /></>);
    expect(getByTestId('a').hasAttribute('data-nx-under')).toBe(false);
    expect(sheetStackSize()).toBe(1);
  });

  it('three deep keeps only the top one upright', () => {
    const { getByTestId } = render(<><Sheet id="a" /><Sheet id="b" /><Sheet id="c" /></>);
    expect(getByTestId('a').hasAttribute('data-nx-under')).toBe(true);
    expect(getByTestId('b').hasAttribute('data-nx-under')).toBe(true);
    expect(getByTestId('c').hasAttribute('data-nx-under')).toBe(false);
  });

  it('a closing top sheet releases the one beneath while its exit still plays', () => {
    const { getByTestId, rerender } = render(<><Sheet id="a" /><Sheet id="b" /></>);
    expect(getByTestId('a').hasAttribute('data-nx-under')).toBe(true);
    rerender(<><Sheet id="a" /><Sheet id="b" closing /></>);
    expect(getByTestId('a').hasAttribute('data-nx-under')).toBe(false);
    expect(getByTestId('b').hasAttribute('data-nx-under')).toBe(false);
    expect(sheetStackSize()).toBe(1);
  });

  it('an inactive shell (a centered card, a phone sheet) never joins the stack', () => {
    const { getByTestId } = render(<><Sheet id="a" /><Sheet id="b" active={false} /></>);
    expect(getByTestId('a').hasAttribute('data-nx-under')).toBe(false);
    expect(sheetStackSize()).toBe(1);
  });

  it('same-commit nested sheets: the one later in the DOM is on top', () => {
    const { getByTestId } = render(<PortalSheet id="parent"><PortalSheet id="child" /></PortalSheet>);
    const overlays = [...document.body.querySelectorAll('[data-overlay]')];
    const later = overlays[overlays.length - 1].getAttribute('data-overlay');
    const earlier = overlays[0].getAttribute('data-overlay');
    expect(later).not.toBe(earlier);
    expect(under(getByTestId(later))).toBe(false);
    expect(under(getByTestId(earlier))).toBe(true);
  });

  it('a lower-z drawer opened under a Modal does not recede the Modal', () => {
    const { getByTestId, rerender } = render(<><Sheet id="modal" z={4000} /></>);
    rerender(<><Sheet id="modal" z={4000} /><Sheet id="drawer" z={3500} /></>);
    expect(under(getByTestId('modal'))).toBe(false);
    expect(under(getByTestId('drawer'))).toBe(true);
  });

  it('a receded sheet is inert, and both marks clear when it comes back', () => {
    const { getByTestId, rerender } = render(<><Sheet id="a" /><Sheet id="b" /></>);
    expect(getByTestId('a').hasAttribute('inert')).toBe(true);
    expect(getByTestId('b').hasAttribute('inert')).toBe(false);
    rerender(<><Sheet id="a" /></>);
    expect(getByTestId('a').hasAttribute('inert')).toBe(false);
    expect(under(getByTestId('a'))).toBe(false);
  });

  it('a cancelled close joins the stack again', () => {
    const { getByTestId, rerender } = render(<><Sheet id="a" /><Sheet id="b" /></>);
    rerender(<><Sheet id="a" /><Sheet id="b" closing /></>);
    expect(under(getByTestId('a'))).toBe(false);
    rerender(<><Sheet id="a" /><Sheet id="b" closing={false} /></>);
    expect(sheetStackSize()).toBe(2);
    expect(under(getByTestId('a'))).toBe(true);
    expect(getByTestId('a').hasAttribute('inert')).toBe(true);
    expect(under(getByTestId('b'))).toBe(false);
  });
});
