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
  // what failed to load. Neutral colors so it reads in light or dark.
  function panel(title, sub, showButton) {
    var id = 'nx-boot-panel';
    if (document.getElementById(id)) return;
    var wrap = document.createElement('div');
    wrap.id = id;
    wrap.setAttribute('role', 'status');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;' +
      'align-items:center;justify-content:center;background:#f6f7fb;color:#323338;' +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
    var card = document.createElement('div');
    card.style.cssText = 'text-align:center;max-width:340px;padding:28px 24px';
    var h = document.createElement('div');
    h.style.cssText = 'font-size:17px;font-weight:700;margin-bottom:6px';
    h.textContent = title;
    var p = document.createElement('div');
    p.style.cssText = 'font-size:13.5px;line-height:1.55;color:#676879';
    p.textContent = sub;
    card.appendChild(h);
    card.appendChild(p);
    if (showButton) {
      var b = document.createElement('button');
      b.textContent = 'Reload Nexus';
      b.style.cssText = 'margin-top:18px;background:#2b45e1;color:#fff;border:0;' +
        'border-radius:8px;padding:10px 22px;font-size:13.5px;font-weight:700;cursor:pointer';
      b.onclick = function () {
        try { sessionStorage.removeItem(KEY); } catch (_) {}
        location.reload();
      };
      card.appendChild(b);
    }
    wrap.appendChild(card);
    (document.body || document.documentElement).appendChild(wrap);
  }

  function recover(failedUrl) {
    if (busy) return;
    var n = tries();
    if (n >= MAX) {
      panel('Nexus could not finish loading',
        'This usually clears on its own after a deploy. Reload to try again, or contact IT if it keeps happening.',
        true);
      return;
    }
    busy = true;
    bump(n + 1);
    panel('Updating Nexus', 'Finishing an update - this reloads automatically.', false);
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
