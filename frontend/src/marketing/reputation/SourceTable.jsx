import { ArrowUpDown } from 'lucide-react'
import PlatformBadge from './PlatformBadge'
import { useSortable } from '../shared/useSortable'
import { C, alpha } from '../theme'

const DISPLAY_NAME = {
  Google: 'Google',
  Yelp: 'Yelp',
  Facebook: 'Facebook',
  'Storage Facility Finder': 'Storage Finder',
  Other: 'Other',
}

function getValue(r, key) {
  switch (key) {
    case 'platform':
      return r.platform
    case 'reviews':
      return r.reviews
    case 'avgRating':
      return r.avgRating
    case 'trend':
      return r.trend
  }
}

const columns = [
  { key: 'platform', label: 'Platform' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'avgRating', label: 'Avg. Rating' },
  { key: 'trend', label: 'Trend' },
]

export default function SourceTable({ rows }) {
  const { sorted, sortKey, sortDir, toggleSort } = useSortable(rows, getValue, 'reviews')

  const totalReviews = rows.reduce((a, r) => a + r.reviews, 0)
  const totalAvg = totalReviews > 0 ? rows.reduce((a, r) => a + r.avgRating * r.reviews, 0) / totalReviews : 0
  const totalTrend = rows.reduce((a, r) => a + r.trend * r.reviews, 0) / (totalReviews || 1)

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>External Review Sources</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid ' + C.gray100, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
              {columns.map((col, ci) => (
                <th key={col.key} style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: ci === 0 ? 0 : 10, whiteSpace: 'nowrap' }}>
                  <button
                    onClick={() => toggleSort(col.key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, color: sortKey === col.key ? C.gray700 : 'inherit', background: 'transparent', border: 'none', cursor: 'pointer', font: 'inherit', textTransform: 'inherit' }}
                  >
                    {col.label}
                    <ArrowUpDown
                      size={10}
                      style={{
                        transition: 'transform .15s',
                        opacity: sortKey === col.key ? 1 : 0.3,
                        transform: sortKey === col.key && sortDir === 'asc' ? 'rotate(180deg)' : 'none',
                      }}
                    />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.platform}
                style={{ borderBottom: '1px solid ' + C.gray50 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.gray50, 0.6))}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '10px 10px', paddingLeft: 0, fontWeight: 500, color: C.gray900, whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <PlatformBadge platform={r.platform} size={18} />
                    {DISPLAY_NAME[r.platform]}
                  </span>
                </td>
                <td style={{ padding: '10px 10px', color: C.gray700, whiteSpace: 'nowrap' }}>{r.reviews.toLocaleString()}</td>
                <td style={{ padding: '10px 10px', color: C.gray700, whiteSpace: 'nowrap' }}>{r.avgRating.toFixed(1)}</td>
                <td style={{ padding: '10px 10px', whiteSpace: 'nowrap', fontWeight: 500, color: r.trend >= 0 ? C.emerald600 : C.red500 }}>
                  {r.trend >= 0 ? '+' : ''}
                  {r.trend.toFixed(1)}
                </td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid ' + C.gray200, fontWeight: 600, color: C.gray900 }}>
              <td style={{ padding: '10px 10px', paddingLeft: 0, whiteSpace: 'nowrap' }}>Total</td>
              <td style={{ padding: '10px 10px', whiteSpace: 'nowrap' }}>{totalReviews.toLocaleString()}</td>
              <td style={{ padding: '10px 10px', whiteSpace: 'nowrap' }}>{totalAvg.toFixed(1)}</td>
              <td style={{ padding: '10px 10px', whiteSpace: 'nowrap', color: totalTrend >= 0 ? C.emerald600 : C.red500 }}>
                {totalTrend >= 0 ? '+' : ''}
                {totalTrend.toFixed(1)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
