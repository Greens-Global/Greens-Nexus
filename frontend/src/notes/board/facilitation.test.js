// Stickies, the meeting kit and comment threads (Neil, 11/10/2026) - the pure parts.
import { describe, it, expect } from 'vitest';
import {
  sticky, stickyParts, withStickyText, nextSpot, sortStickies, selectedStickies, stickyWords,
  linkStickies, refreshedStickyFeet, votable, fitWords, STICKY_SIZE, STICKY_GAP,
} from './stickies';
import {
  startTimer, timeLeft, addMinute, pauseTimer, resumeTimer, stopTimer, clock,
  startVote, myVotes, toggleVote, tally, castCount, clearVotes, voteLine, stampVotes, readMeet, startSilent, endSilent,
} from './meet';
import { pinParts, selectedPin, threadOf, withThread, newThread, withReply, withResolved, mentionsIn, mentionAt } from './threads';
import { commentPin } from './markupTools';
import { KIT_GROUPS, kitLabel } from './siteKit';

const NOW = 1_800_000_000_000;
const ana = { email: 'ana@x.com', name: 'Ana Ruiz' };
const bo = { email: 'bo@x.com', name: 'Bo Chen' };

describe('stickies', () => {
  it('a sticky is paper, words and an author line in one group', () => {
    const [box, words, foot] = sticky({ x: 10, y: 20, text: 'Fix the gate', by: 'ANA@x.com', name: 'Ana Ruiz Lopez', colorKey: 'pink', now: NOW });
    expect(box).toMatchObject({ type: 'rectangle', width: STICKY_SIZE, height: STICKY_SIZE, customData: { nexusSticky: { by: 'ana@x.com', color: 'pink' } } });
    expect(words).toMatchObject({ containerId: box.id, originalText: 'Fix the gate' });
    expect(foot).toMatchObject({ text: 'Ana Ruiz', customData: { nexusStickyFoot: box.id } });
    expect(new Set([box, words, foot].map((e) => e.groupIds[0])).size).toBe(1);
  });

  it('long words shrink to fit the paper', () => {
    expect(fitWords('short').size).toBe(20);
    expect(fitWords('word '.repeat(60)).size).toBeLessThan(20);
  });

  it('withStickyText rewrites the words with a newer version; nextSpot steps past a sticky already there', () => {
    const a = sticky({ x: 0, y: 0, now: NOW });
    const b = sticky({ x: STICKY_SIZE + STICKY_GAP, y: 0, now: NOW });
    const els = withStickyText([...a, ...b], a[0].id, 'Hello', { now: NOW });
    const p = stickyParts(els).get(a[0].id);
    expect(stickyWords(p)).toBe('Hello');
    expect(p.text.version).toBe(2);
    expect(nextSpot(a[0], 'right', els)).toEqual({ x: 2 * (STICKY_SIZE + STICKY_GAP), y: 0 });
    expect(nextSpot(a[0], 'down', els)).toEqual({ x: 0, y: STICKY_SIZE + STICKY_GAP });
  });

  it('sort by color puts each color in its own labeled column and replaces the last sort headings', () => {
    const els = [
      ...sticky({ x: 0, y: 0, text: 'a', colorKey: 'yellow', now: NOW }),
      ...sticky({ x: 500, y: 0, text: 'b', colorKey: 'pink', now: NOW }),
      ...sticky({ x: 900, y: 0, text: 'c', colorKey: 'pink', now: NOW }),
    ];
    const once = sortStickies(els, null, 'color', { now: NOW });
    const heads = once.filter((e) => e.customData?.nexusSortHead && !e.isDeleted).map((e) => e.text);
    expect(heads).toEqual(['Pink (2)', 'Yellow (1)']);
    const twice = sortStickies(once, null, 'author', { now: NOW });
    expect(twice.filter((e) => e.customData?.nexusSortHead && !e.isDeleted).map((e) => e.text)).toEqual(['Someone (3)']);
    const one = els.slice(0, 3);
    expect(sortStickies(one, null, 'color')).toBe(one);   // one sticky: nothing to sort
  });

  it('sort by word groups stickies under the word they share', () => {
    const els = [
      ...sticky({ x: 0, y: 0, text: 'Paint the gate', now: NOW }),
      ...sticky({ x: 300, y: 0, text: 'Oil the gate hinge', now: NOW }),
      ...sticky({ x: 600, y: 0, text: 'New signs', now: NOW }),
    ];
    const heads = sortStickies(els, null, 'word', { now: NOW }).filter((e) => e.customData?.nexusSortHead).map((e) => e.text);
    expect(heads).toEqual(['Gate (2)', 'Other (1)']);
  });

  it('selection by any part; linked stickies carry the task and the foot follows its state', () => {
    const a = sticky({ x: 0, y: 100, text: 'one', now: NOW });
    const b = sticky({ x: 0, y: 0, text: 'two', now: NOW });
    const els = [...a, ...b];
    expect(selectedStickies(els, { [a[1].id]: true, [b[2].id]: true }).map(stickyWords)).toEqual(['two', 'one']);
    const linked = linkStickies(els, [{ boxId: a[0].id, taskId: 't9' }], { now: NOW });
    const box = linked.find((e) => e.id === a[0].id);
    expect(box.customData.nexusRecord.ref).toBe('task:t9');
    expect(linked.find((e) => e.id === a[2].id).text).toBe('Task');
    const feet = refreshedStickyFeet(linked, { t9: { done: true } }, { now: NOW });
    expect(feet.map((f) => f.text)).toEqual(['Task - Done']);
    expect(refreshedStickyFeet(linked, {}, { now: NOW })).toEqual([]);
  });

  it('votable: stickies and worded boxes, never comment pins', () => {
    const [box] = sticky({ x: 0, y: 0, now: NOW });
    expect(votable(box, null)).toBe(true);
    expect(votable({ type: 'rectangle' }, null)).toBe(false);
    expect(votable({ type: 'ellipse' }, { id: 't' })).toBe(true);
    expect(votable({ type: 'rectangle', customData: { nexusComment: 1 } }, { id: 't' })).toBe(false);
  });
});

