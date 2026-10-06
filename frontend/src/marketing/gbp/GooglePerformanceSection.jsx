import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import AsyncSection, { SkeletonBlocks } from '../../components/AsyncState'
import { formatDate, formatDateTime } from '../../lib/datetime'
import ProfileStatCards from '../reputation/ProfileStatCards'
import ProfileViewsChart from '../reputation/ProfileViewsChart'
import { sumProfileTotals } from '../reputation/profileAggregate'
import { formatNumber } from '../shared/utils'
import { C } from '../theme'
import { errorText } from './useGbp'
import { Notice } from './GbpConnectionBar'

const RANGES = [
  { days: 7, label: 'Last 7 Days' },
  { days: 30, label: 'Last 30 Days' },
  { days: 90, label: 'Last 90 Days' },
  { days: 365, label: 'Last 12 Months' },
]

const select = {
  padding: '7px 10px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 12.5,
  color: C.gray700, background: C.white, cursor: 'pointer',
}

function isoDay(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Google publishes a day's figures a few days late, so ranges end yesterday.
function rangeFor(days) {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  return { start: isoDay(start), end: isoDay(end) }
}

function KeywordsCard({ keywords, months }) {
  const max = Math.max(...keywords.map((k) => k.impressions), 1)
  const first = months[0] && formatDate(`${months[0]}-01T12:00:00`)
  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, height: '100%' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 4 }}>How Customers Find You</h3>
      <p style={{ fontSize: 11.5, color: C.gray400, marginBottom: 12 }}>
        Searches that showed the profile{first ? `, monthly figures from ${first}` : ''}. Google gives a floor (&ldquo;over&rdquo;) for rare terms.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {keywords.map((k) => (
          <div key={k.keyword}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
              <span style={{ color: C.gray700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.keyword}</span>
              <span style={{ color: C.gray500, flexShrink: 0, marginLeft: 8 }}>{k.belowThreshold ? 'over ' : ''}{formatNumber(k.impressions)}</span>
            </div>
            <div style={{ height: 6, borderRadius: 9999, background: C.gray100, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 9999, background: C.blue500, width: `${(k.impressions / max) * 100}%` }} />
            </div>
          </div>
        ))}
        {keywords.length === 0 && (
          <div style={{ textAlign: 'center', color: C.gray400, padding: '24px 0', fontSize: 12.5 }}>
            No search terms for these months yet - Google publishes them monthly.
          </div>
        )}
      </div>
    </div>
  )
}

// Views, website clicks, calls and direction requests from Google's
// Business Profile Performance API (synced every 6 hours), against the
// period just before, plus the search terms that found the profile.
export default function GooglePerformanceSection({ locations, reloadKey = 0 }) {
  const [days, setDays] = useState(30)
  const [locationKey, setLocationKey] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const range = useMemo(() => rangeFor(days), [days])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api.getGbpPerformance({ ...range, location: locationKey }))
    } catch (e) {
      setError(errorText(e, 'The Google performance figures could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [range, locationKey])

  useEffect(() => { load() }, [load, reloadKey])

  const current = useMemo(() => sumProfileTotals(data?.rows || []), [data])
  const previous = useMemo(() => sumProfileTotals(data?.prevRows || []), [data])

  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: C.gray900 }}>Google Business Profile Performance</h2>
          {data?.syncedAt && <div style={{ fontSize: 11.5, color: C.gray400 }}>Updated {formatDateTime(data.syncedAt)} &middot; compared with the {days} days before</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={locationKey} onChange={(e) => setLocationKey(e.target.value)} style={select} aria-label="Location">
            <option value="">All Locations</option>
            {locations.map((l) => <option key={l.key} value={l.key}>{l.facility || l.title}</option>)}
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={select} aria-label="Date range">
            {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </select>
        </div>
      </div>

      {data?.error && (
        <Notice kind="warn">
          Performance figures did not sync: {data.error} Reviews and listings are not affected.
        </Notice>
      )}

      <AsyncSection
        loading={loading}
        error={!!error}
        errorMessage={error}
        onRetry={load}
        isEmpty={!data?.firstDate}
        skeleton={<SkeletonBlocks count={2} height={140} />}
        emptyContent={(
          <div style={{ border: '1px dashed ' + C.gray300, borderRadius: 12, padding: '28px 12px', textAlign: 'center', fontSize: 13, color: C.gray400 }}>
            No performance figures have synced from Google yet. They arrive with the next sync (every 6 hours).
          </div>
        )}
      >
        <ProfileStatCards current={current} previous={previous} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'stretch' }}>
          <div style={{ flex: '2 1 460px', minWidth: 0 }}>
            <ProfileViewsChart rows={data?.rows || []} prevRows={data?.prevRows || []} />
          </div>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <KeywordsCard keywords={data?.keywords || []} months={data?.keywordMonths || []} />
          </div>
        </div>
      </AsyncSection>
    </section>
  )
}
