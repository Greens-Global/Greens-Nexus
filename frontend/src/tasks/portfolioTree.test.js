import { describe, it, expect } from 'vitest';
import { portfolioRowTree, portfolioDeepProjectIds } from './lib';

// Portfolios nest, and the list draws that tree as flat rows with a depth. Two
// rules decide what appears, they pull in opposite directions, and neither
// fails loudly when it is wrong - a row is simply in the wrong place:
//
//   - a child shows only while its parent is EXPANDED
//   - a child WHOSE PARENT IS FILTERED AWAY is lifted to the top instead of
//     vanishing with a parent nobody asked about
//
// The first cut had the lift unconditional, so collapsing a parent made its
// sub-portfolios pop out as top-level rows (Neil, Sept 7). These pin both.

const PFS = [
  { id: 'acct', name: 'Accounting', parentId: '', projectIds: ['p-acct'] },
  { id: 'nexus', name: 'Nexus', parentId: '', projectIds: ['p-gen'] },
  { id: 'mods', name: 'Nexus Modules', parentId: 'nexus', projectIds: ['p-dash', 'p-clock'] },
  { id: 'deep', name: 'Deeper Still', parentId: 'mods', projectIds: ['p-deep'] },
];
const names = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.pf.name}`);

describe('portfolioRowTree', () => {
  it('shows only top-level portfolios when nothing is expanded', () => {
    expect(names(portfolioRowTree(PFS, PFS, new Set()))).toEqual(['Accounting', 'Nexus']);
  });

  it('reveals a sub-portfolio only once its parent is expanded', () => {
    expect(names(portfolioRowTree(PFS, PFS, new Set(['nexus']))))
      .toEqual(['Accounting', 'Nexus', '  Nexus Modules']);
  });

  it('keeps a grandchild hidden until its own parent is expanded too', () => {
    expect(names(portfolioRowTree(PFS, PFS, new Set(['nexus', 'mods']))))
      .toEqual(['Accounting', 'Nexus', '  Nexus Modules', '    Deeper Still']);
  });

  it('collapsing a parent takes its whole subtree with it', () => {
    // The regression: these used to reappear as top-level rows.
    const rows = portfolioRowTree(PFS, PFS, new Set(['mods']));
    expect(names(rows)).toEqual(['Accounting', 'Nexus']);
  });

  it('lifts a child whose parent is filtered out, rather than losing it', () => {
    // Searching "modules" leaves the child in `visible` but not its parent.
    const visible = PFS.filter((p) => p.id === 'mods');
    expect(names(portfolioRowTree(visible, PFS, new Set()))).toEqual(['Nexus Modules']);
  });

  it('orders siblings by the filtered lists own order', () => {
    const reversed = [...PFS].reverse();
    expect(names(portfolioRowTree(reversed, PFS, new Set()))).toEqual(['Nexus', 'Accounting']);
  });

  it('does not hang on a cyclic table', () => {
    const cyclic = [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }];
    const rows = portfolioRowTree(cyclic, cyclic, new Set(['a', 'b']));
    expect(rows.length).toBeLessThanOrEqual(2);
  });
});

describe('portfolioDeepProjectIds', () => {
  it('collects a parents own projects and every descendants', () => {
    expect(portfolioDeepProjectIds(PFS[1], PFS).sort())
      .toEqual(['p-clock', 'p-dash', 'p-deep', 'p-gen']);
  });

  it('is just its own projects for a leaf', () => {
    expect(portfolioDeepProjectIds(PFS[0], PFS)).toEqual(['p-acct']);
  });

  it('does not hang on a cyclic table', () => {
    const cyclic = [
      { id: 'a', name: 'A', parentId: 'b', projectIds: ['p1'] },
      { id: 'b', name: 'B', parentId: 'a', projectIds: ['p2'] },
    ];
    expect(portfolioDeepProjectIds(cyclic[0], cyclic).sort()).toEqual(['p1', 'p2']);
  });
});

// The EXPORT walks the same tree with every node expanded. Collapsing hides
// children on screen, but that is a viewing convenience - exporting a collapsed
// Portfolios list handed back three top-level rows and silently dropped every
// sub-portfolio (Neil, Sept 8). Search and the archived toggle still apply,
// because those really are filters.
describe('portfolioRowTree for export (everything expanded)', () => {
  const allExpanded = (pfs) => new Set(pfs.map((p) => p.id));

  it('includes every level, whatever is collapsed on screen', () => {
    expect(names(portfolioRowTree(PFS, PFS, allExpanded(PFS))))
      .toEqual(['Accounting', 'Nexus', '  Nexus Modules', '    Deeper Still']);
  });

  it('still honours the filters, so an export matches what was searched', () => {
    // Archived / search removed Accounting: it must not come back for the file.
    const visible = PFS.filter((p) => p.id !== 'acct');
    expect(names(portfolioRowTree(visible, PFS, allExpanded(PFS))))
      .toEqual(['Nexus', '  Nexus Modules', '    Deeper Still']);
  });
});
