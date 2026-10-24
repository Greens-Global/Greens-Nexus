import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useEffect, useState } from 'react';

// 10/23 Accounting meeting: the shared pieces behind items 02 and 13.
// - useTableSync: a table's Sync re-reads only that table, fresh, and the
//   load a Sync asked for is the only one marked fresh.
// - SyncButton: "Sync", spinning and not clickable while it reads.
// - ControlBar: folds words away (action words, then pickers at their
//   default) before the row wraps; wraps only when even that is too wide.
// - fitSelect: a select as wide as the option picked.

vi.mock('../../api', () => ({
  api: {},
  withFreshReads: vi.fn((fn) => fn()),
}));

import { withFreshReads } from '../../api';
import { useTableSync } from './tableSync';
import { ControlBar, SyncButton, barWraps, fitSelect } from './reportControls';

beforeEach(() => { vi.clearAllMocks(); });

function KeyTable({ read }) {
  const ts = useTableSync();
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { ts.read(read).then(setRows); }, [ts.tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <input aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <SyncButton onSync={ts.sync} syncedAt={ts.syncedAt} />
      <ul>{(rows || []).filter((r) => r.includes(filter)).map((r) => <li key={r}>{r}</li>)}</ul>
    </div>
  );
}

describe('useTableSync', () => {
  it('reads again on Sync, fresh only for that read, and keeps what was typed', async () => {
    let n = 0;
    const read = vi.fn(async () => { n += 1; return [`Row ${n}a`, `Row ${n}b`]; });
    render(<KeyTable read={read} />);
    expect(await screen.findByText('Row 1a')).toBeTruthy();
    expect(withFreshReads).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText('Row 2a')).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    expect(withFreshReads).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Filter').value).toBe('a');
    expect(screen.queryByText('Row 2b')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync' }).title).toMatch(/Last synced \d{1,2}:\d{2} (AM|PM)/);
  });

  it('runs a load function with fresh reads', async () => {
    const load = vi.fn(async () => 'done');
    let api;
    function Fn() { api = useTableSync(load); return null; }
    render(<Fn />);
    await act(async () => { await api.sync(); });
    expect(load).toHaveBeenCalledTimes(1);
    expect(withFreshReads).toHaveBeenCalledWith(load);
  });
});

describe('SyncButton', () => {
  it('says Sync, names its table when there are several, and waits while busy', () => {
    const onSync = vi.fn();
    const { rerender } = render(<SyncButton onSync={onSync} what="Runs" />);
    const b = screen.getByRole('button', { name: 'Sync Runs' });
    expect(b.textContent).toContain('Sync');
    expect(b.title).toContain('the runs again');
    fireEvent.click(b);
    expect(onSync).toHaveBeenCalledTimes(1);
    rerender(<SyncButton onSync={onSync} what="Runs" busy />);
    expect(b.textContent).toContain('Syncing...');
    fireEvent.click(b);
    expect(onSync).toHaveBeenCalledTimes(1);
  });
});

// jsdom does no layout: each box says where it is through getBoundingClientRect.
// A row `width` px wide lays its boxes left to right and wraps when one does
// not fit; a box with a hidden word (data-fold on the bar) is narrower.
function layOut(bar, width) {
  const boxes = [...bar.querySelectorAll('[data-w]')];
  const fold = bar.dataset.fold || '';
  const w = (el) => {
    const label = el.querySelector('.acct-bar-label');
    const label2 = el.querySelector('.acct-bar-label-2');
    let v = Number(el.dataset.w);
    if (label && fold) v -= Number(label.dataset.lw);
    if (label2 && fold === '2') v -= Number(label2.dataset.lw);
    return v;
  };
  let x = 0;
  let y = 0;
  const out = new Map();
  boxes.forEach((el) => {
    const bw = w(el);
    if (x && x + bw > width) { x = 0; y += 40; }
    out.set(el, { left: x, right: x + bw, width: bw, top: y, bottom: y + 30, height: 30 });
    x += bw + 8;
  });
  return out;
}

describe('ControlBar', () => {
  let width = 2000;
  const orig = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function rect() {
      const bar = this.closest?.('.acct-controlbar');
      if (bar && this.dataset?.w) return layOut(bar, width).get(this);
      return orig.call(this);
    };
  });
  afterEach(() => { Element.prototype.getBoundingClientRect = orig; });

  const Bar = () => (
    <ControlBar>
      <select data-w="160" aria-label="Report" />
      <button type="button" data-w="140">All <span className="acct-bar-label-2" data-lw="90">entities</span></button>
      <div className="acct-bar-end">
        <button type="button" data-w="120"><span className="acct-bar-label" data-lw="80">Customize</span></button>
        <button type="button" data-w="110"><span className="acct-bar-label" data-lw="70">Export</span></button>
      </div>
    </ControlBar>
  );
  const bar = () => document.querySelector('.acct-controlbar');

  it('keeps every word on a wide window', () => {
    width = 2000;
    render(<Bar />);
    expect(bar().dataset.fold).toBeUndefined();
    expect(barWraps(bar())).toBe(false);
  });

  it('folds the action words first, then the default picker words, before it wraps', () => {
    width = 480;    // 160 + 140 + 120 + 110 + gaps: too wide; without the action words it fits
    render(<Bar />);
    expect(bar().dataset.fold).toBe('1');
    width = 380;    // needs the picker words gone too
    render(<Bar />);
    expect(document.querySelectorAll('.acct-controlbar')[1].dataset.fold).toBe('2');
  });

  it('wraps cleanly, as whole controls, when even the icons do not fit', () => {
    width = 200;
    render(<Bar />);
    expect(bar().dataset.fold).toBe('2');
    expect(barWraps(bar())).toBe(true);
  });
});

describe('fitSelect', () => {
  it('is as wide as the option picked, within bounds', () => {
    expect(fitSelect('Custom Dates').width).toBe('clamp(64px, calc(12ch + 34px), 320px)');
    expect(fitSelect('', { min: 110 }).width).toContain('110px');
    expect(fitSelect('This Quarter · 10/01/2026 - 12/31/2026', { max: 300 }).width).toContain('300px');
  });
});
