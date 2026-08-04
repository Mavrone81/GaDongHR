import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { registerServiceWorker } from './registerServiceWorker'
import './styles/fonts.css'
import './styles/tokens.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('main.tsx: #root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // `sessionStorage` and `location.reload` are passed in (rather than
    // read inside `registerServiceWorker`) so that module can be unit
    // tested against fake storage/reload without a real browser reload —
    // see `registerServiceWorker.ts`'s header for why the reload guard
    // has to survive a real page reload to stay airtight.
    registerServiceWorker(navigator.serviceWorker, window.sessionStorage, () => window.location.reload())
  })
}
