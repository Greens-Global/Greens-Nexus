// Polling that respects the tab's visibility. A Nexus tab parked behind other
// windows all day was still firing every module's refresh loop - background
// tabs were most of the API's request volume. This ticks only while the tab is
// visible, and fires immediately when the user comes back if a tick was missed,
// so returning to the tab still feels live.
//
// Drop-in for the setInterval pattern:
//   useEffect(() => pollWhileVisible(load, 30000), []);
// (returns the cleanup function directly)
export function pollWhileVisible(fn, ms) {
  let last = Date.now();          // mount counts as fresh - callers load on mount
  const tick = () => {
    last = Date.now();
    fn();
  };
  const id = setInterval(() => {
    if (document.visibilityState === 'visible') tick();
  }, ms);
  const onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - last >= ms) tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
