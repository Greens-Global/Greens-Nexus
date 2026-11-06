// @vitest-environment node
// A pivot that cannot fit stops while it reads, not after (round five). Plain node:
// timing in jsdom measures the DOM shim and the other test files, not this code.
import { it, expect } from 'vitest';
import { makeCtx } from './model.js';
import { createEngine } from './formula/eval.js';
import { computePivot } from './pivot.js';

it('a 200,000-key pivot says too large, fast', () => {
  const rows = Array.from({ length: 200001 }, (_, i) => `r${i}`), cols = ['ca', 'cb'];
  const cells = new Map([[`${rows[0]}.ca`, { v: 'Key' }], [`${rows[0]}.cb`, { v: 'Amount' }]]);
  for (let i = 1; i < rows.length; i += 1) { cells.set(`${rows[i]}.ca`, { v: `k${i}` }); cells.set(`${rows[i]}.cb`, { v: i }); }
  const ctx = makeCtx([{ id: 'src', name: 'Src', rows, cols, cells, sizes: new Map() }]);
  const cfg = { src: { tab: 'src', r1: rows[0], c1: 'ca', r2: rows[200000], c2: 'cb' }, at: { r: rows[0], c: 'ca' }, rows: [{ col: 'ca' }], cols: [], values: [{ col: 'cb', fn: 'SUM' }], filters: [], totals: true };
  const t0 = performance.now();
  const res = computePivot(createEngine(ctx), ctx, cfg);
  expect(res.error).toMatch(/too large/);
  expect(performance.now() - t0).toBeLessThan(500);
});
