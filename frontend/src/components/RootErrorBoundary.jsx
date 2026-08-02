import { Component } from 'react';

// The last line of defense against a white screen. main.jsx wraps the ENTIRE
// app in this - ViewErrorBoundary only guards the view content, so a crash in a
// provider, the top header, a widget, or the auth gate (e.g. a component choking
// on data that never arrived during a backend freeze) would otherwise unmount
// React to a blank page. This ALWAYS renders something: a quiet one-time
// auto-recover, then a friendly full-screen card the user can act on.
//
// Deliberately imports NOTHING from the app except React - if style.css or a
// lazy chunk was the thing that failed, this screen must still paint. All colors
// are inline literals for the same reason (CSS vars may be unavailable).

const RELOAD_KEY = 'nexus:root-reload-at';

export default class RootErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // Auto-recover ONCE per minute. A fresh load fixes the two common causes:
    // stale chunks after a deploy, and a transient crash from a backend freeze
    // that has since passed. Guarded so a deterministic crash can't reload-loop -
    // the second failure inside a minute falls through to the card instead.
    let last = 0;
    try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0); } catch { /* private mode */ }
    if (Date.now() - last > 60_000) {
      try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* ignore */ }
      window.location.reload();
      return;
    }
    // Second crash within the window - record it for the server error trail and
    // show the card. Best-effort; never let reporting itself throw.
    import('../lib/errorReporter')
      .then(m => m.reportError('root: ' + (error?.message || String(error)), error?.stack))
      .catch(() => {});
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f6f7f9', fontFamily: 'Inter, system-ui, -apple-system, sans-serif' }}>
        <div style={{ background: '#ffffff', border: '1px solid #e6e8eb', borderRadius: 16, padding: '34px 34px', maxWidth: 400, textAlign: 'center', boxShadow: '0 10px 34px rgba(0,0,0,.08)' }}>
          <div style={{ width: 48, height: 48, borderRadius: 13, background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px' }}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          </div>
          <div style={{ fontWeight: 700, fontSize: 17, color: '#111827', marginBottom: 8 }}>Just a moment</div>
          <div style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.55, marginBottom: 22 }}>
            Nexus had trouble loading - this is almost always a brief hiccup. Reloading will get you right back in.
          </div>
          <button
            onClick={() => { try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* ignore */ } window.location.reload(); }}
            style={{ background: '#111827', color: '#ffffff', border: 'none', borderRadius: 10, padding: '11px 28px', fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
            Reload Nexus
          </button>
        </div>
      </div>
    );
  }
}
