import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

// The announcement bar (Neil, Oct 12 2026): the weekly "New in Nexus" news,
// and - since Oct 14, when the bottom popup folded into it - "a new version is
// ready, Reload". Categories only ("2 New Features and 3 Bug Fixes"), the
// details in What's New.

const api = {
  getFeatureBanner: vi.fn(),
  dismissFeatureBanner: vi.fn(() => Promise.resolve({ ok: true })),
  getReleasedSince: vi.fn(),
};
vi.mock('../api', () => ({ api }));
const build = { stale: false };
vi.mock('../lib/useBuildVersion', () => ({ useBuildVersion: () => build.stale, RUNNING_SINCE: '2026-10-14T00:00:00Z' }));

const { default: FeatureBanner } = await import('./FeatureBanner');

const SHOW = { show: true, counts: { 'New Feature': 2, 'Bug Fix': 3 }, total: 5 };
const bar = () => screen.queryByRole('region', { name: 'New in Nexus' });

beforeEach(() => {
  vi.clearAllMocks();
  build.stale = false;
  api.getFeatureBanner.mockResolvedValue(SHOW);
  api.getReleasedSince.mockResolvedValue({ counts: {}, total: 0 });
});
afterEach(() => { cleanup(); document.documentElement.style.removeProperty('--nx-announce-h'); });

