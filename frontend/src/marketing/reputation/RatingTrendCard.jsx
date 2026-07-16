import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { formatYearMonthFromDate } from '../shared/utils'
import { C } from '../theme'

export default function RatingTrendCard({ reviews }) {
  const data = useMemo(() => {
    const byMonth = new Map()
    for (const r of reviews) {
      const key = r.date.slice(0, 7) // yyyy-mm
      const bucket = byMonth.get(key)
      if (bucket) {
        bucket.sum += r.rating
        bucket.count++
      } else {
        byMonth.set(key, { sum: r.rating, count: 1 })
      }
    }
    return Array.from(byMonth.entries())
      .sort(([a], [b]) => (a > b ? 1 : -1))
      .map(([key, { sum, count }]) => {
        const [y, m] = key.split('-').map(Number)
        return {
          label: formatYearMonthFromDate(new Date(Date.UTC(y, m - 1, 1))),
          rating: Math.round((sum / count) * 100) / 100,
          count,
        }
      })
  }, [reviews])

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 8 }}>Rating Trend</h3>
      {data.length === 0 ? (
        <div style={{ color: C.gray400, fontSize: 13, padding: '32px 0', textAlign: 'center' }}>No reviews in this view.</div>
      ) : (
        <ResponsiveContainer width="100%" height={140}>
          <LineChart data={data} margin={{ top: 6, right: 6, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <YAxis domain={[3, 5]} ticks={[3, 4, 5]} tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(v, _name, item) => [`${v} avg (${item?.payload?.count ?? 0} reviews)`, 'Rating']}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
            />
            <Line type="monotone" dataKey="rating" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
      <p style={{ fontSize: 11, color: C.gray400, marginTop: 6 }}>Average star rating by month</p>
    </div>
  )
}
