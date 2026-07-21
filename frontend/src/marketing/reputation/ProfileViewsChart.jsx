import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { formatDateFromDate, formatYearMonthFromDate, parseISO } from '../shared/utils'
import { C } from '../theme'

function bucketRows(rows, granularity) {
  if (granularity === 'day') {
    return rows.map((r) => ({
      label: formatDateFromDate(parseISO(r.date)),
      mapsViews: r.mapsViews,
      searchViews: r.searchViews,
    }))
  }

  const buckets = new Map()
  for (const r of rows) {
    const d = parseISO(r.date)
    let key
    let label
    if (granularity === 'week') {
      const day = d.getUTCDay()
      const monday = new Date(d)
      monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7))
      key = monday.toISOString().slice(0, 10)
      label = formatDateFromDate(monday)
    } else {
      key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
      label = formatYearMonthFromDate(d)
    }
    const existing = buckets.get(key)
    if (existing) {
      existing.mapsViews += r.mapsViews
      existing.searchViews += r.searchViews
    } else {
      buckets.set(key, { label, mapsViews: r.mapsViews, searchViews: r.searchViews, sortKey: key })
    }
  }
  return Array.from(buckets.values()).sort((a, b) => (a.sortKey > b.sortKey ? 1 : -1))
}

export default function ProfileViewsChart({ rows, prevRows, platform = 'google' }) {
  const [granularity, setGranularity] = useState('day')
  const [menuOpen, setMenuOpen] = useState(false)
  const [compare, setCompare] = useState(true)

  const title = platform === 'google' ? 'Profile Views — Maps vs. Search' : 'Page Views — Search vs. Direct'
  const primaryLabel = platform === 'google' ? 'Maps Views' : 'Direct Views'
  const secondaryLabel = 'Search Views'

  const data = useMemo(() => {
    const current = bucketRows(rows, granularity)
    const previous = bucketRows(prevRows, granularity)
    return current.map((c, i) => ({
      ...c,
      prevMapsViews: previous[i]?.mapsViews ?? null,
      prevSearchViews: previous[i]?.searchViews ?? null,
    }))
  }, [rows, prevRows, granularity])

  const labels = { day: 'Daily', week: 'Weekly', month: 'Monthly' }

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, position: 'relative' }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900 }}>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setCompare((c) => !c)}
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              fontSize: 12,
              border: '1px solid ' + (compare ? C.gray300 : C.gray200),
              background: compare ? C.gray100 : C.white,
              color: compare ? C.gray800 : C.gray500,
              fontWeight: compare ? 500 : 400,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { if (!compare) e.currentTarget.style.background = C.gray50 }}
            onMouseLeave={(e) => { if (!compare) e.currentTarget.style.background = C.white }}
            title="Overlay the previous period as dashed lines"
          >
            Compare
          </button>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.gray200, fontSize: 12, color: C.gray600, background: C.white, cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
              onMouseLeave={(e) => (e.currentTarget.style.background = C.white)}
            >
              {labels[granularity]}
              <ChevronDown size={12} style={{ color: C.gray400 }} />
            </button>
            {menuOpen && (
              <div style={{ position: 'absolute', right: 0, marginTop: 4, width: 112, borderRadius: 8, border: '1px solid ' + C.gray200, background: C.white, boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)', zIndex: 10, padding: 4 }}>
                {Object.keys(labels).map((g) => (
                  <button
                    key={g}
                    onClick={() => {
                      setGranularity(g)
                      setMenuOpen(false)
                    }}
                    style={{ width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 6, fontSize: 12, background: 'transparent', border: 'none', cursor: 'pointer', color: g === granularity ? C.gray900 : C.gray600, fontWeight: g === granularity ? 500 : 400 }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {labels[g]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} minTickGap={20} />
          <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
            labelStyle={{ fontWeight: 600 }}
            formatter={(v) => Math.round(Number(v) || 0).toLocaleString('en-US')}
          />
          <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: '#6b7280', paddingBottom: 8 }} />
          <Line type="monotone" dataKey="mapsViews" name={primaryLabel} stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="searchViews" name={secondaryLabel} stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
          {compare && (
            <Line
              type="monotone"
              dataKey="prevMapsViews"
              name={`${primaryLabel} (prev. period)`}
              stroke="#93c5fd"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {compare && (
            <Line
              type="monotone"
              dataKey="prevSearchViews"
              name={`${secondaryLabel} (prev. period)`}
              stroke="#fcd34d"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