describe('the weekly New in Nexus bar', () => {
  it('says what shipped by category, bug fixes included', async () => {
    render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    const region = await screen.findByRole('region', { name: 'New in Nexus' });
    expect(region.querySelector('.feature-banner-text').textContent).toMatch(/2 New Features and 3 Bug Fixes$/);
    // The whole sentence is the hover title, so a clipped line can still be read.
    expect(region.querySelector('.feature-banner-text').title).toBe('Updates this week, including 2 New Features and 3 Bug Fixes');
    // The lead-in: the full one, and the short one phones show instead (CSS).
    expect(region.querySelector('.feature-banner-lead').textContent).toBe('Updates this week, including ');
    expect(region.querySelector('.feature-banner-lead-short').textContent).toBe('Including ');
  });

  it("opens this week's updates in a popup from the message as well as the button - never a reload (Oct 30 2026)", async () => {
    api.getFeatureBanner.mockResolvedValue({ ...SHOW, items: [
      { id: 'a', title: 'Quick Create', type: 'New Feature', module: 'Header', summary: 'A + beside the search bar.' },
    ] });
    const onNavigate = vi.fn();
    render(<FeatureBanner activeView="tasks" onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByText('2 New Features'));
    const dialog = screen.getByRole('dialog', { name: "What's New This Week" });
    expect(dialog.textContent).toContain('Quick Create');
    expect(dialog.textContent).toContain("And 4 more - see them all on What's New.");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(api.dismissFeatureBanner).toHaveBeenCalledTimes(1);          // seen for the week
    fireEvent.click(screen.getByRole('button', { name: "See All on What's New" }));
    expect(onNavigate).toHaveBeenCalledWith('whats-new');
  });

  it('closing the weekly popup folds the bar away; the bar has its own Reload too', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
      const region = await screen.findByRole('region', { name: 'New in Nexus' });
      fireEvent.click(screen.getByRole('button', { name: "See What's New" }));
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1));   // the footer one (the X is Close too)
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(region.className).toMatch(/is-closing/);
      expect(api.dismissFeatureBanner).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it("reaching What's New another way closes it for the week", async () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<FeatureBanner activeView="tasks" onNavigate={onNavigate} />);
    await screen.findByRole('region', { name: 'New in Nexus' });
    rerender(<FeatureBanner activeView="whats-new" onNavigate={onNavigate} />);
    expect(bar()).toBeNull();
    await waitFor(() => expect(api.dismissFeatureBanner).toHaveBeenCalledTimes(1));
  });

  it('dismisses for the week from the X, once, folding away', async () => {
    render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    const region = await screen.findByRole('region', { name: 'New in Nexus' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss for this week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss for this week' }));
    expect(api.dismissFeatureBanner).toHaveBeenCalledTimes(1);
    expect(region.className).toMatch(/is-closing/);
    expect(bar()).not.toBeNull();                       // still folding...
    fireEvent.animationEnd(region);                     // ...until its own animation ends
    expect(bar()).toBeNull();
  });

  it('stays quiet when the server says so', async () => {
    api.getFeatureBanner.mockResolvedValue({ show: false });
    render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    await waitFor(() => expect(api.getFeatureBanner).toHaveBeenCalled());
    expect(bar()).toBeNull();
  });

  it('takes its height off the full-height views while it shows', async () => {
    render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    await screen.findByRole('region', { name: 'New in Nexus' });
    expect(document.documentElement.style.getPropertyValue('--nx-announce-h')).toMatch(/px$/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss for this week' }));
    fireEvent.animationEnd(screen.getByRole('region', { name: 'New in Nexus' }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--nx-announce-h')).toBe(''));
  });
});

describe('a new version, in the same bar', () => {
  const update = () => screen.queryByRole('region', { name: 'New Version of Nexus' });
  const mount = (activeView = 'tasks') => render(<FeatureBanner activeView={activeView} onNavigate={() => {}} />);
  beforeEach(() => { api.getFeatureBanner.mockResolvedValue({ show: false }); });

  it("says what the new version brings, by category, with Reload and See What's New", async () => {
    build.stale = true;
    api.getReleasedSince.mockResolvedValue({ counts: { 'New Feature': 1, 'Bug Fix': 2 }, total: 3 });
    mount();
    expect(await screen.findByText('1 New Feature')).toBeTruthy();
    const text = update().querySelector('.feature-banner-text');
    expect(text.title).toBe('Reload to get the latest version of Nexus, including 1 New Feature and 2 Bug Fixes');
    expect(update().querySelector('.feature-banner-lead-short').textContent).toBe('New Version: ');
    expect(screen.getByRole('button', { name: "See What's New" })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reload/ })).toBeTruthy();
    expect(api.getReleasedSince).toHaveBeenCalledWith('2026-10-14T00:00:00Z');
  });

  it('just offers Reload until it knows', async () => {
    build.stale = true;
    mount();
    await waitFor(() => expect(api.getReleasedSince).toHaveBeenCalled());
    expect(update().querySelector('.feature-banner-lead').textContent).toBe('Reload to get the latest version of Nexus.');
    expect(screen.queryByRole('button', { name: "See What's New" })).toBeNull();
    expect(screen.getByRole('button', { name: /Reload/ })).toBeTruthy();
  });

  it('takes the bar over from the weekly news, which it brings with it', async () => {
    api.getFeatureBanner.mockResolvedValue(SHOW);
    const { rerender } = mount();
    await screen.findByRole('region', { name: 'New in Nexus' });
    build.stale = true;
    rerender(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    expect(update()).not.toBeNull();
    expect(bar()).toBeNull();
    expect(screen.getAllByRole('region')).toHaveLength(1);   // one bar, never two
  });

  it("stays up on What's New - that page is just as stale", async () => {
    build.stale = true;
    mount('whats-new');
    await waitFor(() => expect(api.getReleasedSince).toHaveBeenCalled());
    expect(update()).not.toBeNull();
  });

  it('never asks while the build is current', async () => {
    mount();
    await act(async () => {});
    expect(api.getReleasedSince).not.toHaveBeenCalled();
    expect(update()).toBeNull();
  });

  it('dismissing it hides it for this tab only - nothing is dismissed for the week', async () => {
    api.getFeatureBanner.mockResolvedValue(SHOW);
    build.stale = true;
    mount();
    await waitFor(() => expect(api.getFeatureBanner).toHaveBeenCalled());
    const region = update();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));   // a double click is one dismissal
    expect(region.className).toMatch(/is-closing/);
    fireEvent.animationEnd(region);
    expect(update()).toBeNull();
    expect(bar()).toBeNull();                                           // the weekly news does not pop up in its place
    expect(api.dismissFeatureBanner).not.toHaveBeenCalled();
  });

  it("See What's New opens the new version's updates in a popup - no reload (Oct 29 2026)", async () => {
    build.stale = true;
    api.getReleasedSince.mockResolvedValue({ counts: { Improvement: 1, 'Bug Fix': 2 }, total: 4, items: [
      { id: 'a', title: 'Faster Shift Grid', type: 'Improvement', module: 'Shifts', summary: 'Loads in half the time.' },
      { id: 'b', title: 'Toolbar Fix', type: 'Bug Fix', module: 'Shifts', summary: '' },
      { id: 'c', title: 'Photo Fix', type: 'Bug Fix', module: 'HR', summary: '' },
    ] });
    const assign = vi.fn();
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign, reload } });
    try {
      mount();
      fireEvent.click(await screen.findByRole('button', { name: "See What's New" }));
      const dialog = screen.getByRole('dialog', { name: "What's New in This Version" });
      expect(dialog.textContent).toContain('1 Improvement');
      expect(dialog.textContent).toContain('Faster Shift Grid');
      expect(dialog.textContent).toContain('2 Bug Fixes');
      expect(dialog.textContent).toContain('And 1 more');
      expect(assign).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Later' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: "See What's New" }));
      fireEvent.click(screen.getByRole('button', { name: /Reload Now/ }));
      expect(reload).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('What the new version brings', () => {
  const update = () => screen.queryByRole('region', { name: 'New Version of Nexus' });
  it('keeps asking past the first 20 minutes, so a late-published update still gets listed', async () => {
    vi.useFakeTimers();
    try {
      build.stale = true;
      api.getFeatureBanner.mockResolvedValue({ show: false });
      api.getReleasedSince.mockResolvedValue({ counts: {}, total: 0 });
      render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
      // Ten asks two minutes apart, all before the update is published.
      await act(async () => { await vi.advanceTimersByTimeAsync(9 * 2 * 60 * 1000); });
      expect(api.getReleasedSince).toHaveBeenCalledTimes(10);
      expect(update().querySelector('.feature-banner-lead').textContent).toBe('Reload to get the latest version of Nexus.');
      // Then every ten minutes, never giving up while the tab is stale.
      api.getReleasedSince.mockResolvedValue({ counts: { 'New Feature': 1, 'Bug Fix': 1 }, total: 2 });
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000); });
      expect(api.getReleasedSince).toHaveBeenCalledTimes(11);
      expect(update().querySelector('.feature-banner-text').title)
        .toBe('Reload to get the latest version of Nexus, including 1 New Feature and 1 Bug Fix');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Reload', () => {
  it('gives the buttons back if the reload never happens (a cancelled "Leave site?")', async () => {
    vi.useFakeTimers();
    try {
      build.stale = true;
      api.getFeatureBanner.mockResolvedValue({ show: false });
      const reload = vi.fn();
      const original = window.location;
      Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
      try {
        render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
        fireEvent.click(screen.getByRole('button', { name: /Reload/ }));
        expect(reload).toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /Reloading/ }).disabled).toBe(true);
        await act(async () => { vi.advanceTimersByTime(4000); });
        expect(screen.getByRole('button', { name: /^\s*Reload$/ }).disabled).toBe(false);
      } finally {
        Object.defineProperty(window, 'location', { configurable: true, value: original });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
