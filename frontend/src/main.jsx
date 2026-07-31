import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MsalProvider } from '@azure/msal-react'
import { msalInstance } from './msalInstance'
import './style.css'
import App from './App.jsx'

sessionStorage.removeItem('nx-entry-retry');  // app booted - re-arm the boot guard (public/guard.js)
// Build marker: changes the entry chunk's content, forcing a NEW hashed filename
// this deploy - required to bypass asset URLs cache-poisoned during the Jul 27
// deploy window (fallback HTML cached immutable under the old entry URL).
window.__NEXUS_BUILD = '2026-07-28';
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MsalProvider instance={msalInstance}>
      <App />
    </MsalProvider>
  </StrictMode>,
)

// Deploy trigger (Jul 31, 2026): first hash rotation after the R2 asset archive went live,
// so stale-tab chunk requests fall back to the archive. Safe to remove.
