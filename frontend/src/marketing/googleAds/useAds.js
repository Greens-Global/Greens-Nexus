import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { useConnectionStatus } from '../gbp/useGbp'
import { ALL_PROPERTIES } from '../shared/facilities'

// The Google Ads connection (backend/routers/marketing_ads.py), read-only.
// Not connected -> the Google Ads tab keeps its sample data; connected -> the
// real spend per campaign, mapped to facilities in Nexus.

const loadAdsStatus = () => api.getAdsStatus()
export function useAdsStatus() {
  return useConnectionStatus({
    param: 'ads', load: loadAdsStatus, label: 'Google Ads',
    connectedText: 'Google Ads is connected and the spend figures are synced.',
  })
}

// A sync or a new campaign mapping changes the spend picture -> the
// module-wide alerts and AI Analyst refresh.
export const ADS_CHANGED = 'nexus:ads-changed'
export function announceAdsChange() {
  window.dispatchEvent(new CustomEvent(ADS_CHANGED))
}

export const ADS_BAR = {
  title: 'Google Ads',
  start: () => api.startAdsConnect(),
  sync: () => api.syncAds(),
  disconnect: () => api.disconnectAds(),
  announce: announceAdsChange,
  adminBlurb: 'Connect the Google account that has access to the Google Ads manager account. Nexus only reads the figures - campaigns are still managed in Google Ads.',
  forbidden: 'You are seeing sample data. Real Google Ads figures need the Marketing access grant - ask an administrator.',
  syncedText: (out) => out?.errors?.length
    ? `Synced, but ${out.errors.length} account${out.errors.length === 1 ? '' : 's'} could not be read: ${out.errors.join('; ')}`
    : `Synced ${out?.accounts ?? 0} Google Ads account${out?.accounts === 1 ? '' : 's'}.`,
  disconnectedText: 'Google Ads is disconnected. The synced figures, facility mapping and budgets are kept.',
  countText: (st) => {
    const n = st.accounts?.length || 0
    return `${n} account${n === 1 ? '' : 's'}, ${st.campaignCount} campaign${st.campaignCount === 1 ? '' : 's'}`
  },
}

// Real spend for the alerts bell and AI Analyst; null when not connected,
// without the grant, or while loading - callers keep the sample figures.
export function useAdsSummary() {
  const [summary, setSummary] = useState(null)
  useEffect(() => {
    let live = true
    const load = () => api.getAdsSummary()
      .then((s) => { if (live) setSummary(s?.connected ? s : null) })
      .catch(() => { if (live) setSummary(null) })
    load()
    window.addEventListener(ADS_CHANGED, load)
    return () => { live = false; window.removeEventListener(ADS_CHANGED, load) }
  }, [])
  return summary
}

// The report for the selected range and property (GET /marketing/ads/report).
export function useAdsReport(range, property, reloadKey) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const facility = property === ALL_PROPERTIES ? '' : property

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api.getAdsReport({ start: range.start, end: range.end, facility }))
    } catch (e) {
      setError(e?.message || 'The Google Ads figures could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [range.start, range.end, facility])

  useEffect(() => { load() }, [load, reloadKey])
  return { data, error, loading, reload: load }
}
