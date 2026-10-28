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
//   is too wide. Round 3: a summary shortens before anything moves, as many
//   levels move at once as the row needs, they come back as soon as there is
//   room, and nothing moves while a menu from the bar is open.
// - BarSummary: the summary figures, shortened with their tooltip, or in the
//   More menu in full.
// - BarSearch: a search that is an icon until it is used.
// - fitSelect: a select as wide as the option picked.

vi.mock('../../api', () => ({
  api: {},
  withFreshReads: vi.fn((fn) => fn()),
}));

import { withFreshReads } from '../../api';
import { useTableSync } from './tableSync';
import { BarMore, BarSearch, BarSummary, ControlBar, SyncButton, barWraps, fitSelect } from './reportControls';

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
// not fit; a box with a hidden word (data-fold on the bar) is narrower, a
// shortened summary is its max-width, and the More button is 30 px.
const MORE_BTN = 30;
const onRow = (el) => (!!el.dataset?.w || el.classList?.contains('acct-bar-more-btn')) && !el.closest('.acct-bar-more-panel');
function layOut(bar, width) {
  // What sits in the More menu is not on the row.
  const boxes = [...bar.querySelectorAll('[data-w], .acct-bar-more-btn')].filter(onRow);
  const fold = bar.dataset.fold || '';
  const w = (el) => {
    if (el.classList.contains('acct-bar-more-btn')) return MORE_BTN;
    const label = el.querySelector('.acct-bar-label');
    const label2 = el.querySelector('.acct-bar-label-2');
    let v = Number(el.dataset.w);
    if (label && fold) v -= Number(label.dataset.lw);
    if (label2 && fold === '2') v -= Number(label2.dataset.lw);
    if (el.style.maxWidth) v = Math.min(v, parseFloat(el.style.maxWidth));
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
      if (bar && onRow(this)) return layOut(bar, width).get(this);
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
  // screen marks as less used moves into a More menu, level by level. The
  // More button takes its own 30 px. Row widths with gaps of 8:
  //   level 0, fold 2: 160 + 50 + 120 + 140 + 40       = 542
  //   level 1, fold 2: 160 + 50 + 120 + 40 + More 30   = 432
  //   level 2, fold 1: 160 + 140 + 40 + More 30        = 394 (fold 2: 304)
  const MoreBar = ({ changed = 0 }) => (
    <ControlBar>
      <select data-w="160" aria-label="Report" />
      <button type="button" data-w="140">All <span className="acct-bar-label-2" data-lw="90">entities</span></button>
      <BarMore level={2} active={changed}><button type="button" data-w="120">Columns</button></BarMore>
      <div className="acct-bar-end">
        <BarMore level={1}><button type="button" data-w="200"><span className="acct-bar-label" data-lw="60">Saved Reports</span></button></BarMore>
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
    width = 450;
    const { unmount } = render(<MoreBar />);
    expect(bar().dataset.fold).toBe('2');
    expect(within(panel()).getByRole('button', { name: 'Saved Reports', hidden: true })).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: 'Columns', hidden: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
    expect(barWraps(bar())).toBe(false);
    unmount();
    // Round 3: both levels in one go, and with the room that leaves, the picker's words come back.
    width = 400;
    render(<MoreBar />);
    expect(within(panel()).getByRole('button', { name: 'Saved Reports', hidden: true })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Columns', hidden: true })).toBeTruthy();
    expect(bar().dataset.fold).toBe('1');
    expect(barWraps(bar())).toBe(false);
  });

  it('brings them back out when the row is wide again - both levels at once', () => {
    width = 400;
    const { rerender } = render(<MoreBar />);
    expect(within(panel()).getByRole('button', { name: 'Columns', hidden: true })).toBeTruthy();
    width = 2000;
    rerender(<MoreBar />);
    expect(panel().children).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(bar().dataset.fold).toBeUndefined();
  });

  it('follows the row when only its width changes (the sidebar opening and closing)', () => {
    const ros = [];
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; ros.push(this); } observe() {} disconnect() {} };
    try {
      width = 2000;
      render(<MoreBar />);
      expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
      width = 450;    // the sidebar opens: the row is narrower, nothing on the screen drew again
      act(() => ros.forEach((o) => o.cb([])));
      expect(within(panel()).getByRole('button', { name: 'Saved Reports', hidden: true })).toBeTruthy();
      expect(barWraps(bar())).toBe(false);
      width = 2000;   // and closes
      act(() => ros.forEach((o) => o.cb([])));
      expect(panel().children).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    } finally {
      globalThis.ResizeObserver = RO;
    }
  });

  it('leaves the row alone while a menu opened from it is open, and fits it once it closes', () => {
    function MenuBar() {
      const [open, setOpen] = useState(false);
      return (
        <ControlBar>
          <select data-w="160" aria-label="Report" />
          <button type="button" data-w="140" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Columns</button>
          <BarMore level={1}><button type="button" data-w="200">Saved Reports</button></BarMore>
        </ControlBar>
      );
    }
    width = 2000;
    const { rerender } = render(<MenuBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    width = 400;    // 160 + 140 + 200 + gaps: too wide, but its menu is open
    rerender(<MenuBar />);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    expect(within(panel()).getByRole('button', { name: 'Saved Reports', hidden: true })).toBeTruthy();
    expect(barWraps(bar())).toBe(false);
  });

  it('opens the More menu with the words, counts what is changed in it, and closes on Escape or a click outside', () => {
    width = 400;
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

  // Call of 10/27 with Charmi, item 09 ("Any time we give a filter, the tab
  // changes"): a control that grew while it sat in More makes bringing it
  // back fail once; after that a pick (same widths) never moves the bar, and
  // the bar tries again only when the row needs less room. Row at 600, gaps 8:
  //   level 1, no fold: 160 + 140 + 120 + 110 + More 30 + 32 = 592 (fits)
  //   level 0, fold 2 with Saved Reports grown to 300: 642 (does not fit)
  const PickBar = ({ pick = 'All', report = 160, saved = 200 }) => (
    <ControlBar>
      <select data-w={report} aria-label="Report" />
      <button type="button" data-w="140" title={pick}>{pick} <span className="acct-bar-label-2" data-lw="90">entities</span></button>
      <BarMore level={2}><button type="button" data-w="120">Columns</button></BarMore>
      <div className="acct-bar-end">
        <BarMore level={1}><button type="button" data-w={saved}><span className="acct-bar-label" data-lw="60">Saved Reports</span></button></BarMore>
        <button type="button" data-w="110"><span className="acct-bar-label" data-lw="70">Export</span></button>
      </div>
    </ControlBar>
  );
  const state = () => ({ fold: bar().dataset.fold, inMore: [...panel().querySelectorAll('button')].map((b) => b.textContent.trim()) });
  // Each step on its own frame, as in the browser (the bar's loop guard resets per frame).
  const step = async (rerender, el) => { rerender(el); await act(async () => { await new Promise((r) => setTimeout(r, 40)); }); };

  it('item 09: after a failed unfold, a pick never moves the bar', async () => {
    width = 450;
    const { rerender } = render(<PickBar />);
    expect(state().inMore).toEqual(['Saved Reports']);
    await step(rerender, <PickBar saved={300} />);     // it grew while in More (the estimate is stale)
    width = 600;
    await step(rerender, <PickBar saved={300} />);     // the row widens: the unfold is tried, does not fit, goes back
    const settled = state();
    expect(settled.inMore).toEqual(['Saved Reports']);
    expect(settled.fold).toBeUndefined();  // Export keeps its word
    expect(barWraps(bar())).toBe(false);
    for (const pick of ['(G) Rajesh & Darshana Kadakia', 'Greens Global, Inc.', 'All']) {
      await step(rerender, <PickBar saved={300} pick={pick} />);
      expect(state()).toEqual(settled);
    }
  });

  it('item 09: tries again once the row needs less room, and brings the control back', async () => {
    width = 450;
    const { rerender } = render(<PickBar />);
    await step(rerender, <PickBar saved={300} />);
    width = 600;
    await step(rerender, <PickBar saved={300} />);
    expect(state().inMore).toEqual(['Saved Reports']);
    await step(rerender, <PickBar saved={300} report={60} />);   // 100 px less on the row: 542 at level 0, fold 2
    expect(state().inMore).toEqual([]);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(barWraps(bar())).toBe(false);
  });

  // UI test 10/27 (MRE / MRI at 1024 and 390): More read "More (1 changed)"
  // with nothing changed - the Completeness gaps were counted. Gaps are what
  // the data is missing, not a change the person made: MRE and MRI give that
  // group no `active`, so More counts only real changes (the Category here).
  it('counts only real changes on More, never the Completeness gaps moved into it', () => {
    const GapBar = ({ category = '' }) => (
      <ControlBar>
        <select data-w="160" aria-label="Report" />
        <button type="button" data-w="140">All <span className="acct-bar-label-2" data-lw="90">entities</span></button>
        <BarMore level={2} active={category ? 1 : 0}><button type="button" data-w="120">Category</button></BarMore>
        <div className="acct-bar-end">
          <BarMore level={1}><button type="button" data-w="200" aria-label="Completeness: 3 gaps"><span className="acct-bar-label" data-lw="60">Completeness</span> 3</button></BarMore>
          <button type="button" data-w="110"><span className="acct-bar-label" data-lw="70">Export</span></button>
        </div>
      </ControlBar>
    );
    width = 400;
    const { rerender } = render(<GapBar />);
    expect(within(panel()).getByRole('button', { name: 'Completeness: 3 gaps', hidden: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More' }).textContent).toBe('');
    rerender(<GapBar category="rent" />);
    expect(screen.getByRole('button', { name: 'More (1 changed)' }).textContent).toBe('1');
  });

  // Round 3 (UI test 10/24: "Loans 14 · Balance ..." pushed Loans and
  // Management Fees onto two lines even with the sidebar closed). Row widths
  // with gaps of 8 (the summary at most 120 px short):
  //   level 0, fold 2: 160 + summary 300 + 140 + 40         = 664 (484 short)
  //   level 1, fold 2: 160 + summary 300 + 40 + More 30     = 554 (374 short)
  //   level 2, fold 2: 160 + 40 + More 30                   = 246
  const SumBar = ({ summaryLevel = 0 }) => (
    <ControlBar>
      <select data-w="160" aria-label="Period" />
      <div className="acct-bar-end">
        <BarSummary data-w="300" level={summaryLevel}>Loans <strong>14</strong> · Balance <strong>16,975,000.00</strong></BarSummary>
        <BarMore level={1}><button type="button" data-w="200"><span className="acct-bar-label" data-lw="60">Customize</span></button></BarMore>
        <button type="button" data-w="110"><span className="acct-bar-label" data-lw="70">Export</span></button>
      </div>
    </ControlBar>
  );
  const summary = () => document.querySelector('.acct-bar-summary');

  it('shortens the summary, with its full text in the tooltip, before anything moves into More', () => {
    width = 2000;
    const { rerender } = render(<SumBar />);
    expect(summary().style.maxWidth).toBe('');
    expect(summary().title).toBe('Loans 14 · Balance 16,975,000.00');
    width = 500;    // 664 at fold 2: 164 px over (+2 for rounding), the summary gives them
    rerender(<SumBar />);
    expect(bar().dataset.fold).toBe('2');
    expect(summary().style.maxWidth).toBe('134px');
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(barWraps(bar())).toBe(false);
    width = 2000;   // room again: the summary in full
    rerender(<SumBar />);
    expect(summary().style.maxWidth).toBe('');
    expect(bar().dataset.fold).toBeUndefined();
  });

  it('moves a control into More once the summary is as short as it goes (120 px), and shortens it only as far as needed after', () => {
    width = 400;    // 484 even with the summary short; at level 1: 554 - 400 + 2 = 156 px off the summary
    render(<SumBar />);
    expect(within(panel()).getByRole('button', { name: 'Customize', hidden: true })).toBeTruthy();
    expect(summary().style.maxWidth).toBe('144px');
    expect(barWraps(bar())).toBe(false);
  });

  it('moves a summary with a level into More in full on a narrower row', () => {
    width = 330;
    render(<SumBar summaryLevel={2} />);
    const s = within(panel()).getByText(/Balance/).closest('.acct-bar-summary');
    expect(s).toBeTruthy();
    expect(s.style.maxWidth).toBe('');
    expect(s.title).toBe('Loans 14 · Balance 16,975,000.00');
    expect(barWraps(bar())).toBe(false);
  });

  it('counts a box that wraps inside itself (two lines of custom dates) as wrapping', () => {
    const el = document.createElement('div');
    const a = document.createElement('span');
    const b = document.createElement('span');
    el.append(a, b);
    document.body.append(el);
    a.getBoundingClientRect = () => ({ left: 0, right: 100, width: 100, top: 0, bottom: 30, height: 30 });
    b.getBoundingClientRect = () => ({ left: 108, right: 400, width: 292, top: 0, bottom: 30, height: 30 });
    expect(barWraps(el)).toBe(false);
    b.getBoundingClientRect = () => ({ left: 108, right: 400, width: 292, top: 0, bottom: 68, height: 68 });
    expect(barWraps(el)).toBe(true);
    el.remove();
  });

  it('does not count a line kept apart on purpose (an error under the controls)', () => {
    width = 2000;
    render(
      <ControlBar>
        <select data-w="160" aria-label="Period" />
        <div className="acct-bar-break" style={{ width: '100%' }}>From must be before To.</div>
      </ControlBar>,
    );
    expect(bar().dataset.fold).toBeUndefined();
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
