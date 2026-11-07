import { describe, it, expect } from 'vitest';
import { parseText, readNode, layout, graphFromElements, bounds, STARTERS } from './graph';

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('readNode', () => {
  it('reads the shape marks', () => {
    expect(readNode('(Start)')).toMatchObject({ label: 'Start', shape: 'terminal' });
    expect(readNode('<Ok>')).toMatchObject({ label: 'Ok', shape: 'decision' });
    expect(readNode('Approved?')).toMatchObject({ label: 'Approved?', shape: 'decision' });
    expect(readNode('{Remember}')).toMatchObject({ label: 'Remember', shape: 'note' });
    expect(readNode('- Review')).toMatchObject({ label: 'Review', shape: 'step' });
    expect(readNode('   ')).toBeNull();
  });
});

describe('parseText', () => {
  it('chains, labels and joins nodes by name, case-blind', () => {
    const g = parseText('(Start) -> Review -> Approved?\napproved? -yes-> Booked\nApproved? -no-> Review');
    expect(g.nodes.map((n) => n.label)).toEqual(['Start', 'Review', 'Approved?', 'Booked']);
    expect(g.edges).toEqual([
      { from: 'n1', to: 'n2', label: '' },
      { from: 'n2', to: 'n3', label: '' },
      { from: 'n3', to: 'n4', label: 'yes' },
      { from: 'n3', to: 'n2', label: 'no' },
    ]);
  });
  it('turns an outline into a tree and skips comments', () => {
    const g = parseText('Owner\n  Ops // the ops lead\n    Site\n  Finance\n// nothing here');
    expect(g.nodes.map((n) => n.label)).toEqual(['Owner', 'Ops', 'Site', 'Finance']);
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['n1>n2', 'n2>n3', 'n1>n4']);
  });
  it('keeps hyphens inside names', () => {
    const g = parseText('Sign-Off -> Follow-Up');
    expect(g.nodes.map((n) => n.label)).toEqual(['Sign-Off', 'Follow-Up']);
  });
  it('parses every starter into a connected graph', () => {
    for (const s of STARTERS) {
      const g = parseText(s.text);
      expect(g.nodes.length).toBeGreaterThan(3);
      expect(g.edges.length).toBeGreaterThanOrEqual(g.nodes.length - 1);
    }
  });
});

describe('layout', () => {
  it('ranks top to bottom with no overlaps, loops included', () => {
    const placed = layout(parseText(STARTERS[0].text));
    const by = Object.fromEntries(placed.nodes.map((n) => [n.label, n]));
    expect(by.Start.y).toBeLessThan(by['Gather the Details'].y);
    expect(by['Gather the Details'].y).toBeLessThan(by['Ready?'].y);
    for (const a of placed.nodes) for (const b of placed.nodes) if (a !== b) expect(overlap(a, b)).toBe(false);
  });
  it('lays left to right and starts at the origin', () => {
    const placed = layout(parseText('A -> B -> C'), { dir: 'LR', origin: { x: 100, y: 50 } });
    const [a, b, c] = placed.nodes;
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(bounds(placed)).toMatchObject({ x: 100, y: 50 });
  });
  it('centers a parent tree and keeps sizes given to it', () => {
    const placed = layout({ nodes: [{ id: 'a', label: 'A', w: 300, h: 90 }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] });
    const [a, b, c] = placed.nodes;
    expect(a).toMatchObject({ w: 300, h: 90 });
    expect(b.y).toBe(c.y);
    expect(overlap(b, c)).toBe(false);
  });
  it('survives an empty graph and a pure cycle', () => {
    expect(layout({ nodes: [], edges: [] }).nodes).toEqual([]);
    const placed = layout(parseText('A -> B -> C -> A'));
    expect(new Set(placed.nodes.map((n) => n.y)).size).toBe(3);
  });
});

describe('graphFromElements', () => {
  const els = [
    { id: 'a', type: 'rectangle', x: 10, y: 20, width: 150, height: 70, strokeColor: '#111', boundElements: [] },
    { id: 'ta', type: 'text', containerId: 'a', text: 'Review', originalText: 'Review', fontSize: 20 },
    { id: 'b', type: 'diamond', x: 300, y: 300, width: 200, height: 100 },
    { id: 'c', type: 'ellipse', x: 0, y: 500, width: 120, height: 60, isDeleted: true },
    { id: 'x', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } },
    { id: 'tx', type: 'text', containerId: 'x', text: 'yes', originalText: 'yes' },
    { id: 'loose', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: null },
    { id: 'pin', type: 'ellipse', x: 0, y: 0, width: 20, height: 20, customData: { nexusComment: { n: 1 } } },
  ];
  it('reads boxes, labels and tied arrows, never deleted ones or comment pins', () => {
    const { graph, replaced, origin } = graphFromElements(els);
    expect(graph.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([['a', 'step', 'Review'], ['b', 'decision', '']]);
    expect(graph.nodes[0].style).toMatchObject({ strokeColor: '#111', fontSize: 20 });
    expect(graph.edges).toEqual([expect.objectContaining({ from: 'a', to: 'b', label: 'yes' })]);
    expect([...replaced].sort()).toEqual(['a', 'b', 'ta', 'tx', 'x']);
    expect(origin).toEqual({ x: 10, y: 20 });
  });
  it('limits itself to the selection when there is one', () => {
    const { graph } = graphFromElements(els, { a: true });
    expect(graph.nodes.map((n) => n.id)).toEqual(['a']);
    expect(graph.edges).toEqual([]);
  });
});
