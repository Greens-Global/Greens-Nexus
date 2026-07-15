import { useState } from 'react'
import { ArrowUp, ArrowDown, Minus, Plus, ExternalLink } from 'lucide-react'
import { LineChart, Line } from 'recharts'
import { positionDelta } from './aggregate'
import { C, alpha } from '../theme'

const PRIORITY_STYLE = {
  High: { color: C.red600, background: C.red50 },
  Medium: { color: C.amber600, background: C.amber50 },
  Low: { color: C.gray600, background: C.gray100 },
}

export default function RankTrackerCard({ rows, onAddKeyword, onRemove }) {
  const [hoverId, setHoverId] = useState(null)

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${C.gray200}`, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900 }}>Rank Tracker</h3>
        <button
          onClick={onAddKeyword}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            borderRadius: 8,
            background: C.emerald600,
            color: C.white,
            fontSize: 12.5,
            fontWeight: 500,
            border: 'none',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald700)}
          onMouseLeave={(e) => (e.currentTarget.style.background = C.emerald600)}
        >
          <Plus size={13} />
          Add Keyword
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.gray100}`, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: 0 }}>Keyword</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Facility</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Priority</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Position</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Change</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>History</th>
              <th style={{ textAlign: 'right', fontWeight: 500, padding: '8px 10px', paddingRight: 0 }}>URL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const current = r.history[r.history.length - 1]?.position ?? 0
              const delta = positionDelta(r)
              return (
                <tr
                  key={r.id}
                  style={{ borderBottom: ri === rows.length - 1 ? 'none' : `1px solid ${C.gray50}`, background: hoverId === r.id ? alpha(C.gray50, 0.6) : 'transparent' }}
                  onMouseEnter={() => setHoverId(r.id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <td style={{ padding: '10px', paddingLeft: 0, fontWeight: 500, color: C.gray900, whiteSpace: 'nowrap' }}>{r.keyword}</td>
                  <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{r.facility}</td>
                  <td style={{ padding: '10px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 500, ...PRIORITY_STYLE[r.priority] }}>{r.priority}</span>
                  </td>
                  <td style={{ padding: '10px', fontWeight: 600, color: C.gray900, whiteSpace: 'nowrap' }}>#{current}</td>
                  <td style={{ padding: '10px', whiteSpace: 'nowrap' }}>
                    {delta > 0 ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: C.emerald600, fontWeight: 500 }}>
                        <ArrowUp size={12} />
                        {delta}
                      </span>
                    ) : delta < 0 ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: C.red500, fontWeight: 500 }}>
                        <ArrowDown size={12} />
                        {Math.abs(delta)}
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: C.gray400 }}>
                        <Minus size={12} />
                        0
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '10px' }}>
                    <LineChart width={90} height={24} data={r.history.map((h) => ({ v: -h.position }))}>
                      <Line
                        type="monotone"
                        dataKey="v"
                        stroke={delta > 0 ? '#10b981' : delta < 0 ? '#ef4444' : '#9ca3af'}
                        strokeWidth={1.5}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </td>
                  <td style={{ padding: '10px', paddingRight: 0, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <a
                      href={r.url}
                      onClick={(e) => e.preventDefault()}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: C.gray400, cursor: 'pointer' }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = C.emerald600)}
                      onMouseLeave={(e) => (e.currentTarget.style.color = C.gray400)}
                    >
                      <ExternalLink size={12} />
                    </a>
                    <button
                      onClick={() => onRemove(r.id)}
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        color: C.gray300,
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        opacity: hoverId === r.id ? 1 : 0,
                        transition: 'opacity .15s',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = C.red500)}
                      onMouseLeave={(e) => (e.currentTarget.style.color = C.gray300)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: C.gray400, padding: '24px 0' }}>
                  No keywords tracked yet. Add one from Keyword Explorer or the button above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
