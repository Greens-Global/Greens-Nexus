import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MsalProvider } from '@azure/msal-react'
import { QueryClientProvider } from '@tanstack/react-query'
import { msalInstance } from './msalInstance'
import { queryClient } from './lib/queryClient'
import { setCacheBridge } from './api'
import './style.css'
import App from './App.jsx'
import LoginPage from './views/LoginPage'
import RootErrorBoundary from './components/RootErrorBoundary'
import { DialogHost } from './ui/dialog'
import { installErrorReporter } from './lib/errorReporter'
import { BFF_MODE, bffBootstrap } from './bffAuth'

installErrorReporter();   // uncaught errors -> /client-errors -> audit trail
// Let api.js drive the TanStack Query cache (invalidate after writes, clear on
// Act As) without importing React state - keeps api.js framework-agnostic.
setCacheBridge(queryClient);

sessionStorage.removeItem('nx-entry-retry');  // app booted - re-arm the boot guard (public/guard.js)
// The app booted successfully, so any ?nxcb= cache-buster in the URL (from a
// ViewErrorBoundary recovery reload) has done its job - strip it so the user
// never sees an internal-looking query param in their address bar. Cosmetic and
// post-boot only; nxcb is write-only (never read by app logic).
try {
  const _u = new URL(window.location.href);
  if (_u.searchParams.has('nxcb')) {
    _u.searchParams.delete('nxcb');
    window.history.replaceState(null, '', _u.pathname + _u.search + _u.hash);
  }
} catch { /* non-critical */ }
// Preconnect to the API origin now, in parallel with MSAL init - the DNS+TLS
// handshake to Azure is done before the first authed call needs it. The origin
// is only known via env, so this can't live statically in index.html.
try {
  const apiOrigin = new URL(import.meta.env.VITE_API_BASE ?? 'http://localhost:8000').origin;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = apiOrigin;
  document.head.appendChild(link);
} catch { /* malformed env - skip, first fetch just pays the handshake */ }
// Build marker: changes the entry chunk's content, forcing a NEW hashed filename
// this deploy - required to bypass asset URLs cache-poisoned during the Jul 27
// deploy window (fallback HTML cached immutable under the old entry URL).
window.__NEXUS_BUILD = '2026-07-28';

// One React root, re-rendered as the boot state resolves (reconnecting -> app or
// login). createRoot must run once per node, so it's created here and reused.
const _root = createRoot(document.getElementById('root'));

// Shown only when the session check is slow - i.e. a backend deploy/restart blip.
// A normal fast load skips it. This keeps a logged-in user in a calm "reconnecting"
// state instead of a blank screen or a false bounce to the login page.
function BootConnecting() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
      background: 'var(--wk-bg, #f6f7fb)', color: 'var(--wk-dim, #676879)',
      fontFamily: "'Figtree','Inter',system-ui,sans-serif" }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 26, height: 26, margin: '0 auto 14px', borderRadius: '50%',
          border: '3px solid #dfe3ec', borderTopColor: 'hsl(142 60% 35%)',
          animation: 'nx-boot-spin 0.8s linear infinite' }} />
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Reconnecting…</div>
        <style>{`@keyframes nx-boot-spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  );
}
function renderConnecting() { _root.render(<BootConnecting />); }

function renderApp() {
  _root.render(
    <StrictMode>
      <RootErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <MsalProvider instance={msalInstance}>
            <App />
            <DialogHost />
          </MsalProvider>
        </QueryClientProvider>
      </RootErrorBoundary>
    </StrictMode>,
  );
}

function renderLanding() {
  // The same LoginPage the MSAL flow shows (its button is BFF-aware), so the
  // sign-in screen is identical whichever auth mode is active. It reads MSAL
  // (useMsal) and branding (useBranding), so it needs both providers.
  _root.render(
    <StrictMode>
      <RootErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <MsalProvider instance={msalInstance}>
            <LoginPage />
          </MsalProvider>
        </QueryClientProvider>
      </RootErrorBoundary>
    </StrictMode>,
  );
}

// Public routes that App.jsx itself renders with no auth required (e-sign
// signing/verification links, the Privacy Policy / Terms & Conditions pages
// linked from the sign-in screen). These must reach App.jsx even in BFF mode
// with no session cookie - skipping straight to renderApp() here is what lets
// App's own /sign, /verify, /privacy, /terms branches run; otherwise
// bffBootstrap's "no session -> renderLanding()" below would strand an
// unauthenticated visitor (an external signer, or anyone sent a policy link)
// on the "Continue with Microsoft" screen before App.jsx ever mounts.
const PUBLIC_PATH = /^\/(sign|verify|privacy|terms)(\/|$)/;
const isPublicPath = PUBLIC_PATH.test(window.location.pathname);

// BFF cookie mode: resolve the server session BEFORE the first render. If signed
// in, bffBootstrap installs a synthetic account and we render the app; if not, we
// render the sign-in landing (no auto-redirect to Microsoft). MSAL mode renders
// immediately, exactly as before.
if (BFF_MODE && !isPublicPath) {
  // Show "Reconnecting…" only if the session check is slow (a backend blip); a
  // fast normal load resolves before the timer and goes straight to the app.
  const _slow = setTimeout(renderConnecting, 600);
  bffBootstrap().then((authed) => { clearTimeout(_slow); authed ? renderApp() : renderLanding(); });
} else {
  // MSAL mode, or a public path (/sign, /verify, /privacy, /terms) which App.jsx
  // renders itself with no session required.
  renderApp();
}

// Deploy trigger (Jul 31, 2026): first hash rotation after the R2 asset archive went live,
// so stale-tab chunk requests fall back to the archive. Safe to remove.
