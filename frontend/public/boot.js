/* Boot watchdog — see index.html. Runs before the app's entry module so it can
   catch the module failing to load. If a bundle asset 404s (the classic
   "stale index.html after a deploy points at deleted /assets hashes" case) or
   nothing has rendered into #root after 12s, cache-bust a single reload so the
   browser refetches a fresh index that references the current asset hashes.
   Throttled via sessionStorage so it can never loop. Served from a stable,
   non-hashed path (/boot.js), so even a stale index can still load it. */
(function () {
  var KEY = 'nexus:boot-reload-at';
  function recently() {
    try { return Date.now() - Number(sessionStorage.getItem(KEY) || 0) < 20000; } catch (e) { return false; }
  }
  function bust() {
    if (recently()) return;                                // never loop
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch (e) { /* ignore */ }
    var u = new URL(window.location.href);
    u.searchParams.set('_r', Date.now());                  // unique URL → skips the stale HTML cache
    window.location.replace(u.toString());
  }
  // A failed bundle asset load (stale index → deleted hash → 404) fires a
  // resource error we catch in the capture phase, before React ever mounts.
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK') && (t.src || t.href || '').indexOf('/assets/') !== -1) bust();
  }, true);
  // Belt-and-suspenders: if nothing rendered after 12s, assume the entry never
  // booted and refresh once. (The app paints a spinner within ~1s of JS running,
  // so an empty #root at 12s means the entry chunk didn't load.)
  setTimeout(function () {
    var r = document.getElementById('root');
    if (r && r.childElementCount === 0 && !recently()) bust();
  }, 12000);
})();
