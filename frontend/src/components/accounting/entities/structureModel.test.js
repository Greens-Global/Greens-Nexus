import { describe, expect, it } from 'vitest';
import { focusGraph, groupInvestors, layout, pctText, wholeGraph, withLenders, wrapText } from './structureModel';

// Accounting > Entities structure charts (Neil, 11/17/2026): which part of the
// graph a chart shows, how outside investors are counted together, and the
// layout - owners above what they own, every owner of one entity on its own
// line and label, nothing in a row overlapping.

const ent = (code, label, shape = 'partnership') => ({ id: `e:${code}`, kind: 'entity', code, label, shape });
const inv = (id, label) => ({ id: `inv:${id}`, kind: 'investor', label, shape: 'individual', outside: true });
const owns = (from, to, pct) => ({ from, to, kind: 'owns', pct, source: 'ir' });

const GRAPH = {
  nodes: [
    { id: 'p:neil', kind: 'person', label: 'Neil Kadakia', shape: 'individual' },
    ent('10000', 'Greens Global, LLC'), ent('15001', 'Greens Global Inv 1, LLC'), ent('67000', 'Greens Austin, LLC'),
    ent('99000', 'Unrelated, LLC'),
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((x) => inv(x, `Investor ${x.toUpperCase()}`)),
    { id: 'a:austin', kind: 'property', label: 'Greens Austin', shape: 'property' },
  ],
  edges: [
    owns('p:neil', 'e:10000', 100), owns('e:10000', 'e:15001', 100), owns('e:15001', 'e:67000', 40),
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((x) => owns(`inv:${x}`, 'e:67000', 10)),
    { from: 'e:10000', to: 'e:67000', kind: 'manages', label: 'Manager - 4% of revenue' },
    { from: 'e:67000', to: 'a:austin', kind: 'holds' },
  ],
};

describe('structure charts', () => {
  it('writes percentages and wraps names', () => {
    expect([pctText(40), pctText(33.3333), pctText(null), pctText(12.5)]).toEqual(['40%', '33.33%', '', '12.5%']);
    expect(wrapText('Greens Global Inv 1, LLC', 17)).toEqual(['Greens Global Inv', '1, LLC']);
    expect(wrapText('A very long entity name that will not fit in two lines', 12, 2)[1].endsWith('...')).toBe(true);
  });

  it('shows one entity with every owner above it, what it holds and who manages it', () => {
    const g = focusGraph(GRAPH, '67000');
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toContain('p:neil');            // through Greens Global and Inv 1
    expect(ids).toContain('a:austin');
    expect(ids).not.toContain('e:99000');
    expect(g.edges.some((e) => e.kind === 'manages')).toBe(true);
  });

  it('counts more than five outside investors together, their percentages added', () => {
    const g = groupInvestors(focusGraph(GRAPH, '67000'), 5);
    const group = g.nodes.find((n) => n.kind === 'group');
    expect(group.label).toBe('6 Investors');
    expect(g.edges.find((e) => e.from === group.id).pct).toBe(60);
    expect(g.nodes.some((n) => n.kind === 'investor')).toBe(false);
  });

  it('lists entities with nothing recorded instead of drawing them alone', () => {
    const w = wholeGraph(GRAPH);
    expect(w.loose.map((n) => n.code)).toEqual(['99000']);
    expect(w.nodes.some((n) => n.id === 'e:99000')).toBe(false);
  });

  it('lays owners out above what they own, apart, each line ending at its own point', () => {
    const lay = layout(groupInvestors(focusGraph(GRAPH, '67000'), 5));
    const at = Object.fromEntries(lay.nodes.map((n) => [n.id, n]));
    expect(at['p:neil'].y).toBeLessThan(at['e:10000'].y);
    expect(at['e:10000'].y).toBeLessThan(at['e:15001'].y);
    expect(at['e:15001'].y).toBeLessThan(at['e:67000'].y);
    expect(at['e:67000'].y).toBeLessThan(at['a:austin'].y);
    const intoAustin = lay.edges.filter((e) => e.kind === 'owns' && e.to === 'e:67000');
    expect(new Set(intoAustin.map((e) => Math.round(e.labelAt[0]))).size).toBe(intoAustin.length);
    // Nothing on one row overlaps.
    const rows = {};
    lay.nodes.forEach((n) => { (rows[n.layer] = rows[n.layer] || []).push(n); });
    Object.values(rows).forEach((r) => {
      const xs = [...r].sort((a, b) => a.x - b.x);
      for (let i = 1; i < xs.length; i += 1) expect(xs[i].x).toBeGreaterThanOrEqual(xs[i - 1].x + xs[i - 1].w);
    });
    expect(lay.width).toBeGreaterThan(0);
  });

  it('puts lenders beside the entity, never above or below it', () => {
    const { graph, beside } = withLenders(focusGraph(GRAPH, '67000'), '67000', [{ lender: 'Chase', balance: 5900000, ratePct: 5.4 }]);
    const lay = layout(graph, { beside });
    const at = Object.fromEntries(lay.nodes.map((n) => [n.id, n]));
    expect(at['lender:0'].y + at['lender:0'].h / 2).toBe(at['e:67000'].y + at['e:67000'].h / 2);
    expect(at['lender:0'].x).toBeGreaterThan(at['e:67000'].x + at['e:67000'].w);
    expect(lay.edges.find((e) => e.kind === 'lends').side).toBe(true);
  });

  it('survives a loop in the records', () => {
    const loop = { nodes: [ent('1', 'A'), ent('2', 'B')], edges: [owns('e:1', 'e:2', 50), owns('e:2', 'e:1', 50)] };
    expect(() => layout(loop)).not.toThrow();
  });
});
