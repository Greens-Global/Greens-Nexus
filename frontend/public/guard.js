// Boot guard - external file because the CSP (script-src 'self') blocks inline
// scripts, which silently killed the original inline version of this watchdog.
//
// THE FAILURE IT COVERS. index.html is no-cache and references content-hashed
// chunks that are immutable. During the ~30-60s a deploy takes to propagate, a
// browser can request a chunk that isn't live yet (or has just been replaced).
// The module loader rejects the response and nothing of the app is running, so
// the app cannot heal itself - hence a watchdog that loads before it.
//
// The PERMANENT version of this - an HTML body cached immutable under a chunk
// URL, which bricked a browser forever because stable vendor hashes never
// changed - is now prevented at the edge by functions/assets/[[path]].js, which
// turns any HTML/miss under /assets/* into a no-store 404. So what is left here
// is a transient race, and the job is to ride it out without ever showing a
// white screen.
//
// WHAT CHANGED (Jul 30). The previous version reloaded twice and, on the second
// try, appended ?nxcb=<ts> to the PAGE url. That was ineffective and confusing:
//   - the cache-buster was on the wrong resource. Busting the HTML url does not
//     change the hashed chunk urls inside it, so a genuinely stale/failed chunk
//     was refetched under the exact same url. We now refetch the FAILING asset
//     with {cache:'reload'}, which forces a network round trip and replaces the
//     stale HTTP cache entry, and only then reload.
//   - it left users on urls like /myhr?nxcb=1753... with no explanation, and
//     after two failures it gave up on a blank white page with no way forward.
// Now: three attempts with backoff (the race resolves in seconds), dynamic
// import() failures are caught too, and if it still fails the user gets a real
// panel with a Reload button instead of white. main.jsx clears the counter on a
// successful boot, so this re-arms every load.
(function () {
  var KEY = 'nx-entry-retry';
  var MAX = 3;
  var BACKOFF = [1200, 4000, 9000];
  var busy = false;

  function tries() {
    try { return Number(sessionStorage.getItem(KEY) || 0); } catch (_) { return 0; }
  }
  function bump(n) {
    try { sessionStorage.setItem(KEY, String(n)); } catch (_) {}
  }

  // Deliberately dependency-free and style-inline: the app's CSS may be exactly
  // what failed to load, and a strict CSP can block a <style> @keyframes - so the
  // progress bar is animated from JS via inline styles. Neutral surface reads in
  // light or dark; the brand green matches the rest of Nexus.
  // mode: 'updating' (animated sweep, auto-reloads) | 'failed' (Reload button).
  function panel(mode) {
    var id = 'nx-boot-panel';
    if (document.getElementById(id)) return;
    var GREEN = 'hsl(142,60%,35%)';
    var wrap = document.createElement('div');
    wrap.id = id;
    wrap.setAttribute('role', 'status');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;' +
      'align-items:center;justify-content:center;background:#f6f7fb;color:#323338;' +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
    var card = document.createElement('div');
    card.style.cssText = 'text-align:center;max-width:360px;padding:28px 24px';

    var mark = document.createElement('div');
    mark.textContent = 'N';
    mark.style.cssText = 'width:46px;height:46px;border-radius:13px;margin:0 auto 16px;' +
      'display:flex;align-items:center;justify-content:center;font-weight:800;font-size:24px;' +
      'color:#fff;background:' + GREEN + ';box-shadow:0 8px 20px -6px hsla(145,60%,25%,.5)';
    card.appendChild(mark);

    var h = document.createElement('div');
    h.style.cssText = 'font-size:17px;font-weight:700;margin-bottom:6px';
    var p = document.createElement('div');
    p.style.cssText = 'font-size:13.5px;line-height:1.55;color:#676879';

    if (mode === 'failed') {
      h.textContent = 'Nexus needs a quick reload';
      p.textContent = 'A fresh update didn’t finish loading - this almost always clears right after a deploy. Give it a reload; if it keeps happening, poke IT.';
      card.appendChild(h);
      card.appendChild(p);
      var b = document.createElement('button');
      b.textContent = 'Reload Nexus';
      b.style.cssText = 'margin-top:18px;background:' + GREEN + ';color:#fff;border:0;' +
        'border-radius:9px;padding:11px 24px;font-size:13.5px;font-weight:700;cursor:pointer;' +
        'box-shadow:0 6px 16px -6px hsla(145,60%,25%,.5)';
      b.onclick = function () {
        try { sessionStorage.removeItem(KEY); } catch (_) {}
        location.reload();
      };
      card.appendChild(b);
    } else {
      h.textContent = 'Freshening up Nexus';
      card.appendChild(h);
      var track = document.createElement('div');
      track.style.cssText = 'width:220px;height:6px;border-radius:99px;background:#e4e7f0;' +
        'overflow:hidden;margin:18px auto 14px;position:relative';
      var bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;top:0;left:-38%;height:100%;width:38%;' +
        'border-radius:99px;background:' + GREEN;
      track.appendChild(bar);
      card.appendChild(track);
      p.style.minHeight = '20px';
      card.appendChild(p);
      // Light, rotating messages - a smile, not a distraction.
      var msgs = ['Tightening a few bolts…', 'Polishing the pixels…',
        'Herding the data…', 'Almost there - hang tight.'];
      var mi = 0; p.textContent = msgs[0];
      var pos = -38;
      var sweep = setInterval(function () {
        pos += 2.4; if (pos >= 100) pos = -38; bar.style.left = pos + '%';
      }, 16);
      var rot = setInterval(function () { mi = (mi + 1) % msgs.length; p.textContent = msgs[mi]; }, 2200);
      wrap._nxTimers = [sweep, rot];   // torn down by the reload; kept for tidiness
    }

    wrap.appendChild(card);
    (document.body || document.documentElement).appendChild(wrap);
  }

  function recover(failedUrl) {
    if (busy) return;
    var n = tries();
    if (n >= MAX) {
      panel('failed');
      return;
    }
    busy = true;
    bump(n + 1);
    panel('updating');
    setTimeout(function () {
      var go = function () { location.reload(); };
      // Force the failing asset past any stale cache entry BEFORE reloading, so
      // the reload's request for that same hashed url can succeed.
      if (failedUrl && window.fetch) {
        try { fetch(failedUrl, { cache: 'reload' }).then(go, go); } catch (_) { go(); }
      } else { go(); }
    }, BACKOFF[n] || 9000);
  }

  // Resource-load failures: the entry chunk or the stylesheet. Capture phase,
  // because these do not bubble. Images/fonts are not app-fatal - ignore them.
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (!t || !t.tagName) return;
    var tag = t.tagName;
    if (tag === 'SCRIPT') return recover(t.src || null);
    if (tag === 'LINK' && (t.rel === 'stylesheet' || t.rel === 'modulepreload')) return recover(t.href || null);
  }, true);

  // Lazily-imported route chunks fail as a rejected promise, not an error event,
  // so the old guard never saw them - a mid-deploy navigation into any lazy view
  // just threw and left the shell empty.
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var m = (r && (r.message || r)) + '';
    if (/dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(m)) {
      recover(null);
    }
  });
})();
