import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Month commentary (11/12/2026 UX pass): what is typed is kept per month -
// switching months or a newer save by someone else never overwrites it.
vi.mock('./DashContext', () => ({ useDash: () => ({}) }));
import { usePeriodDraft } from './hooks';

const run = (p) => renderHook(({ period, body, at }) => usePeriodDraft(period, body, at), { initialProps: p });

describe('usePeriodDraft', () => {
  it('shows the saved text until something is typed', () => {
    const { result } = run({ period: '2026-09', body: 'Saved', at: 't1' });
    expect(result.current).toMatchObject({ value: 'Saved', dirty: false, stale: false });
  });

  it('keeps a draft per month across a month change', () => {
    const { result, rerender } = run({ period: '2026-09', body: 'Sep saved', at: 't1' });
    act(() => result.current.set('Sep draft'));
    rerender({ period: '2026-08', body: 'Aug saved', at: 't0' });
    expect(result.current).toMatchObject({ value: 'Aug saved', dirty: false });
    rerender({ period: '2026-09', body: 'Sep saved', at: 't1' });
    expect(result.current).toMatchObject({ value: 'Sep draft', dirty: true, stale: false });
  });

  it('keeps the draft and flags it when a newer save arrives; discard shows the saved text', () => {
    const { result, rerender } = run({ period: '2026-09', body: 'Old', at: 't1' });
    act(() => result.current.set('Mine'));
    rerender({ period: '2026-09', body: 'Theirs', at: 't2' });
    expect(result.current).toMatchObject({ value: 'Mine', dirty: true, stale: true });
    act(() => result.current.discard());
    expect(result.current).toMatchObject({ value: 'Theirs', dirty: false, stale: false });
  });
});
