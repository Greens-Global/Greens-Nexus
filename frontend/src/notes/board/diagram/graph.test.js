import { describe, it, expect } from 'vitest';
import { parseText, readNode, layout, graphFromElements, bounds, STARTERS, edgeRoute, edgePorts, obstacles, nodeSize, glyphBox, routeAll, bestRoute } from './graph';

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

describe('groups, arrow kinds and icons (11/08/2026)', () => {
  const SITE = 'Escondido:\n  Office | building -> Gate | lock\n  Units A-C:\n    Drive-Up Units | warehouse\n    Climate Units | thermometer\nGate => Drive-Up Units\nGate -.-> Cameras | cctv';
  it('opens a group on a line ending in a colon, with one group inside it', () => {
    const g = parseText(SITE);
    const by = Object.fromEntries(g.nodes.map((n) => [n.label, n]));
    expect(g.nodes.map((n) => n.label)).toEqual(['Office', 'Gate', 'Drive-Up Units', 'Climate Units', 'Cameras']);
    expect(g.groups).toEqual([
      { id: 'g1', label: 'Escondido', glyph: '', parent: '', members: [by.Office.id, by.Gate.id] },
      { id: 'g2', label: 'Units A-C', glyph: '', parent: 'g1', members: [by['Drive-Up Units'].id, by['Climate Units'].id] },
    ]);
    // a member line under a group hangs from no box - only the group holds it
    expect(g.edges.some((e) => e.to === by['Drive-Up Units'].id && e.from === by.Office.id)).toBe(false);
    expect(g.notes).toEqual([]);
  });
  it('folds a third level into the group it is in, and says so', () => {
    const g = parseText('A:\n  B:\n    C:\n      Deep\n    Inner');
    expect(g.groups.map((x) => [x.label, x.parent])).toEqual([['A', ''], ['B', 'g1']]);
    expect(g.groups[1].members.length).toBe(2);
    expect(g.notes[0]).toMatch(/two levels deep/);
  });
  it('drops an empty group and keeps an outline inside a group', () => {
    const g = parseText('Empty:\nTeam:\n  Lead\n    Member');
    expect(g.groups.map((x) => x.label)).toEqual(['Team']);
    expect(g.groups[0].members.length).toBe(2);
    expect(g.edges).toEqual([{ from: 'n1', to: 'n2', label: '' }]);
  });
  it('reads the three arrows, each with a label, and keeps -> and → as normal', () => {
    const g = parseText('A => B\nB =yes=> C\nC -no-> D\nD -.-> E\nE -.nightly sync.-> F\nF → G\nSign-Off -> Follow-Up');
    expect(g.edges.slice(0, 6)).toEqual([
      { from: 'n1', to: 'n2', label: '', kind: 'main' },
      { from: 'n2', to: 'n3', label: 'yes', kind: 'main' },
      { from: 'n3', to: 'n4', label: 'no' },
      { from: 'n4', to: 'n5', label: '', kind: 'dashed' },
      { from: 'n5', to: 'n6', label: 'nightly sync', kind: 'dashed' },
      { from: 'n6', to: 'n7', label: '' },
    ]);
    expect(g.nodes.map((n) => n.label)).toContain('Sign-Off');
  });
  it('puts icons on boxes and groups, a drawing by its short name, and notes an unknown one', () => {
    const g = parseText('Hosting | cloud:\n  [Gate | lock]\n  (Start) | flag\n  Fence | drawing:fence\n  Thing | not-an-icon');
    expect(g.groups[0].glyph).toBe('cloud');
    expect(g.nodes.map((n) => [n.label, n.shape, n.glyph || ''])).toEqual([
      ['Gate', 'step', 'lock'], ['Start', 'terminal', ''], ['Fence', 'step', 'drawing:facility-fence'], ['Thing', 'step', ''],
    ]);
    expect(g.notes.join(' ')).toMatch(/"flag".*"Start"|"not-an-icon"/);
    expect(g.notes.some((n) => /not-an-icon/.test(n))).toBe(true);
  });
  it('lays a group round its members with even padding, inner groups inside, nothing sticking out', () => {
    const placed = layout(parseText(SITE));
    const inside = (r, o) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h;
    const [outer, inner] = placed.groups;
    expect(outer.parent).toBe('');
    expect(inside(inner, outer)).toBe(true);
    for (const g of placed.groups) {
      for (const id of g.members) expect(inside(placed.nodes.find((n) => n.id === id), g)).toBe(true);
    }
    const cameras = placed.nodes.find((n) => n.label === 'Cameras');
    expect(overlap(cameras, outer)).toBe(false);
    for (const a of placed.nodes) for (const b of placed.nodes) if (a !== b) expect(overlap(a, b)).toBe(false);
    expect(bounds(placed).h).toBeGreaterThanOrEqual(outer.h);
  });
  it('routes every arrow in right angles, clear of every other box and group label', () => {
    for (const dir of ['TB', 'LR']) {
      const placed = layout(parseText(`${SITE}\nOffice -> Cameras\nDrive-Up Units -> Office`), { dir });
      const at = new Map(placed.nodes.map((n) => [n.id, n]));
      for (const e of placed.edges) {
        const pts = edgeRoute(at.get(e.from), at.get(e.to), placed, 6);
        for (let i = 0; i + 1 < pts.length; i += 1) expect(pts[i][0] === pts[i + 1][0] || pts[i][1] === pts[i + 1][1]).toBe(true);
        const others = obstacles(placed, [e.from, e.to]).slice(0, placed.nodes.length - 2);
        for (let i = 0; i + 1 < pts.length; i += 1) {
          const seg = { x: Math.min(pts[i][0], pts[i + 1][0]), y: Math.min(pts[i][1], pts[i + 1][1]), w: Math.abs(pts[i][0] - pts[i + 1][0]), h: Math.abs(pts[i][1] - pts[i + 1][1]) };
          for (const o of others) expect(seg.x < o.x + o.w && seg.x + seg.w > o.x && seg.y < o.y + o.h && seg.y + seg.h > o.y).toBe(false);
        }
      }
    }
  });
  it('spreads arrows that share a side of a box, in the order of where they go', () => {
    const placed = layout(parseText('Hub -> Left\nHub -> Right\nHub -> Middle\nAsk? -> Yes\nAsk? -> No'));
    const ports = edgePorts(placed);
    const at = new Map(placed.nodes.map((n) => [n.id, n]));
    const hub = placed.edges.map((e, i) => [at.get(e.to).x, ports[i].from]).slice(0, 3).sort((p, q) => p[0] - q[0]);
    expect(hub.map((p) => p[1])).toEqual([0.3, 0.5, 0.7]);
    expect(ports.slice(3).map((p) => p.from)).toEqual([0.5, 0.5]);   // a diamond keeps its tip
    const starts = placed.edges.slice(0, 3).map((e, i) => edgeRoute(at.get(e.from), at.get(e.to), placed, 0, ports[i])[0][0]);
    expect(new Set(starts).size).toBe(3);
  });
  it('routes the whole diagram at once exactly as one arrow at a time', () => {
    for (const dir of ['TB', 'LR']) {
      const placed = layout(parseText(`${SITE}\nOffice -> Cameras\nDrive-Up Units -> Office`), { dir });
      const at = new Map(placed.nodes.map((n) => [n.id, n]));
      const ports = edgePorts(placed);
      expect(routeAll(placed, 6)).toEqual(placed.edges.map((e, i) => edgeRoute(at.get(e.from), at.get(e.to), placed, 6, ports[i])));
    }
  });
  it('when every way round crosses something, takes the one through the fewest', () => {
    const wall = (x) => ({ x, y: 0, w: 10, h: 100 });
    const obs = [wall(20), wall(40), wall(60)];
    const through3 = [[0, 50], [100, 50]];
    const through1 = [[0, 50], [30, 50], [30, 200]];
    const through2 = [[0, 50], [50, 50], [50, 200]];
    expect(bestRoute([through3, through1, through2], obs)).toBe(through1);
    const clear = [[0, 150], [100, 150]];
    expect(bestRoute([through3, clear], obs)).toBe(clear);
  });
  it('makes a box with a glyph taller, its glyph above the words', () => {
    expect(nodeSize('Gate', 'step', 'lock').h).toBeGreaterThan(nodeSize('Gate').h);
    const gb = glyphBox({ x: 0, y: 0, w: 140, h: 90, shape: 'step', glyph: 'lock' });
    expect(gb).toMatchObject({ x: 60, y: 10, w: 20, h: 20 });
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
  it('takes the selection and every box an arrow ties to it, so no arrow is left behind', () => {
    const { graph } = graphFromElements(els, { a: true });
    expect(graph.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(graph.edges).toHaveLength(1);
  });
  it('reads the builder\'s groups back: whole groups move, containers, labels and glyphs are replaced', () => {
    const grouped = [
      { id: 'G:box', type: 'rectangle', x: 0, y: 0, width: 400, height: 300, groupIds: ['G'], customData: { nexusGroup: { gid: 'G', label: 'Site', glyph: 'building', parent: '' } } },
      { id: 'G:label', type: 'text', x: 12, y: 10, groupIds: ['G'], customData: { nexusGroupLabel: 'G' } },
      { id: 'G:glyph:0', type: 'line', groupIds: ['G'], customData: { nexusGlyphOf: 'G' } },
      { id: 'I:box', type: 'rectangle', x: 20, y: 150, width: 300, height: 120, groupIds: ['I', 'G'], customData: { nexusGroup: { gid: 'I', label: 'Units', glyph: '', parent: 'G' } } },
      { id: 'a', type: 'rectangle', x: 30, y: 50, width: 140, height: 64, groupIds: ['a:glyph', 'G'], customData: { nexusGlyph: 'lock' } },
      { id: 'a:glyph:0', type: 'line', groupIds: ['a:glyph', 'G'], customData: { nexusGlyphOf: 'a' } },
      { id: 'b', type: 'rectangle', x: 30, y: 170, width: 140, height: 64, groupIds: ['I', 'G'] },
      { id: 'c', type: 'rectangle', x: 200, y: 170, width: 140, height: 64, groupIds: ['I', 'G', 'mine'] },
      { id: 'x', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, customData: { nexusEdge: 'main' }, groupIds: ['G'] },
    ];
    const { graph, replaced, origin } = graphFromElements(grouped, { a: true });
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);   // c has no arrow, but its group moves whole
    expect(graph.nodes.find((n) => n.id === 'a').glyph).toBe('lock');
    expect(graph.nodes.find((n) => n.id === 'c').style.groupIds).toEqual(['mine']);
    expect(graph.groups).toEqual([
      { id: 'G', label: 'Site', glyph: 'building', parent: '', members: ['a'] },
      { id: 'I', label: 'Units', glyph: '', parent: 'G', members: ['b', 'c'] },
    ]);
    expect(graph.edges[0]).toMatchObject({ from: 'a', to: 'b', kind: 'main' });
    for (const id of ['G:box', 'G:label', 'G:glyph:0', 'I:box', 'a:glyph:0', 'x']) expect(replaced.has(id)).toBe(true);
    expect(origin).toEqual({ x: 0, y: 0 });
    expect(graphFromElements(grouped).graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(graphFromElements(grouped, { 'I:box': true }).graph.nodes.length).toBe(3);
    expect(layout(graph).groups.map((g) => g.id)).toEqual(['G', 'I']);
  });
  const site = () => [
    { id: 'G:box', type: 'rectangle', x: 0, y: 0, width: 400, height: 300, groupIds: ['G'], customData: { nexusGroup: { gid: 'G', label: 'Site', glyph: 'building', parent: '' } } },
    { id: 'G:label', type: 'text', x: 34, y: 10, text: 'Site', groupIds: ['G'], customData: { nexusGroupLabel: 'G', nexusGlyph: 'building' } },
    { id: 'G:glyph:0', type: 'line', x: 12, y: 11, groupIds: ['G'], customData: { nexusGlyphOf: 'G' } },
    { id: 'a', type: 'rectangle', x: 30, y: 70, width: 140, height: 64, groupIds: ['G'] },
    { id: 'b', type: 'rectangle', x: 30, y: 200, width: 140, height: 64, groupIds: ['G', 'mine'] },
    { id: 'x', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, groupIds: ['G'] },
  ];
  const without = (list, ...ids) => list.map((e) => (ids.includes(e.id) ? { ...e, isDeleted: true } : e));
  const relabel = (list, text) => list.map((e) => (e.id === 'G:label' ? { ...e, text, originalText: text } : e));
  it('keeps a group renamed on the board (its label text wins over the name saved on the box)', () => {
    const { graph } = graphFromElements(relabel(site(), 'Escondido North'));
    expect(graph.groups).toEqual([{ id: 'G', label: 'Escondido North', glyph: 'building', parent: '', members: ['a', 'b'], named: true }]);
    expect(graphFromElements(site()).graph.groups[0].named).toBeUndefined();
    expect(layout(graph).groups[0]).toMatchObject({ label: 'Escondido North', named: true });
  });
  it('draws a group again from its label when only its box was deleted, so nothing typed is lost', () => {
    const { graph, replaced, origin } = graphFromElements(without(relabel(site(), 'North'), 'G:box'));
    expect(graph.groups).toEqual([{ id: 'G', label: 'North', glyph: 'building', parent: '', members: ['a', 'b'], named: true }]);
    for (const id of ['G:label', 'G:glyph:0']) expect(replaced.has(id)).toBe(true);
    expect(origin).toEqual({ x: 0, y: 0 });
  });
  it('clears what is left of a group whose box and label were deleted: its icon goes, its id leaves the boxes', () => {
    const { graph, replaced } = graphFromElements(without(site(), 'G:box', 'G:label'));
    expect(graph.groups).toEqual([]);
    expect(replaced.has('G:glyph:0')).toBe(true);
    expect(graph.nodes.find((n) => n.id === 'a').style.groupIds).toEqual([]);
    expect(graph.nodes.find((n) => n.id === 'b').style.groupIds).toEqual(['mine']);
    expect(graph.edges[0].style.groupIds).toEqual([]);
  });
  it('with nothing selected, leaves loose boxes (markup round a picture) where they are', () => {
    const loose = [...els, { id: 'mark', type: 'rectangle', x: 900, y: 900, width: 50, height: 50 }];
    const { graph, replaced } = graphFromElements(loose);
    expect(graph.nodes.map((n) => n.id)).not.toContain('mark');
    expect(replaced.has('mark')).toBe(false);
    expect(graphFromElements(loose, { mark: true }).graph.nodes.map((n) => n.id)).toEqual(['mark']);
  });
});
