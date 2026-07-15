import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { parseISO } from '../shared/utils'
import { C, card, shadowLg } from '../theme'

function bucketRows(rows, granularity) {
  if (granularity === 'day') {
    return rows.map((r) => ({
      label: parseISO(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      leads: r.leads,
      sessions: r.sessions,
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
      label = monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    } else {
      key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
      label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    }
    const existing = buckets.get(key)
    if (existing) {
      existing.leads += r.leads
      existing.sessions += r.sessions
    } else {
      buckets.set(key, { label, leads: r.leads, sessions: r.sessions, sortKey: key })
    }
  }
  return Array.from(buckets.values()).sort((a, b) => (a.sortKey > b.sortKey ? 1 : -1))
}

export default function LeadsTrendChart({ rows, prevRows }) {
  const [granularity, setGranularity] = useState('day')
  const [menuOpen, setMenuOpen] = useState(false)
  const [compare, setCompare] = useState(true)

  const data = useMemo(() => {
    const current = bucketRows(rows, granularity)
    const previous = bucketRows(prevRows, granularity)
    return current.map((c, i) => ({
      ...c,
      prevLeads: previous[i]?.leads ?? null,
      prevSessions: previous[i]?.sessions ?? null,
    }))
  }, [rows, prevRows, granularity])

  const labels = { day: 'Daily', week: 'Weekly', month: 'Monthly' }

  return (
    <div style={{ ...card, padding: 16, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, position: 'relative' }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900 }}>Leads &amp; Sessions Over Time</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setCompare((c) => !c)}
            title="Overlay the previous period as dashed lines"
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              fontSize: 12,
              cursor: 'pointer',
              border: '1px solid ' + (compare ? C.gray300 : C.gray200),
              background: compare ? C.gray100 : 'transparent',
              color: compare ? C.gray800 : C.gray500,
              fontWeight: compare ? 500 : 400,
            }}
            onMouseEnter={(e) => {
              if (!compare) e.currentTarget.style.background = C.gray50
            }}
            onMouseLeave={(e) => {
              if (!compare) e.currentTarget.style.background = 'transparent'
            }}
          >
            Compare
          </button>
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + C.gray200, fontSize: 12, color: C.gray600, background: 'transparent', cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {labels[granularity]}
              <ChevronDown size={12} style={{ color: C.gray400 }} />
            </button>
            {menuOpen && (
              <div style={{ position: 'absolute', right: 0, marginTop: 4, width: 112, borderRadius: 8, border: '1px solid ' + C.gray200, background: C.white, boxShadow: shadowLg, zIndex: 10, padding: 4 }}>
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

      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} minTickGap={20} />
          <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
            labelStyle={{ fontWeight: 600 }}
            formatter={(v) => Math.round(Number(v) || 0).toLocaleString('en-US')}
          />
          <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: '#6b7280', paddingBottom: 8 }} />
          <Line yAxisId="left" type="monotone" dataKey="leads" name="Leads" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line yAxisId="right" type="monotone" dataKey="sessions" name="Sessions" stroke="#a855f7" strokeWidth={2} dot={false} isAnimationActive={false} />
          {compare && (
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="prevLeads"
              name="Leads (prev. period)"
              stroke="#93c5fd"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
          {compare && (
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="prevSessions"
              name="Sessions (prev. period)"
              stroke="#d8b4fe"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      <p style={{ fontSize: 11.5, color: C.gray400, marginTop: 8, lineHeight: 1.375 }}>
        <span style={{ color: C.blue600, fontWeight: 500 }}>Leads</span> = people who reached out about renting a unit (filled out a form, called, or
        walked in). <span style={{ color: C.purple600, fontWeight: 500 }}>Sessions</span> = visits to your website that day.
      </p>
    </div>
  )
}
