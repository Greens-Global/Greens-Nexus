import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

// The weekly "New in Nexus" bar and the new-version popup (Neil, Oct 12 2026):
// categories only ("2 new features and 3 bug fixes"), the details in What's New.

const api = {
  getFeatureBanner: vi.fn(),
  dismissFeatureBanner: vi.fn(() => Promise.resolve({ ok: true })),
  getReleasedSince: vi.fn(),
};
vi.mock('../api', () => ({ api }));
const build = { stale: false };
vi.mock('../lib/useBuildVersion', () => ({ useBuildVersion: () => build.stale }));

const { default: FeatureBanner } = await import('./FeatureBanner');
const { default: UpdateBanner } = await import('./UpdateBanner');
const { __resetUpdateSignal } = await import('../lib/updateSignal');

const SHOW = { show: true, counts: { 'New Feature': 2, 'Bug Fix': 3 }, total: 5 };
const bar = () => screen.queryByRole('region', { name: 'New in Nexus' });

beforeEach(() => {
  vi.clearAllMocks();
  build.stale = false;
  api.getFeatureBanner.mockResolvedValue(SHOW);
  api.getReleasedSince.mockResolvedValue({ counts: {}, total: 0 });
  __resetUpdateSignal();
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

  it("opens What's New from the message as well as the button", async () => {
    const onNavigate = vi.fn();
    render(<FeatureBanner activeView="tasks" onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByText('2 New Features'));
    expect(onNavigate).toHaveBeenCalledWith('whats-new');
  });

  it('its link only navigates; reaching What\'s New is what closes it for the week', async () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<FeatureBanner activeView="tasks" onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByRole('button', { name: "See What's New" }));
    expect(onNavigate).toHaveBeenCalledWith('whats-new');
    // Not yet dismissed: the move could still be cancelled at an unsaved-changes prompt.
    expect(api.dismissFeatureBanner).not.toHaveBeenCalled();
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

describe('the new-version popup', () => {
  const both = () => render(<><UpdateBanner /><FeatureBanner activeView="tasks" onNavigate={() => {}} /></>);
  beforeEach(() => { api.getFeatureBanner.mockResolvedValue({ show: false }); });

  it('says what the new version brings, by category, with See What\'s New', async () => {
    build.stale = true;
    api.getReleasedSince.mockResolvedValue({ counts: { 'New Feature': 1, 'Bug Fix': 2 }, total: 3 });
    both();
    expect(await screen.findByText('Including 1 New Feature and 2 Bug Fixes.')).toBeTruthy();
    expect(screen.getByText('A New Version of Nexus Is Available')).toBeTruthy();
    expect(screen.getByRole('button', { name: /See What's New/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reload/ })).toBeTruthy();
  });

  it('says bug fixes too, when that is all it brings', async () => {
    build.stale = true;
    api.getReleasedSince.mockResolvedValue({ counts: { 'Bug Fix': 3 }, total: 3 });
    both();
    expect(await screen.findByText('Including 3 Bug Fixes.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /See What's New/ })).toBeTruthy();
  });

  it('just offers Reload until it knows', async () => {
    build.stale = true;
    both();
    await waitFor(() => expect(api.getReleasedSince).toHaveBeenCalled());
    expect(screen.getByText('Reload when it suits you.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /See What's New/ })).toBeNull();
  });

  it('never asks while the build is current', async () => {
    both();
    await act(async () => {});
    expect(api.getReleasedSince).not.toHaveBeenCalled();
  });

  it('slides away on dismiss, then is gone for this session', async () => {
    build.stale = true;
    render(<UpdateBanner />);
    const popup = screen.getByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));   // a double click is one dismissal
    expect(popup.className).toMatch(/is-leaving/);
    fireEvent.animationEnd(popup);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the popup after Reload', () => {
  it('gives the buttons back if the reload never happens (a cancelled "Leave site?")', async () => {
    vi.useFakeTimers();
    try {
      build.stale = true;
      const reload = vi.fn();
      const original = window.location;
      Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
      try {
        render(<UpdateBanner />);
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
