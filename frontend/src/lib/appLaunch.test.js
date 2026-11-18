import { describe, it, expect, beforeEach } from 'vitest';
import { parseLaunch, captureLaunch, peekLaunch, takeLaunch, LAUNCH_ACTIONS } from './appLaunch';
import { ACTIONS } from './quickCreate';

// The installed app's launch addresses (the manifest's shortcuts and
// share_target): read once, kept for the tab through sign-in, taken off the
// address, handed over once.
function fakeWin(href) {
  const store = new Map();
  const win = {
    location: { href },
    history: { state: { depth: 2 }, replaced: null, replaceState(state, _t, url) { this.replaced = { state, url }; win.location.href = new URL(url, href).href; } },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  };
  return win;
}

describe('appLaunch', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads the two shortcut actions and the share flag, and nothing else', () => {
    expect(parseLaunch('?do=new-task')).toEqual({ action: 'task', share: false });
    expect(parseLaunch('?do=new-ticket')).toEqual({ action: 'ticket', share: false });
    expect(parseLaunch('?share=1')).toEqual({ action: '', share: true });
    expect(parseLaunch('?do=submit')).toBeNull();          // the Time Sheet link's own ?do=
    expect(parseLaunch('?do=constructor')).toBeNull();
    expect(parseLaunch('?share=yes')).toBeNull();
    expect(parseLaunch('')).toBeNull();
  });

  it('every launch action is a Quick Action the bolt has', () => {
    Object.values(LAUNCH_ACTIONS).forEach((key) => expect(ACTIONS.some((it) => it.key === key), key).toBe(true));
  });

  it('keeps the launch for the tab, cleans the address and hands it over once', () => {
    const win = fakeWin('https://nexus.test/?do=new-task&nxcb=1#top');
    expect(captureLaunch(win, 1000)).toEqual({ action: 'task', share: false });
    expect(win.history.replaced).toEqual({ state: { depth: 2 }, url: '/?nxcb=1#top' });
    expect(peekLaunch(win, 2000)).toEqual({ action: 'task', share: false });   // a look leaves it there
    expect(takeLaunch(win, 2000)).toEqual({ action: 'task', share: false });
    expect(takeLaunch(win, 2000)).toBeNull();
    expect(peekLaunch(win, 2000)).toBeNull();
  });

  it('a share launch survives a round trip to sign-in (same tab), then is taken', () => {
    const win = fakeWin('https://nexus.test/?share=1');
    captureLaunch(win, 1000);
    expect(win.location.href).toBe('https://nexus.test/');
    // Back from Microsoft on a clean address: nothing new to capture, the kept one is still there.
    expect(captureLaunch(win, 5000)).toBeNull();
    expect(takeLaunch(win, 6000)).toEqual({ action: '', share: true });
  });

  it("leaves another screen's ?do= alone", () => {
    const win = fakeWin('https://nexus.test/timeclock/timesheet?start=2026-11-01&type=hourly&do=submit');
    expect(captureLaunch(win)).toBeNull();
    expect(win.history.replaced).toBeNull();
    expect(takeLaunch(win)).toBeNull();
  });

  it('drops a launch nobody took within ten minutes, and anything it did not write', () => {
    const win = fakeWin('https://nexus.test/?do=new-ticket');
    captureLaunch(win, 0);
    expect(takeLaunch(win, 10 * 60 * 1000 + 1)).toBeNull();
    win.sessionStorage.setItem('nx-app-launch', '{"action":"email","share":"1","at":1}');
    expect(takeLaunch(win, 2)).toBeNull();
    win.sessionStorage.setItem('nx-app-launch', 'not json');
    expect(takeLaunch(win, 2)).toBeNull();
  });

  it('with storage blocked the app still opens and the address is still cleaned', () => {
    const win = fakeWin('https://nexus.test/?do=new-task');
    win.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
    expect(() => captureLaunch(win)).not.toThrow();
    expect(win.history.replaced.url).toBe('/');
    expect(takeLaunch(win)).toBeNull();
  });
});
