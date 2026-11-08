// Figures (11/07/2026): every kind draws from its data, an unknown kind draws
// nothing, and the reader's Blocks hands a figure node to it.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import Figure, { FIGURE_TEMPLATES, FIGURE_KINDS } from './Figure';
import Blocks from './Blocks';

afterEach(cleanup);

describe('Figure', () => {
  it('draws every kind from its template', () => {
    for (const kind of FIGURE_KINDS) {
      const { unmount } = render(<Figure kind={kind} data={FIGURE_TEMPLATES[kind]} />);
      expect(screen.getByRole('group', { name: FIGURE_TEMPLATES[kind].title })).toBeTruthy();
      unmount();
    }
  });
  it('draws sizes to one scale and bars as a share of the max', () => {
    render(<Figure kind="sizes" data={{ title: 'Sizes', unit: 'ft', items: [{ name: '5x5', w: 5, h: 5 }, { name: '10x30', w: 10, h: 30 }] }} />);
    const boxes = document.querySelectorAll('.kb-fig-box');
    expect(boxes.length).toBe(2);
    expect(Math.abs(parseInt(boxes[1].style.height, 10) - 6 * parseInt(boxes[0].style.height, 10))).toBeLessThanOrEqual(6);   // one scale, to the pixel
    cleanup();
    render(<Figure kind="bars" data={{ title: 'Bars', max: 100, items: [{ label: 'Half', value: 50 }, { label: 'Range', low: 25, value: 75 }] }} />);
    const fills = document.querySelectorAll('.kb-fig-track i');
    expect(fills[0].style.width).toBe('50%');
    expect(fills[1].style.left).toBe('25%');
    expect(fills[1].style.width).toBe('50%');
    expect(screen.getByText('25 to 75')).toBeTruthy();
  });
  it('draws nothing for an unknown kind and renders through Blocks', () => {
    const { container } = render(<Figure kind="pie" data={{ title: 'No' }} />);
    expect(container.innerHTML).toBe('');
    render(<Blocks doc={{ type: 'doc', content: [{ type: 'figure', attrs: { kind: 'timeline', data: { title: 'Days', items: [{ at: 'Day 0', label: 'Rent is due' }, { at: 'Day 11', label: 'Late fee', tone: 'warn' }] } } }] }} />);
    expect(screen.getByText('Rent is due')).toBeTruthy();
    expect(screen.getByText('Day 11')).toBeTruthy();
  });
});
