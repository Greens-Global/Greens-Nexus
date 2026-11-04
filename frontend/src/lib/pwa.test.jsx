import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Installable app + push (Frontline Reach, 11/02/2026). jsdom has none of the
// browser APIs, so each test fakes exactly the ones it needs.
const apiSpies = vi.hoisted(() => ({}));
vi.mock('../api', () => ({
  api: new Proxy({}, { get: (_, k) => (apiSpies[k] ||= vi.fn(() => Promise.resolve({}))) }),
}));

const pwa = await import('./pwa');

function fakeServiceWorker(existing = null) {
  const subscription = { endpoint: 'https://push.example.test/send/abc', toJSON: () => ({ endpoint: 'https://push.example.test/send/abc', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: vi.fn(() => Promise.resolve(true)) };
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(existing ? subscription : null)),
    subscribe: vi.fn(() => Promise.resolve(subscription)),
  };
  const reg = { pushManager, scope: '/' };
  const sw = { register: vi.fn(() => Promise.resolve(reg)), ready: Promise.resolve(reg) };
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  window.PushManager = function PushManager() {};
  window.Notification = { permission: 'default', requestPermission: vi.fn(() => Promise.resolve('granted')) };
  return { sw, reg, pushManager, subscription };
}

afterEach(() => {
  pwa._resetInstallPrompt();
  delete navigator.serviceWorker;
  delete window.PushManager;
  delete window.Notification;
  vi.restoreAllMocks();
});

describe('registerServiceWorker', () => {
  it('registers /sw.js at the root scope once, and resolves null where there is no worker API', async () => {
    expect(await pwa.registerServiceWorker()).toBeNull();
    const { sw } = fakeServiceWorker();
    // jsdom's host is localhost, which is skipped unless VITE_PWA_DEV=1.
    import.meta.env.VITE_PWA_DEV = '1';
    const a = await pwa.registerServiceWorker();
    const b = await pwa.registerServiceWorker();
    expect(a).toBe(b);
    expect(sw.register).toHaveBeenCalledTimes(1);
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
  });
});

describe('urlBase64ToUint8Array', () => {
  it('turns the server public key (base64url) into bytes', () => {
    const out = pwa.urlBase64ToUint8Array('AQID_-8');
    expect(Array.from(out)).toEqual([1, 2, 3, 255, 239]);
  });
});

describe('isIos / isStandalone', () => {
  it('reads iPhone and iPad (as a Mac with touch) from the agent, and standalone from display-mode', () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get');
    ua.mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    expect(pwa.isIos()).toBe(true);
    ua.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(pwa.isIos()).toBe(false);
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    expect(pwa.isIos()).toBe(true);
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    expect(pwa.isStandalone()).toBe(false);
    window.matchMedia = vi.fn(() => ({ matches: true }));
    expect(pwa.isStandalone()).toBe(true);
    delete window.matchMedia;
  });
});

describe('useInstallPrompt', () => {
  it('a beforeinstallprompt fired BEFORE the hook mounts (page load, long before My Profile opens) still offers Install', async () => {
    const ev = new Event('beforeinstallprompt');
    ev.prompt = vi.fn();
    ev.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(ev);                    // caught at module load, nothing mounted yet
    const { result } = renderHook(() => pwa.useInstallPrompt());
    expect(result.current.canInstall).toBe(true);
    let outcome;
    await act(async () => { outcome = await result.current.install(); });
    expect(ev.prompt).toHaveBeenCalled();
    expect(outcome).toBe('accepted');
    expect(result.current.canInstall).toBe(false);
  });

  it('captures a beforeinstallprompt that fires after mount too, and a dismissed prompt stays offered', async () => {
    const { result } = renderHook(() => pwa.useInstallPrompt());
    expect(result.current.canInstall).toBe(false);
    expect(await result.current.install()).toBe('unavailable');
    const ev = new Event('beforeinstallprompt');
    ev.prompt = vi.fn();
    ev.userChoice = Promise.resolve({ outcome: 'dismissed' });
    act(() => { window.dispatchEvent(ev); });
    expect(result.current.canInstall).toBe(true);
    let outcome;
    await act(async () => { outcome = await result.current.install(); });
    expect(outcome).toBe('dismissed');
    expect(result.current.canInstall).toBe(true);
  });

  it('appinstalled marks the device as standalone', () => {
    const { result } = renderHook(() => pwa.useInstallPrompt());
    act(() => { window.dispatchEvent(new Event('appinstalled')); });
    expect(result.current.isStandalone).toBe(true);
    expect(result.current.canInstall).toBe(false);
  });
});

