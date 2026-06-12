import { Component } from 'react';

// Every view is a lazy() chunk with a content hash in its filename. Each merge
// to dev redeploys and deletes the old chunks, so a tab left open for hours
// 404s when it navigates to a view it hasn't loaded yet — the import rejects
// and, without a boundary, React unmounts the whole app to a white screen.
// A reload picks up the fresh index.html + chunk names and fixes everything.

const RELOAD_KEY = 'nexus:chunk-reload-at';

function isStaleChunkError(error) {
  const msg = String(error?.message || error || '');
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|failed to load module script/i.test(msg);
}

// At most one automatic reload per minute — if the chunk is still missing
// after a fresh load, something else is wrong and we show the card instead
// of reload-looping.
function reloadForFreshBuild() {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
  if (Date.now() - last < 60_000) return false;
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}

// Vite preloads a chunk's static imports/CSS before executing it; those
// failures surface as this window event rather than through the import promise.
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForFreshBuild()) e.preventDefault();
});

export default class ViewErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (isStaleChunkError(error)) reloadForFreshBuild();
  }

  componentDidUpdate(prevProps) {
    // Navigating to another view gives the app a clean retry without a reload
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const stale = isStaleChunkError(this.state.error);
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', padding: 20 }}>
        <div style={{ background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: '28px 30px', maxWidth: 420, textAlign: 'center', fontFamily: 'Inter, sans-serif' }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--ink)', marginBottom: 8 }}>
            {stale ? 'Nexus was updated' : 'This section hit a snag'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 18 }}>
            {stale
              ? 'A new version was deployed while this tab was open. Reload to pick it up — nothing is lost.'
              : 'Something went wrong loading this section. Reloading usually fixes it.'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{ background: 'var(--ink)', color: 'var(--card)', border: 'none', borderRadius: 9, padding: '9px 22px', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
