import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MsalProvider } from '@azure/msal-react'
import { msalInstance } from './msalInstance'
import './style.css'
import App from './App.jsx'

// When MSAL's step-up popup (acquireTokenPopup) redirects back to the app root
// with an auth response (#code=…/#error=…), this same index.html loads INSIDE the
// tiny popup. If we boot the full React app there, it races MSAL's code handoff —
// the app's own handleRedirectPromise consumes/clears the hash before the opener
// window can read it, so the popup hangs on a spinner and the step-up fails.
// Detect that we're that auth-response popup (opened by our own window, hash
// carries the response) and DON'T render — the opener reads the hash and closes
// this window cleanly. A normal full-page redirect login has no window.opener,
// so it still renders and processes the response as usual.
const _hash = window.location.hash || ''
const _isAuthPopup = !!window.opener && window.opener !== window &&
  (_hash.includes('code=') || _hash.includes('error='))

if (!_isAuthPopup) {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </StrictMode>,
  )
}
