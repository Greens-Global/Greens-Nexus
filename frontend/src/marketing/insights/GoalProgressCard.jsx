import { useState } from 'react'
import { Pencil, Check } from 'lucide-react'
import { formatNumber } from '../shared/utils'
import { monthCoverageFraction } from '../shared/utils'
import { C, card } from '../theme'

export default function GoalProgressCard({ leads, goal, onChangeGoal, range }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(goal))

  const pct = goal > 0 ? Math.min(100, (leads / goal) * 100) : 0
  const remaining = Math.max(0, goal - leads)
  const barBg = pct >= 100 ? C.emerald500 : pct >= 75 ? C.blue500 : C.amber500

  const coverage = monthCoverageFraction(range)
  const projected = coverage > 0 ? leads / coverage : leads
  const showProjection = coverage < 0.999
  const projectedPct = goal > 0 ? (projected / goal) * 100 : 0
  const projBg = projectedPct >= 100 ? C.emerald50 : projectedPct >= 75 ? C.blue50 : C.amber50
  const projColor = projectedPct >= 100 ? C.emerald700 : projectedPct >= 75 ? C.blue700 : C.amber700

  function commit() {
    const value = Number(draft)
    if (!Number.isNaN(value) && value > 0) onChangeGoal(value)
    else setDraft(String(goal))
    setEditing(false)
  }

  return (
    <div style={{ ...card, padding: 16, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Monthly Lead Goal</h3>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 22, fontWeight: 600, color: C.gray900 }}>{formatNumber(leads)}</span>
        <span style={{ fontSize: 14, color: C.gray400 }}>/ {formatNumber(goal)}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: pct >= 100 ? C.emerald600 : C.gray500 }}>{pct.toFixed(0)}%</span>
      </div>
      <div style={{ width: '100%', height: 10, borderRadius: 9999, background: C.gray100, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ height: '100%', borderRadius: 9999, background: barBg, transition: 'all .15s', width: `${pct}%` }} />
      </div>

      {showProjection && (
        <div style={{ marginBottom: 16, borderRadius: 8, padding: '8px 10px', fontSize: 12, background: projBg, color: projColor }}>
          On pace for <span style={{ fontWeight: 600 }}>{formatNumber(projected)}</span> leads by month end ({projectedPct.toFixed(0)}% of goal)
        </div>
      )}

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.gray500 }}>
          Monthly Goal
          {editing ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                autoFocus
                type="number"
                min={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
                style={{ width: 96, padding: '2px 6px', borderRadius: 6, border: '1px solid ' + C.gray200, fontSize: 12.5 }}
              />
              <button
                onClick={commit}
                style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: C.emerald600, background: 'transparent', border: 'none', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald50)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Check size={13} />
              </button>
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500, color: C.gray700 }}>
              {formatNumber(goal)}
              <button
                onClick={() => {
                  setDraft(String(goal))
                  setEditing(true)
                }}
                style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: C.gray400, background: 'transparent', border: 'none', cursor: 'pointer' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = C.gray100
                  e.currentTarget.style.color = C.gray600
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = C.gray400
                }}
              >
                <Pencil size={11} />
              </button>
            </span>
          )}
        </div>
        <div style={{ color: C.gray500 }}>
          Remaining <span style={{ fontWeight: 500, color: C.gray700 }}>{formatNumber(remaining)}</span>
        </div>
      </div>
    </div>
  )
}
