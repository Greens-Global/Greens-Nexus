import { describe, it, expect, afterEach } from 'vitest';
import { weekKey, getWeek, putWeek, prefetchWeek, clearWeeks } from './weekCache';

afterEach(() => clearWeeks());

describe('the planner week cache', () => {
  it('keeps each person their own copy', () => {
    putWeek(weekKey('Amy@x.com', '2026-11-02', '2026-11-08'), { who: 'amy' });
    expect(getWeek(weekKey('amy@x.com', '2026-11-02', '2026-11-08'))).toEqual({ who: 'amy' });
    expect(getWeek(weekKey('bob@x.com', '2026-11-02', '2026-11-08'))).toBeNull();
  });
  it('keeps the twelve newest weeks', () => {
    for (let i = 0; i < 14; i += 1) putWeek(weekKey('a', `s${i}`, 'e'), { i });
    expect(getWeek(weekKey('a', 's0', 'e'))).toBeNull();
    expect(getWeek(weekKey('a', 's13', 'e'))).toEqual({ i: 13 });
  });
  it('reads a week ahead once, and never again while it is fresh', async () => {
    let n = 0;
    const key = weekKey('a', 's', 'e');
    prefetchWeek(key, () => { n += 1; return Promise.resolve({ ok: 1 }); });
    prefetchWeek(key, () => { n += 1; return Promise.resolve({ ok: 2 }); });   // already on its way
    await new Promise((r) => setTimeout(r, 0));
    prefetchWeek(key, () => { n += 1; return Promise.resolve({ ok: 3 }); });   // fresh
    expect(n).toBe(1);
    expect(getWeek(key)).toEqual({ ok: 1 });
  });
  it('a read-ahead that fails is simply not there', async () => {
    prefetchWeek(weekKey('a', 'x', 'y'), () => Promise.reject(new Error('500')));
    await new Promise((r) => setTimeout(r, 0));
    expect(getWeek(weekKey('a', 'x', 'y'))).toBeNull();
  });
});