describe('meeting kit', () => {
  it('timer: start, pause, resume, add a minute, stop', () => {
    const m = new Map();
    startTimer(m, 300, ana, NOW);
    expect(clock(timeLeft(m.get('timer'), NOW + 1000))).toBe('4:59');
    pauseTimer(m, NOW + 60_000);
    expect(timeLeft(m.get('timer'), NOW + 999_999)).toBe(240_000);
    addMinute(m, NOW);
    resumeTimer(m, NOW + 100_000);
    expect(timeLeft(m.get('timer'), NOW + 100_000)).toBe(300_000);
    stopTimer(m);
    expect(readMeet(m).timer).toBeNull();
    expect(clock(3_722_000)).toBe('1:02:02');
    expect(timeLeft(null)).toBe(0);
  });

  it('named votes: one row per voter, capped per person, stamped with names', () => {
    const m = new Map();
    startVote(m, { perPerson: 2, ...ana }, NOW);
    const vote = m.get('vote');
    expect(toggleVote(m, vote, ana, 's1')).toBe(true);
    expect(toggleVote(m, vote, ana, 's2')).toBe(true);
    expect(toggleVote(m, vote, ana, 's3')).toBe(false);
    expect(toggleVote(m, vote, bo, 's1')).toBe(true);
    expect(toggleVote(m, vote, ana, 's2')).toBe(true);   // takes it back
    expect(myVotes(m, vote, ana.email)).toEqual(['s1']);
    const t = tally(m, vote);
    expect(castCount(t)).toBe(2);
    expect(voteLine(t.get('s1'))).toBe('2 Votes - Ana, Bo');
    const [box] = sticky({ x: 0, y: 0, now: NOW });
    const stale = { ...sticky({ x: 400, y: 0, now: NOW })[0], customData: { nexusSticky: { color: 'yellow' }, nexusVotes: { count: 1, names: ['X'] } } };
    const out = stampVotes([{ ...box, id: 's1' }, stale], t, { now: NOW });
    expect(out.find((e) => e.id === 's1').customData.nexusVotes).toEqual({ count: 2, names: ['Ana Ruiz', 'Bo Chen'] });
    expect(out.find((e) => e.id === stale.id).customData.nexusVotes).toBeUndefined();
    expect(out.find((e) => e.customData?.nexusVoteLine === 's1').text).toBe('2 Votes - Ana, Bo');
    expect(stampVotes(out, new Map(), { now: NOW }).filter((e) => e.customData?.nexusVoteLine && !e.isDeleted)).toHaveLength(0);
    clearVotes(m);
    expect([...m.keys()]).toEqual([]);
  });

  it('Private Writing on and off', () => {
    const m = new Map();
    startSilent(m, ana, NOW);
    expect(readMeet(m).silent).toMatchObject({ by: 'ana@x.com', name: 'Ana Ruiz' });
    endSilent(m);
    expect(readMeet(m).silent).toBeNull();
    expect(readMeet(null)).toEqual({ timer: null, vote: null, silent: null });
  });
});

describe('comment threads', () => {
  const pin = () => commentPin({ x: 0, y: 0, text: 'Check this', number: 3, now: NOW });

  it('a pin carries its thread; replies and Resolve redraw it in place', () => {
    const els = pin();
    const [box, text] = els;
    expect(selectedPin(els, { [text.id]: true })).toBe(box.id);
    expect(selectedPin(els, {})).toBe('');
    const part = pinParts(els).get(box.id);
    expect(threadOf(part).text).toBe('Check this');
    let t = newThread('Check this', ana, NOW);
    t = withReply(t, ' Done ', bo, NOW + 1);
    t = withResolved(t, true, bo, NOW + 2);
    const next = withThread(els, box.id, t, { now: NOW });
    const nb = next.find((e) => e.id === box.id);
    expect(nb.customData.nexusThread.replies.map((r) => r.text)).toEqual(['Done']);
    expect(nb.version).toBeGreaterThan(box.version);
    expect(next.find((e) => e.id === text.id).text).toMatch(/1 Reply/);
    expect(threadOf(pinParts(next).get(box.id)).resolved).toMatchObject({ by: 'bo@x.com' });
    expect(withReply(t, 'again', ana).resolved).toBeNull();
  });

  it('mentions: full names after @, and the @word at the caret', () => {
    const people = [ana, bo, { email: '', name: 'No Mail' }];
    expect(mentionsIn('ping @Ana Ruiz and @bo chen', people)).toEqual(['ana@x.com', 'bo@x.com']);
    expect(mentionsIn('nobody', people)).toEqual([]);
    expect(mentionAt('hi @An', 6)).toEqual({ start: 3, query: 'An' });
    expect(mentionAt('mail a@b', 8)).toBeNull();
  });
});

describe('site kit', () => {
  it('every group has drawings and labels read as Title Case', () => {
    for (const g of KIT_GROUPS) expect(g.names.length).toBeGreaterThan(0);
    expect(kitLabel('plan-pull-through')).toBe('Plan Pull Through');
    expect(kitLabel('rv-class-a')).toBe('RV Class A');
  });
});
