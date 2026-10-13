import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

// The weekly "New in Nexus" bar and the new-version popup's See What's New
// (Neil, Oct 12 2026).

const api = {
  getFeatureBanner: vi.fn(),
  dismissFeatureBanner: vi.fn(() => Promise.resolve({ ok: true })),
  getNewFeatures: vi.fn(),
};
vi.mock('../api', () => ({ api }));
const role = { isExternal: false, myGrantedModules: new Map() };
vi.mock('../contexts/RoleContext', () => ({ useRole: () => role }));
const build = { stale: false };
vi.mock('../lib/useBuildVersion', () => ({ useBuildVersion: () => build.stale }));

const { default: FeatureBanner } = await import('./FeatureBanner');
const { default: UpdateBanner } = await import('./UpdateBanner');
const { __resetUpdateSignal } = await import('../lib/updateSignal');

const SHOW = { show: true, feature: { id: 'e1', title: 'Scorecard emails', module: 'Workday' }, more: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  role.isExternal = false; role.myGrantedModules = new Map();
  build.stale = false;
  api.getFeatureBanner.mockResolvedValue(SHOW);
  api.getNewFeatures.mockResolvedValue({ count: 0, latest: null });
  __resetUpdateSignal();
});
afterEach(() => { cleanup(); document.documentElement.style.removeProperty('--nx-announce-h'); });

describe('the weekly New Feature bar', () => {
  it('names the feature and the others, and opens What\'s New', async () => {
    const onNavigate = vi.fn();
    render(<FeatureBanner activeView="tasks" onNavigate={onNavigate} />);
    const region = await screen.findByRole('region', { name: 'New in Nexus' });
    expect(region.textContent).toMatch(/Scorecard emails and 2 more/);
    fireEvent.click(screen.getByRole('button', { name: "See What's New" }));
    expect(onNavigate).toHaveBeenCalledWith('whats-new');
    expect(api.dismissFeatureBanner).toHaveBeenCalledTimes(1);           // counts as seen for the week
    // It folds away (an animation), then leaves the page.
    expect(region.className).toMatch(/is-closing/);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New in Nexus' })).toBeNull());
  });

  it('dismisses for the week from the X', async () => {
    render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss for this week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss for this week' }));   // a double click asks once
    expect(api.dismissFeatureBanner).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'New in Nexus' })).toBeNull());
  });

  it('stays quiet when the server says so', async () => {
    api.getFeatureBanner.mockResolvedValue({ show: false });
    render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    await waitFor(() => expect(api.getFeatureBanner).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'New in Nexus' })).toBeNull();
  });

  it('opening What\'s New any other way closes it for the week', async () => {
    const { rerender } = render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    await screen.findByRole('region', { name: 'New in Nexus' });
    rerender(<FeatureBanner activeView="whats-new" onNavigate={() => {}} />);
    expect(screen.queryByRole('region', { name: 'New in Nexus' })).toBeNull();
    await waitFor(() => expect(api.dismissFeatureBanner).toHaveBeenCalledTimes(1));
  });

  it('is never asked for by an external who cannot open What\'s New', async () => {
    role.isExternal = true;
    render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    await act(async () => {});
    expect(api.getFeatureBanner).not.toHaveBeenCalled();
  });

  it('takes its height off the full-height views while it shows', async () => {
    render(<FeatureBanner activeView="tasks" onNavigate={() => {}} />);
    await screen.findByRole('region', { name: 'New in Nexus' });
    expect(document.documentElement.style.getPropertyValue('--nx-announce-h')).toMatch(/px$/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss for this week' }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--nx-announce-h')).toBe(''));
  });
});

describe("the new-version popup's See What's New", () => {
  const both = () => render(<><UpdateBanner /><FeatureBanner activeView="tasks" onNavigate={() => {}} /></>);

  it('appears when the waiting version brings a New Feature', async () => {
    build.stale = true;
    api.getFeatureBanner.mockResolvedValue({ show: false });          // only the popup's button here
    api.getNewFeatures.mockResolvedValue({ count: 1, latest: { title: 'Scorecard emails' } });
    both();
    expect(await screen.findByRole('button', { name: /See What's New/ })).toBeTruthy();
    expect(screen.getByText('A New Version of Nexus Is Available')).toBeTruthy();
    expect(screen.getByText(/comes with new features/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reload/ })).toBeTruthy();       // still there
  });

  it('is not offered for a version with only fixes', async () => {
    build.stale = true;
    api.getFeatureBanner.mockResolvedValue({ show: false });
    both();
    await waitFor(() => expect(api.getNewFeatures).toHaveBeenCalled());
    expect(screen.getByText('A New Version of Nexus Is Available')).toBeTruthy();
    expect(screen.getByText(/Reload when it suits you/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /See What's New/ })).toBeNull();
  });

  it('never asks while the build is current', async () => {
    both();
    await act(async () => {});
    expect(api.getNewFeatures).not.toHaveBeenCalled();
  });
});

describe('the popup itself', () => {
  it('slides away on dismiss, then is gone for this session', async () => {
    build.stale = true;
    api.getFeatureBanner.mockResolvedValue({ show: false });
    render(<UpdateBanner />);
    const popup = screen.getByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(popup.className).toMatch(/is-leaving/);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});
