import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MsalProvider } from '@azure/msal-react'
import { QueryClientProvider } from '@tanstack/react-query'
import { msalInstance } from './msalInstance'
import { queryClient } from './lib/queryClient'
import { setCacheBridge } from './api'
import './style.css'
import App from './App.jsx'
import { installErrorReporter } from './lib/errorReporter'

installErrorReporter();   // uncaught errors -> /client-errors -> audit trail
// Let api.js drive the TanStack Query cache (invalidate after writes, clear on
// Act As) without importing React state - keeps api.js framework-agnostic.
setCacheBridge(queryClient);

sessionStorage.removeItem('nx-entry-retry');  // app booted - re-arm the boot guard (public/guard.js)
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
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </QueryClientProvider>
  </StrictMode>,
)

// Deploy trigger (Jul 31, 2026): first hash rotation after the R2 asset archive went live,
// so stale-tab chunk requests fall back to the archive. Safe to remove.
