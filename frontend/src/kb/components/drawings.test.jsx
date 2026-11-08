// Drawings (11/07/2026): every drawing the server allows exists here and
// vice versa, each one renders, and an unknown name draws nothing.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import Drawing, { DRAWING_NAMES } from './drawings';
import Figure from './Figure';

afterEach(cleanup);

describe('drawings', () => {
  it('names match backend/kb_blocks.py DRAWING_NAMES', () => {
    const py = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'backend', 'kb_blocks.py'), 'utf8');
    const block = py.slice(py.indexOf('DRAWING_NAMES = ('), py.indexOf(')', py.indexOf('DRAWING_NAMES = (')));
    const server = [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect([...server].sort()).toEqual([...DRAWING_NAMES].sort());
  });
  it('every drawing renders as an SVG with an accessible name', () => {
    for (const name of DRAWING_NAMES) {
      const { container, unmount } = render(<Drawing name={name} title={name} />);
      const svg = container.querySelector('svg.kb-drawing');
      expect(svg, name).toBeTruthy();
      expect(svg.getAttribute('aria-label')).toBe(name);
      expect(svg.querySelectorAll('path, rect, circle, line').length, name).toBeGreaterThan(2);
      unmount();
    }
  });
  it('an unknown drawing draws nothing, and the figure kinds carry drawings', () => {
    const { container } = render(<Drawing name="unicorn" />);
    expect(container.innerHTML).toBe('');
    cleanup();
    render(<Figure kind="drawings" data={{ title: 'RVs', items: [{ draw: 'rv-class-a', label: 'Class A', note: '25 to 45 ft' }, { draw: 'rv-pop-up', label: 'Pop-up' }] }} />);
    expect(document.querySelectorAll('.kb-fig-draw svg').length).toBe(2);
    cleanup();
    render(<Figure kind="drawing" data={{ title: 'Length', draw: 'measure-length', label: 'Hitch to bumper' }} />);
    expect(document.querySelectorAll('.kb-fig-drawing svg').length).toBe(1);
  });
});
