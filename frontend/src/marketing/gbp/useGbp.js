import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { useRole } from '../../contexts/RoleContext'

// The Google Business Profile connection (backend/routers/marketing_gbp.py).
// While it is not connected the Reputation and Business Profile tabs keep
// their sample data; once it is, they show the real Google locations and
// reviews instead.

// What the OAuth callback said, read ONCE at load: Google sends the browser
// back to /marketing/marketing-listings?gbp=connected|denied|error&reason=...
// and the query string is cleared straight away so a reload doesn't repeat it.
let pendingReturn = null
function takeReturn() {
  if (pendingReturn) {
    const r = pendingReturn
    pendingReturn = null
    return r
  }
  const q = new URLSearchParams(window.location.search)
  const result = q.get('gbp')
  if (!result) return null
  const reason = q.get('reason') || ''
  q.delete('gbp')
  q.delete('reason')
  const rest = q.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : ''))
  return { result, reason }
}

// Read at module load, before App.jsx's address-bar sync can rewrite the URL.
if (typeof window !== 'undefined') pendingReturn = takeReturn()

export function useGbpStatus() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(() => {
    const r = takeReturn()
    if (!r) return null
    if (r.result === 'connected') {
      return r.reason
        ? { kind: 'warn', text: `Google is connected, but the first sync did not finish: ${r.reason}` }
        : { kind: 'ok', text: 'Google Business Profile is connected and the locations and reviews are synced.' }
    }
    if (r.result === 'denied') return { kind: 'warn', text: 'The Google sign-in was cancelled - nothing was connected.' }
    return { kind: 'error', text: r.reason || 'Connecting Google did not work - please try again.' }
  })

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getGbpStatus())
      setError('')
    } catch (e) {
      setError(e.status === 403 ? 'forbidden' : (e.message || 'The Google connection status could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { status, loading, error, refresh, notice, setNotice }
}

// Anything that changes the review / listing picture (a reply, a sync, a
// new photo) announces it so the module-wide alerts refresh.
export const GBP_CHANGED = 'nexus:gbp-changed'
export function announceGbpChange() {
  window.dispatchEvent(new CustomEvent(GBP_CHANGED))
}

// The real review summary behind Marketing's alerts bell and AI Analyst.
// null while loading, when Google is not connected, or without the grant -
// callers then keep the sample figures.
export function useGbpSummary() {
  const [summary, setSummary] = useState(null)
  useEffect(() => {
    let live = true
    const load = () => api.getGbpSummary()
      .then((s) => { if (live) setSummary(s?.connected ? s : null) })
      .catch(() => { if (live) setSummary(null) })
    load()
    window.addEventListener(GBP_CHANGED, load)
    return () => { live = false; window.removeEventListener(GBP_CHANGED, load) }
  }, [])
  return summary
}

// Mirrors the backend gates: viewer reads, editor replies and syncs, full
// edits the listing, administrators connect the Google account.
export function useGbpPermissions() {
  const { can, canAccessModule } = useRole()
  return {
    isAdmin: can('administrator'),
    canReply: canAccessModule('marketing', 'administrator', 'editor'),
    canEditListing: canAccessModule('marketing', 'administrator', 'full'),
  }
}

export function errorText(e, fallback = 'Something went wrong - please try again.') {
  return (e && e.message) || fallback
}
