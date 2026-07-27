import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MsalProvider } from '@azure/msal-react'
import { msalInstance } from './msalInstance'
import './style.css'
import App from './App.jsx'

sessionStorage.removeItem('nx-entry-retry');  // app booted — arm the white-screen guard for the next deploy
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MsalProvider instance={msalInstance}>
      <App />
    </MsalProvider>
  </StrictMode>,
)