describe('usePushSubscription', () => {
  beforeEach(() => { import.meta.env.VITE_PWA_DEV = '1'; });

  it('is unsupported without the browser APIs and still asks the server whether push is set up', async () => {
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: false, publicKey: '' }));
    const { result } = renderHook(() => pwa.usePushSubscription());
    expect(result.current.supported).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.enabled).toBe(false);
    expect(await result.current.subscribe()).toBe(false);
  });

  it('subscribes with the server key and registers the device, then unsubscribes and tells the server', async () => {
    const { pushManager, subscription } = fakeServiceWorker();
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscribe = vi.fn(() => Promise.resolve({}));
    apiSpies.pushUnsubscribe = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() => pwa.usePushSubscription());
    expect(result.current.supported).toBe(true);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.enabled).toBe(true);
    expect(result.current.subscribed).toBe(false);

    let ok;
    await act(async () => { ok = await result.current.subscribe(); });
    expect(ok).toBe(true);
    expect(window.Notification.requestPermission).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }));
    expect(apiSpies.pushSubscribe).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example.test/send/abc', keys: { p256dh: 'p', auth: 'a' } }));
    expect(result.current.subscribed).toBe(true);
    expect(result.current.permission).toBe('granted');

    pushManager.getSubscription.mockResolvedValue(subscription);
    await act(async () => { ok = await result.current.unsubscribe(); });
    expect(ok).toBe(true);
    expect(apiSpies.pushUnsubscribe).toHaveBeenCalledWith('https://push.example.test/send/abc');
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(result.current.subscribed).toBe(false);
  });

  it('a refused permission leaves the device unsubscribed and records the state', async () => {
    fakeServiceWorker();
    window.Notification.requestPermission = vi.fn(() => Promise.resolve('denied'));
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscribe = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() => pwa.usePushSubscription());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let ok;
    await act(async () => { ok = await result.current.subscribe(); });
    expect(ok).toBe(false);
    expect(result.current.permission).toBe('denied');
    expect(result.current.subscribed).toBe(false);
    expect(apiSpies.pushSubscribe).not.toHaveBeenCalled();
  });

  it('a device subscribed in this browser AND on the server shows as on without re-posting', async () => {
    fakeServiceWorker(true);
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscriptions = vi.fn(() => Promise.resolve([{ id: 1, endpoint: 'https://push.example.test/send/abc', disabled: false }]));
    apiSpies.pushSubscribe = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() => pwa.usePushSubscription());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.subscribed).toBe(true);
    expect(apiSpies.pushSubscribe).not.toHaveBeenCalled();
  });

  it('self-heals: a browser subscription the server lacks (dropped, or another person signed in here) is posted again', async () => {
    fakeServiceWorker(true);
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscriptions = vi.fn(() => Promise.resolve([]));
    apiSpies.pushSubscribe = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() => pwa.usePushSubscription());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(apiSpies.pushSubscribe).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example.test/send/abc' }));
    expect(result.current.subscribed).toBe(true);
  });

  it('a subscription the server disabled after failures is re-posted too; one the server lacks while push is off stays off', async () => {
    fakeServiceWorker(true);
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscriptions = vi.fn(() => Promise.resolve([{ id: 1, endpoint: 'https://push.example.test/send/abc', disabled: true }]));
    apiSpies.pushSubscribe = vi.fn(() => Promise.resolve({}));
    const a = renderHook(() => pwa.usePushSubscription());
    await waitFor(() => expect(a.result.current.loaded).toBe(true));
    expect(apiSpies.pushSubscribe).toHaveBeenCalledTimes(1);
    expect(a.result.current.subscribed).toBe(true);
    a.unmount();

    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: false, publicKey: '' }));
    apiSpies.pushSubscriptions = vi.fn(() => Promise.resolve([]));
    apiSpies.pushSubscribe.mockClear();
    const b = renderHook(() => pwa.usePushSubscription());
    await waitFor(() => expect(b.result.current.loaded).toBe(true));
    expect(apiSpies.pushSubscribe).not.toHaveBeenCalled();
    expect(b.result.current.subscribed).toBe(false);
  });

  it('an InvalidStateError (a subscription made with another server key) drops the old one and subscribes once more', async () => {
    const { pushManager, subscription } = fakeServiceWorker();
    const stale = Object.assign(new Error('different key'), { name: 'InvalidStateError' });
    pushManager.subscribe.mockRejectedValueOnce(stale);
    pushManager.getSubscription.mockResolvedValueOnce(null).mockResolvedValueOnce(subscription);
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscriptions = vi.fn(() => Promise.resolve([]));
    apiSpies.pushSubscribe = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() => pwa.usePushSubscription());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let ok;
    await act(async () => { ok = await result.current.subscribe(); });
    expect(ok).toBe(true);
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledTimes(2);
    expect(result.current.subscribed).toBe(true);
  });

  it('any other failure shows one plain sentence, never the browser\'s raw message', async () => {
    const { pushManager } = fakeServiceWorker();
    pushManager.subscribe.mockRejectedValueOnce(new Error('Registration failed - push service error'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscriptions = vi.fn(() => Promise.resolve([]));
    const { result } = renderHook(() => pwa.usePushSubscription());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => { await result.current.subscribe(); });
    expect(result.current.error).toBe(pwa.SUBSCRIBE_ERROR);
    expect(result.current.error).not.toMatch(/Registration failed/);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[pwa]'), expect.stringContaining('Registration failed'));
  });

  it('re-reads the permission when the tab comes back (allowed in the phone settings, no reload)', async () => {
    fakeServiceWorker();
    window.Notification.permission = 'denied';
    apiSpies.pushConfig = vi.fn(() => Promise.resolve({ enabled: true, publicKey: 'AQID_-8' }));
    apiSpies.pushSubscriptions = vi.fn(() => Promise.resolve([]));
    const { result } = renderHook(() => pwa.usePushSubscription());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.permission).toBe('denied');
    window.Notification.permission = 'granted';
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(result.current.permission).toBe('granted');
  });
});
