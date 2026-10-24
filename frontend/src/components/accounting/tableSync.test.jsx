import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { useEffect, useState } from 'react';

// 10/23 Accounting meeting: the shared pieces behind items 02 and 13.
// - useTableSync: a table's Sync re-reads only that table, fresh, and the
//   load a Sync asked for is the only one marked fresh.
// - SyncButton: "Sync", spinning and not clickable while it reads.
// - ControlBar: folds words away (action words, then pickers at their
//   default) before the row wraps; then (fix 10/24) moves what a screen marks
//   as less used into a More menu, level by level; wraps only when even that
//   is too wide.
// - BarSearch: a search that is an icon until it is used.
// - fitSelect: a select as wide as the option picked.

vi.mock('../../api', () => ({
  api: {},
  withFreshReads: vi.fn((fn) => fn()),
}));

import { withFreshReads } from '../../api';
import { useTableSync } from './tableSync';
import { BarMore, BarSearch, ControlBar, SyncButton, barWraps, fitSelect } from './reportControls';

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
    const got = {};
    function Fn() { const ts = useTableSync(load); useEffect(() => { got.api = ts; }); return null; }
    render(<Fn />);
    await act(async () => { await got.api.sync(); });
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
  // What sits in the More menu is not on the row.
  const boxes = [...bar.querySelectorAll('[data-w]')].filter((el) => !el.closest('.acct-bar-more-panel'));
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
  const origWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function rect() {
      const bar = this.closest?.('.acct-controlbar');
      if (bar && this.dataset?.w && !this.closest('.acct-bar-more-panel')) return layOut(bar, width).get(this);
      return orig.call(this);
    };
    // The row is `width` px wide (the More menu brings controls back when there is room).
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return this.classList?.contains('acct-controlbar') ? width : 0; } });
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = orig;
    if (origWidth) Object.defineProperty(Element.prototype, 'clientWidth', origWidth);
    else delete Element.prototype.clientWidth;
  });

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

  // Fix 10/24 (UI test: two lines at 1366 / 1440, wrapping at 1100): what a
  // screen marks as less used moves into a More menu, one level at a time.
  // Row at fold 2: 160 + 50 + [Saved 40] + [Columns 120] + 40 + gaps =
  // 442 wide; 394 without Saved; 266 without Columns too.
  const MoreBar = ({ changed = 0 }) => (
    <ControlBar>
      <select data-w="160" aria-label="Report" />
      <button type="button" data-w="140">All <span className="acct-bar-label-2" data-lw="90">entities</span></button>
      <BarMore level={2} active={changed}><button type="button" data-w="120">Columns</button></BarMore>
      <div className="acct-bar-end">
        <BarMore level={1}><button type="button" data-w="100"><span className="acct-bar-label" data-lw="60">Saved Reports</span></button></BarMore>
        <button type="button" data-w="110"><span className="acct-bar-label" data-lw="70">Export</span></button>
      </div>
    </ControlBar>
  );
  const panel = () => document.querySelector('.acct-bar-more-panel');

  it('keeps everything on the row, and no More button, while it fits', () => {
    width = 2000;
    render(<MoreBar />);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(panel().children).toHaveLength(0);
    expect(within(bar().querySelector('.acct-bar-end')).getByRole('button', { name: 'Saved Reports' })).toBeTruthy();
  });

  it('moves level 1 into More first, then level 2, before anything wraps', () => {
    width = 400;
    const { unmount } = render(<MoreBar />);
    expect(bar().dataset.fold).toBe('2');
    expect(within(panel()).getByRole('button', { name: 'Saved Reports', hidden: true })).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: 'Columns', hidden: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
    expect(barWraps(bar())).toBe(false);
    unmount();
    width = 300;
    render(<MoreBar />);
    expect(within(panel()).getByRole('button', { name: 'Saved Reports', hidden: true })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Columns', hidden: true })).toBeTruthy();
    expect(barWraps(bar())).toBe(false);
  });

  it('brings them back out when the row is wide again', () => {
    width = 300;
    const { rerender } = render(<MoreBar />);
    expect(within(panel()).getByRole('button', { name: 'Columns', hidden: true })).toBeTruthy();
    width = 2000;
    rerender(<MoreBar />);
    expect(panel().children).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(bar().dataset.fold).toBeUndefined();
  });

  it('opens the More menu with the words, counts what is changed in it, and closes on Escape or a click outside', () => {
    width = 300;
    render(<MoreBar changed={1} />);
    const more = screen.getByRole('button', { name: 'More (1 changed)' });
    expect(panel().hidden).toBe(true);
    fireEvent.click(more);
    expect(panel().hidden).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel().hidden).toBe(true);
    fireEvent.click(more);
    fireEvent.pointerDown(document.body);
    expect(panel().hidden).toBe(true);
    // A plain action inside closes it; one that opens its own dropdown keeps it open.
    fireEvent.click(more);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Columns', hidden: true }));
    expect(panel().hidden).toBe(true);
  });
});

describe('BarSearch', () => {
  const Search = () => {
    const [q, setQ] = useState('');
    return <ControlBar><BarSearch value={q} onChange={setQ} label="Filter questions" placeholder="Filter questions" /></ControlBar>;
  };

  it('is an icon until it is used, stays open with text in it, and Escape clears and closes it', () => {
    render(<Search />);
    expect(screen.queryByRole('textbox', { name: 'Filter questions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Filter questions' }));
    const box = screen.getByRole('textbox', { name: 'Filter questions' });
    fireEvent.change(box, { target: { value: 'rent' } });
    fireEvent.blur(box);
    expect(screen.getByRole('textbox', { name: 'Filter questions' }).value).toBe('rent');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Filter questions' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Filter questions' })).toBeNull();
    // Empty and left: back to the icon.
    fireEvent.click(screen.getByRole('button', { name: 'Filter questions' }));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Filter questions' }));
    expect(screen.getByRole('button', { name: 'Filter questions' })).toBeTruthy();
  });
});

describe('fitSelect', () => {
  it('is as wide as the option picked, within bounds', () => {
    expect(fitSelect('Custom Dates').width).toBe('clamp(64px, calc(12ch + 34px), 320px)');
    expect(fitSelect('', { min: 110 }).width).toContain('110px');
    expect(fitSelect('This Quarter · 10/01/2026 - 12/31/2026', { max: 300 }).width).toContain('300px');
  });
});
