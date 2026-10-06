import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { useRole } from '../../contexts/RoleContext'

// The Google Business Profile connection (backend/routers/marketing_gbp.py).
// While it is not connected the Reputation and Business Profile tabs keep
// their sample data; once it is, they show the real Google locations and
// reviews instead.

// What an OAuth callback said, read ONCE at load: Google sends the browser
// back to /marketing/<tab>?gbp=connected|denied|error&reason=... (Google Ads
// uses ?ads=) and the query string is cleared straight away so a reload
// doesn't repeat it.
const RETURN_PARAMS = ['gbp', 'ads']
const pendingReturns = {}
function readReturns() {
  const q = new URLSearchParams(window.location.search)
  let found = false
  for (const p of RETURN_PARAMS) {
    if (!q.get(p)) continue
    pendingReturns[p] = { result: q.get(p), reason: q.get('reason') || '' }
    q.delete(p)
    found = true
  }
  if (!found) return
  q.delete('reason')
  const rest = q.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : ''))
}
function takeReturn(param) {
  const r = pendingReturns[param] || null
  delete pendingReturns[param]
  return r
}

// Read at module load, before App.jsx's address-bar sync can rewrite the URL.
if (typeof window !== 'undefined') readReturns()

// One Google connection's status (Business Profile, Google Ads): the status
// call, and the notice the OAuth return left. `connectedText` is what a
// clean connect says.
export function useConnectionStatus({ param, load, connectedText, label = 'Google' }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(() => {
    const r = takeReturn(param)
    if (!r) return null
    if (r.result === 'connected') {
      return r.reason
        ? { kind: 'warn', text: `${label} is connected, but the first sync did not finish: ${r.reason}` }
        : { kind: 'ok', text: connectedText }
    }
    if (r.result === 'denied') return { kind: 'warn', text: 'The Google sign-in was cancelled - nothing was connected.' }
    return { kind: 'error', text: r.reason || 'Connecting Google did not work - please try again.' }
  })

  const refresh = useCallback(async () => {
    try {
      setStatus(await load())
      setError('')
    } catch (e) {
      setError(e.status === 403 ? 'forbidden' : (e.message || 'The Google connection status could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [load])

  useEffect(() => { refresh() }, [refresh])

  return { status, loading, error, refresh, notice, setNotice }
}

const loadGbpStatus = () => api.getGbpStatus()
export function useGbpStatus() {
  return useConnectionStatus({
    param: 'gbp', load: loadGbpStatus,
    connectedText: 'Google Business Profile is connected and the locations and reviews are synced.',
  })
}

// Anything that changes the review / listing picture (a reply, a sync, a
// new photo) announces it so the module-wide alerts refresh.
export const GBP_CHANGED = 'nexus:gbp-changed'
export function announceGbpChange() {
  window.dispatchEvent(new CustomEvent(GBP_CHANGED))
}

// What differs between the Google connections that share GbpConnectionBar.
export const GBP_BAR = {
  title: 'Google Business Profile',
  start: () => api.startGbpConnect(),
  sync: () => api.syncGbp(),
  disconnect: () => api.disconnectGbp(),
  announce: announceGbpChange,
  adminBlurb: 'Connect the dedicated Google account that manages the locations. Everyone with Marketing access then works through it.',
  forbidden: 'You are seeing sample data. Real Google reviews need the Marketing access grant - ask an administrator.',
  syncedText: (out) => `Synced ${out?.locations ?? 0} location${out?.locations === 1 ? '' : 's'} and ${out?.reviews ?? 0} review${out?.reviews === 1 ? '' : 's'}.`,
  disconnectedText: 'Google is disconnected. The synced reviews and reply history are kept.',
  countText: (st) => `${st.locationCount} location${st.locationCount === 1 ? '' : 's'}`,
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
