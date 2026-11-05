import { describe, it, expect } from 'vitest';
import { collectAttention, daysText } from './attention';

const day = (ds, seg, extra = {}) => ({ type: 'day', ds, seg, base: seg, segFirst: true, ...extra });

describe('collectAttention', () => {
  it('groups one kind over its days, worst first', () => {
    const rows = [
      day('2026-11-05', { in: 'a', out: '' }),          // Thu, missing out
      day('2026-11-06', { in: 'a', out: '' }),          // Fri, missing out
      day('2026-11-04', { in: 'a', out: 'b', geo: 'out_of_fence' }),
      { type: 'req', ds: '2026-11-01', req: {} },
      day('2026-11-10', { in: 'a', out: 'b', outEditStatus: 'pending', outPendingAt: 'c' }),
    ];
    const got = collectAttention(rows);
    expect(got.map(g => [g.kind, g.label, g.days])).toEqual([
      ['missing_out', 'Missing Out', 'Thu, Fri'],
      ['waiting', '2 Waiting on You', 'Sun, Tue'],
      ['off_site', 'Out of Location', 'Wed'],
    ]);
  });
  it('a shift in progress is not missing its clock-out', () => {
    const live = { in: 'a', out: '' };
    expect(collectAttention([day('2026-11-12', live)], { isLive: (s) => s === live })).toEqual([]);
  });
  it('the employee sees their own waiting requests as information', () => {
    const [w] = collectAttention([{ type: 'req', ds: '2026-11-01', req: {} }], { self: true });
    expect(w).toMatchObject({ tone: 'info', label: '1 Waiting on Your Approver' });
  });
  it('breaks that never ended and changes since approval', () => {
    const got = collectAttention([{ type: 'line', line: 'gap', ds: '2026-11-03', brk: { implicit: true } }],
      { changed: [{ date: '2026-11-02', before: 480, after: 510 }] });
    expect(got.map(g => g.kind)).toEqual(['break_open', 'changed']);
  });
  it('daysText counts past two days', () => {
    expect(daysText([{ ds: '2026-11-02' }, { ds: '2026-11-03' }, { ds: '2026-11-04' }])).toBe('3 Days');
  });
});
