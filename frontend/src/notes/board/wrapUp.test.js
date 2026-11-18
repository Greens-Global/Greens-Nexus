// Wrap Up (Neil, 11/12/2026): a meeting board as a Note - the pure part.
import { describe, it, expect } from 'vitest';
import { wrapUpData, wrapUpNote, wrapUpPeople } from './wrapUp';
import { sticky, linkStickies } from './stickies';
import { stampVotes } from './meet';
import { commentPin } from './markupTools';
import { newThread, withReply, withResolved } from './threads';

const NOW = 1_800_000_000_000;
const ana = { email: 'ana@x.com', name: 'Ana Ruiz' };
const bo = { email: 'bo@x.com', name: 'Bo Chen' };
const frame = (id, x, y, name, w = 360, h = 720) => ({ id, type: 'frame', x, y, width: w, height: h, name, version: 1 });
const pin = (x, y, n, thread) => commentPin({ x, y, text: thread.text, number: n, now: NOW, thread });

function board() {
  const well = sticky({ x: 20, y: 20, text: 'Gate repaired early', by: ana.email, name: ana.name, now: NOW, frameId: 'well' });
  const well2 = sticky({ x: 20, y: 260, text: 'New signs are up', by: bo.email, name: bo.name, now: NOW });   // no frameId: placed before sections carried members
  const bad = sticky({ x: 420, y: 20, text: 'Paint ran out <twice>', by: bo.email, name: bo.name, now: NOW, frameId: 'not' });
  const loose = sticky({ x: 2000, y: 0, text: 'Ask about the lift', by: ana.email, name: ana.name, now: NOW });
  const blank = sticky({ x: 2300, y: 0, text: '', now: NOW });
  let els = [frame('not', 400, 0, 'What Did Not'), frame('well', 0, 0, 'What Went Well'), ...well, ...well2, ...bad, ...loose, ...blank];
  els = stampVotes(els, new Map([[bad[0].id, [ana, bo]], [well[0].id, [bo]]]), { now: NOW });
  els = linkStickies(els, [{ boxId: bad[0].id, taskId: 'task_42' }], { now: NOW });
  const open = withReply(newThread('Who orders the paint?', ana, NOW), 'Bo will', bo, NOW);
  const done = withResolved(newThread('Is the gate locked?', bo, NOW), true, ana, NOW);
  return [...els, ...pin(430, 30, 1, open), ...pin(30, 30, 2, done)];
}

