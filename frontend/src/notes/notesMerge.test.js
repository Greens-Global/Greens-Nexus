// Merging two people's saves block by block, and the history's changes view.
import { describe, it, expect } from 'vitest';
import { blocksOf, merge3, mergeNotes, mergeTitle, diffNotes } from './notesMerge';

const P = (...xs) => xs.map((x) => `<p>${x}</p>`).join('');

describe('blocksOf', () => {
  it('splits at the top level and keeps lists and players whole', () => {
    expect(blocksOf('<h2>T</h2><ul><li><p>a</p></li><li><p>b</p></li></ul><audio src="x" controls=""></audio>loose'))
      .toEqual(['<h2>T</h2>', '<ul><li><p>a</p></li><li><p>b</p></li></ul>', '<audio src="x" controls=""></audio>', '<p>loose</p>']);
    expect(blocksOf('')).toEqual([]);
  });
});

describe('mergeNotes', () => {
  const base = P('one', 'two', 'three', 'four');

  it('takes both sides when they changed different blocks', () => {
    const mine = P('ONE', 'two', 'three', 'four');
    const theirs = P('one', 'two', 'three', 'FOUR', 'five');
    expect(mergeNotes(base, mine, theirs)).toEqual({ html: P('ONE', 'two', 'three', 'FOUR', 'five'), clashes: [] });
  });

  it('a block both changed the same way is taken once', () => {
    const both = P('one', 'TWO', 'three', 'four');
    expect(mergeNotes(base, both, both).html).toBe(both);
  });

  it('a delete on one side and an edit elsewhere both land', () => {
    expect(mergeNotes(base, P('one', 'three', 'four'), P('one', 'two', 'three', 'four!')).html).toBe(P('one', 'three', 'four!'));
  });

  it('only the block both changed differently is a clash, settled per choice', () => {
    const mine = P('one', 'two by Amy', 'three', 'four', 'Amy end');
    const theirs = P('one', 'two by Bob', 'three', 'four');
    const r = mergeNotes(base, mine, theirs);
    expect(r.clashes).toHaveLength(1);
    expect(r.clashes[0].mine).toEqual(['<p>two by Amy</p>']);
    expect(r.clashes[0].theirs).toEqual(['<p>two by Bob</p>']);
    expect(r.html).toBe(P('one', 'two by Amy', 'three', 'four', 'Amy end'));
    expect(mergeNotes(base, mine, theirs, { 0: 'theirs' }).html).toBe(P('one', 'two by Bob', 'three', 'four', 'Amy end'));
    expect(mergeNotes(base, mine, theirs, { 0: 'both' }).html).toBe(P('one', 'two by Amy', 'two by Bob', 'three', 'four', 'Amy end'));
  });

  it('both adding at the end in different words is a clash, not a silent drop', () => {
    const r = merge3(['a'], ['a', 'x'], ['a', 'y']);
    expect(r).toEqual([{ ok: ['a'] }, { clash: { base: [], mine: ['x'], theirs: ['y'] } }]);
  });

  it('an empty base (a note first written in two places) still merges', () => {
    expect(mergeNotes('', P('a'), P('a')).html).toBe(P('a'));
    expect(mergeNotes('', P('a'), P('b')).clashes).toHaveLength(1);
  });
});

describe('mergeTitle', () => {
  it('one side changing wins; both differently is a clash', () => {
    expect(mergeTitle('Plan', 'Plan', 'Plan Q4')).toEqual({ title: 'Plan Q4', clash: false });
    expect(mergeTitle('Plan', 'Plan v2', 'Plan')).toEqual({ title: 'Plan v2', clash: false });
    expect(mergeTitle('Plan', 'A', 'B')).toMatchObject({ clash: true, mine: 'A', theirs: 'B' });
  });
});

describe('diffNotes', () => {
  it('marks added, removed and edited blocks, word by word', () => {
    const d = diffNotes(P('Call the vendor today', 'old line'), P('Call the HVAC vendor today', 'new <b>line</b>', 'added'));
    expect(d.changed).toBe(2);
    expect(d.added).toBe(1);
    expect(d.html).toContain('Call the <ins>HVAC </ins>vendor today');
    expect(d.html).toContain('<div class="nt-diff-add"><p>added</p></div>');
    expect(diffNotes(P('a', 'b'), P('a')).html).toBe('<p>a</p><div class="nt-diff-del"><p>b</p></div>');
  });

  it('escapes words it rebuilds', () => {
    expect(diffNotes(P('x &lt;y'), P('x &lt;z&gt;')).html).not.toContain('<z>');
  });
});
