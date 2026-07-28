// Boot guard - external file because the CSP (script-src 'self') blocks inline
// scripts, which silently killed the previous inline version of this watchdog.
//
// Covers two deploy-window failure modes that leave a white screen with no app
// code running to self-heal:
//   1. Mid-deploy race: new index.html live before its hashed entry chunk has
//      propagated - the chunk request gets the SPA fallback (text/html) and the
//      module loader refuses it.
//   2. Poisoned cache: that fallback response got cached under the immutable
//      /assets/* URL, so the browser never refetches it (Jul 27 incident).
// One forced reload usually lands after propagation; 'reload' alone won't fix a
// poisoned immutable entry, so retry TWICE and add a cache-busting query the
// second time by swapping to location.replace with a nonce param.
// main.jsx clears the counter after a successful boot.
(function () {
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (!t || t.tagName !== 'SCRIPT') return;
    var tries = Number(sessionStorage.getItem('nx-entry-retry') || 0);
    if (tries >= 2) return;                    // give up - never loop
    sessionStorage.setItem('nx-entry-retry', String(tries + 1));
    setTimeout(function () {
      if (tries === 0) location.reload();
      else location.replace(location.pathname + '?nxcb=' + Date.now());
    }, 1500);
  }, true);
})();
