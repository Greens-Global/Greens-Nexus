import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { readRefresh, saveRefresh, useRefreshState, resetRefreshForTests } from './refreshState';

// Oct 23 (Charmi, item 17): what a screen picked comes back on a reload of the
// same browser tab, and only on a reload.

beforeEach(() => { sessionStorage.clear(); resetRefreshForTests(); });

function Picker({ storeKey = 'test.pick' }) {
  const [v, setV] = useRefreshState(storeKey, 'a', (x) => ['a', 'b', 'c'].includes(x));
  return <button type="button" onClick={() => setV('b')}>{v}</button>;
}

describe('refreshState', () => {
  it('reads what was kept before this page loaded, once', () => {
    sessionStorage.setItem('nexus.refresh.k', JSON.stringify({ period: 'mtd' }));
    expect(readRefresh('k')).toEqual({ period: 'mtd' });
    saveRefresh('k', { period: 'ytd' });
    // Written in this page load: a screen opened again inside Nexus starts fresh.
    expect(readRefresh('k', 'fresh')).toBe('fresh');
    expect(JSON.parse(sessionStorage.getItem('nexus.refresh.k'))).toEqual({ period: 'ytd' });
  });

  it('survives bad JSON and forgets on null', () => {
    sessionStorage.setItem('nexus.refresh.bad', '{oops');
    expect(readRefresh('bad', 1)).toBe(1);
    saveRefresh('gone', 'x');
    saveRefresh('gone', null);
    expect(sessionStorage.getItem('nexus.refresh.gone')).toBeNull();
  });

  it('useRefreshState restores, refuses a value that no longer fits, and saves changes', () => {
    sessionStorage.setItem('nexus.refresh.test.pick', JSON.stringify('c'));
    const { unmount } = render(<Picker />);
    expect(screen.getByRole('button').textContent).toBe('c');
    act(() => { fireEvent.click(screen.getByRole('button')); });
    expect(JSON.parse(sessionStorage.getItem('nexus.refresh.test.pick'))).toBe('b');
    unmount();
    sessionStorage.setItem('nexus.refresh.test.other', JSON.stringify('zzz'));
    render(<Picker storeKey="test.other" />);
    expect(screen.getByRole('button').textContent).toBe('a');
  });
});
