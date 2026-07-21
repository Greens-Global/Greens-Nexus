import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import ReviewCard from './ReviewCard'
import { C } from '../theme'

const FILTER_LABELS = {
  Pending: 'Pending Replies',
  Posted: 'Replied',
  All: 'All',
}

const PLATFORM_OPTIONS = ['All', 'Google', 'Facebook', 'Storage Facility Finder', 'Other']
const RATING_OPTIONS = ['All', 5, 4, 3, 2, 1]

export default function ReviewsFeedCard({ reviews, onApprove, onRegenerate }) {
  const [statusFilter, setStatusFilter] = useState('Pending')
  const [platformFilter, setPlatformFilter] = useState('All')
  const [ratingFilter, setRatingFilter] = useState('All')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    let rows = reviews
    if (statusFilter === 'Pending') rows = rows.filter((r) => r.status !== 'Posted')
    if (statusFilter === 'Posted') rows = rows.filter((r) => r.status === 'Posted')
    if (platformFilter !== 'All') rows = rows.filter((r) => r.platform === platformFilter)
    if (ratingFilter !== 'All') rows = rows.filter((r) => r.rating === ratingFilter)
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      rows = rows.filter((r) => r.customer.toLowerCase().includes(q) || r.text.toLowerCase().includes(q) || r.facility.toLowerCase().includes(q))
    }
    return rows
  }, [reviews, statusFilter, platformFilter, ratingFilter, query])

  const selectStyle = { padding: '6px 10px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 12, color: C.gray600, outline: 'none' }

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900 }}>Live Reviews Feed</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, borderRadius: 8, border: '1px solid ' + C.gray200, padding: 2 }}>
            {['Pending', 'Posted', 'All'].map((f) => {
              const active = statusFilter === f
              return (
                <button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 11.5,
                    fontWeight: 500,
                    background: active ? C.gray900 : 'transparent',
                    color: active ? C.white : C.gray500,
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  {FILTER_LABELS[f]}
                </button>
              )
            })}
          </div>
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            style={selectStyle}
          >
            {PLATFORM_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p === 'All' ? 'All Platforms' : p}
              </option>
            ))}
          </select>
          <select
            value={ratingFilter}
            onChange={(e) => setRatingFilter(e.target.value === 'All' ? 'All' : Number(e.target.value))}
            style={selectStyle}
          >
            {RATING_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r === 'All' ? 'All Ratings' : `${r} Star${r === 1 ? '' : 's'}`}
              </option>
            ))}
          </select>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: C.gray400 }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search reviews..."
              style={{ paddingLeft: 32, paddingRight: 12, paddingTop: 6, paddingBottom: 6, borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 12.5, width: 176, outline: 'none' }}
            />
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', maxHeight: 720, display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 4 }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: C.gray400, fontSize: 13, padding: '40px 0' }}>No reviews match this filter.</div>
        )}
        {filtered.map((r) => (
          <ReviewCard key={r.id} review={r} onApprove={onApprove} onRegenerate={onRegenerate} />
        ))}
      </div>
    </div>
  )
}
