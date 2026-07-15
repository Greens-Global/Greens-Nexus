import { useMemo } from 'react'
import Modal from '../shared/Modal'
import PlatformBadge from './PlatformBadge'
import StarRating from '../shared/StarRating'
import { C } from '../theme'

function ReviewListTable({ reviews }) {
  if (reviews.length === 0) {
    return <div style={{ color: C.gray400, fontSize: 13, padding: '24px 0', textAlign: 'center' }}>No reviews in this view.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto', paddingRight: 4 }}>
      {reviews.map((r) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid ' + C.gray50, paddingBottom: 8 }}>
          <PlatformBadge platform={r.platform} size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: C.gray900, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.customer}</span>
              <StarRating value={r.rating} size={10} />
            </div>
            <div style={{ fontSize: 11.5, color: C.gray400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.facility} &middot; via {r.platform}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: C.gray400, flexShrink: 0, textAlign: 'right' }}>
            {new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            <div style={{ color: C.gray300 }}>{r.status}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function BarBreakdown({ rows }) {
  const max = rows.length > 0 ? Math.max(...rows.map((r) => r.value)) : 0
  if (rows.length === 0) return <div style={{ color: C.gray400, fontSize: 13, padding: '24px 0', textAlign: 'center' }}>No data in this view.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: C.gray700, width: 128, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <div style={{ flex: 1, height: 8, borderRadius: 9999, background: C.gray100, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 9999, background: '#fbbf24', width: max > 0 ? `${(r.value / max) * 100}%` : '0%' }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 500, color: C.gray900, width: 40, textAlign: 'right', flexShrink: 0 }}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function StatDetailModal({ statKey, label, reviewsAsOfEnd, reviewsInMonth, sourceSummary, onClose }) {
  const ratingDistribution = useMemo(() => {
    const counts = [0, 0, 0, 0, 0]
    for (const r of reviewsAsOfEnd) counts[r.rating - 1]++
    return [5, 4, 3, 2, 1].map((star) => ({ label: `${star} star`, value: counts[star - 1] }))
  }, [reviewsAsOfEnd])

  const platformCounts = useMemo(
    () => sourceSummary.map((s) => ({ label: s.platform, value: s.reviews })).sort((a, b) => b.value - a.value),
    [sourceSummary],
  )

  const newReviewsSorted = useMemo(() => [...reviewsInMonth].sort((a, b) => (a.date < b.date ? 1 : -1)), [reviewsInMonth])
  const pendingReviewsSorted = useMemo(
    () => reviewsInMonth.filter((r) => r.status !== 'Posted').sort((a, b) => (a.date < b.date ? 1 : -1)),
    [reviewsInMonth],
  )

  const headingStyle = { fontSize: 12, fontWeight: 600, color: C.gray400, textTransform: 'uppercase', letterSpacing: '0.025em', marginBottom: 12 }

  return (
    <Modal title={label} onClose={onClose} width="max-w-lg">
      {statKey === 'rating' && (
        <div>
          <h3 style={headingStyle}>Rating distribution (all-time)</h3>
          <BarBreakdown rows={ratingDistribution} />
        </div>
      )}

      {statKey === 'total' && (
        <div>
          <h3 style={headingStyle}>Reviews by platform (all-time)</h3>
          <BarBreakdown rows={platformCounts} />
        </div>
      )}

      {statKey === 'new' && (
        <div>
          <h3 style={headingStyle}>
            New reviews this month ({newReviewsSorted.length})
          </h3>
          <ReviewListTable reviews={newReviewsSorted} />
        </div>
      )}

      {statKey === 'pending' && (
        <div>
          <h3 style={headingStyle}>
            Pending replies this month ({pendingReviewsSorted.length})
          </h3>
          <ReviewListTable reviews={pendingReviewsSorted} />
        </div>
      )}
    </Modal>
  )
}