describe('wrap up', () => {
  it('reads sections in Present order, a sticky by where it sits, and only open questions', () => {
    const d = wrapUpData(board());
    expect(d.groups.map((g) => g.name)).toEqual(['What Went Well', 'What Did Not', 'Other']);
    expect(d.groups[0].items.map((i) => i.words)).toEqual(['Gate repaired early', 'New signs are up']);   // the second by where it sits
    expect(d.groups[2].items.map((i) => i.words)).toEqual(['Ask about the lift']);                          // a blank sticky is not a point
    expect(d.top.map((i) => [i.words, i.votes.count, i.votes.names])).toEqual([['Paint ran out <twice>', 2, ['Ana', 'Bo']], ['Gate repaired early', 1, ['Bo']]]);
    expect(d.questions).toEqual([{ text: 'Who orders the paint?', by: 'Ana Ruiz', replies: [{ text: 'Bo will', by: 'Bo Chen' }] }]);
    expect(d.tasks).toEqual([{ id: 'task_42', words: 'Paint ran out <twice>' }]);
  });

  it('writes the Note in the editor\'s own markup, escaped, with the board embedded and tasks linked', () => {
    const out = wrapUpNote(board(), { id: 'note_abc123', title: 'October Retro', thumbUrl: 'https://x.supabase.co/storage/v1/object/public/task-files/notes/boards/note_abc123/thumb.png' },
      { by: 'Ana Ruiz', now: new Date(2026, 10, 12, 15, 5) });
    expect(out.title).toBe('October Retro - Wrap Up 11/12/2026');
    expect(out.html.startsWith('<a data-type="boardEmbed"')).toBe(true);     // a block of its own, as Insert Board writes it
    expect(out.html).toContain('<a data-type="boardEmbed" data-note="note_abc123" data-thumb="https://x.supabase.co/storage/v1/object/public/task-files/notes/boards/note_abc123/thumb.png" title="October Retro">October Retro</a>');
    expect(out.html).toContain('Wrapped up 11/12/2026 at 3:05 PM by Ana Ruiz: 4 stickies, 3 sections, 1 open question, 1 task.');
    expect(out.html).toContain('<h2>Most Votes</h2><ul><li><strong>2 Votes</strong> - Paint ran out &lt;twice&gt; (Ana, Bo)</li><li><strong>1 Vote</strong> - Gate repaired early (Bo)</li></ul>');
    expect(out.html).toContain('<h2>What Went Well</h2><ul><li>Gate repaired early - Ana Ruiz (1 Vote - Bo)</li><li>New signs are up - Bo Chen</li></ul>');
    expect(out.html).toContain('<h2>Open Questions</h2><ul><li>Who orders the paint? - Ana Ruiz<ul><li>Bo will - Bo Chen</li></ul></li></ul>');
    expect(out.html).toContain('<h2>Tasks Made</h2><ul><li><a data-type="recordLink" data-ref="task:task_42" title="Paint ran out &lt;twice&gt;">Paint ran out &lt;twice&gt;</a></li></ul>');
    expect(out.html).not.toContain('Is the gate locked?');       // resolved: not an open question
    expect(out.html).not.toContain('<twice>');                   // nothing unescaped
    expect(out.html).not.toMatch(/[—–]/);              // plain hyphens only
    expect(out.counts).toEqual({ stickies: 4, sections: 3, questions: 1, tasks: 1, voted: 2 });
  });

  it('a board with no sections wraps up under Notes; an empty board has nothing to wrap up', () => {
    const els = sticky({ x: 0, y: 0, text: 'Just one thought', name: 'Ana Ruiz', now: NOW });
    const out = wrapUpNote(els, { id: 'note_a', title: '' }, { now: new Date(2026, 0, 5, 9, 0) });
    expect(out.title).toBe('Untitled Board - Wrap Up 01/05/2026');
    expect(out.html).toContain('<h2>Notes</h2><ul><li>Just one thought - Ana Ruiz</li></ul>');
    expect(out.html).toContain('1 sticky.');
    expect(wrapUpNote([], { id: 'note_a' })).toBeNull();
    expect(wrapUpNote(sticky({ x: 0, y: 0, text: '', now: NOW }), { id: 'note_a' })).toBeNull();
  });

  it('a vote still under way is never in a Wrap Up - only results shown on the board', () => {
    const s = sticky({ x: 0, y: 0, text: 'Idea', name: 'Ana Ruiz', now: NOW });
    const out = wrapUpNote(s, { id: 'note_a', title: 'B' }, { now: new Date(2026, 0, 5) });
    expect(out.html).not.toContain('Vote');
    expect(out.counts.voted).toBe(0);
  });

  it('is shared with the same people as the board, each as they may use it, never with its maker', () => {
    const note = { owner: 'neil@x.com', sharedWith: [{ email: 'Ana@x.com', can: 'edit' }, { email: 'bo@x.com', can: 'read' }, { email: 'ana@x.com', can: 'read' }] };
    expect(wrapUpPeople(note, 'neil@x.com')).toEqual([{ email: 'ana@x.com', can: 'edit' }, { email: 'bo@x.com', can: 'read' }]);
    // an editor pressed it: the board's owner gets it too, and the editor is not shared with themselves
    expect(wrapUpPeople(note, 'ANA@x.com')).toEqual([{ email: 'neil@x.com', can: 'edit' }, { email: 'bo@x.com', can: 'read' }]);
    expect(wrapUpPeople({ owner: 'neil@x.com' }, 'neil@x.com')).toEqual([]);
  });
});
