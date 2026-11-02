import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useSheetStack, sheetStackSize } from './sheetStack';

// A sheet registers itself; every sheet under the newest one carries
// data-nx-under so it recedes, and the newest one never does.
function Sheet({ id, active = true, closing = false }) {
  const ref = useRef(null);
  useSheetStack(ref, active, closing);
  return <div ref={ref} data-testid={id} className="nx-sheet-right" />;
}

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
});
