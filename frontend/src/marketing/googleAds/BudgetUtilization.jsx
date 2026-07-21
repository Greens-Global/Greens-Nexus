import { useEffect, useState } from 'react'
import { Pencil, Check } from 'lucide-react'
import { formatCurrency } from './utils'
import { monthCoverageFraction } from '../shared/utils'
import { C } from '../theme'

export default function BudgetUtilization({ spend, budget, onChangeBudget, range, editable = true, scopeLabel }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(budget))

  // Keep the draft in sync when the scoped budget changes underneath us
  // (e.g. switching the property filter) while not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(String(budget))
  }, [budget, editing])

  const pct = budget > 0 ? Math.min(100, (spend / budget) * 100) : 0
  const remaining = budget - spend
  const barColor = pct >= 100 ? C.red500 : pct >= 85 ? C.amber500 : C.emerald500

  // Extrapolate a partial-month range (e.g. "Last 7 Days") to a projected
  // month-end spend. For a full-month range the coverage fraction is 1, so
  // projected === actual and the line is hidden as redundant.
  const coverage = monthCoverageFraction(range)
  const projected = coverage > 0 ? spend / coverage : spend
  const showProjection = coverage < 0.999
  const projectedPct = budget > 0 ? (projected / budget) * 100 : 0

  const projStyle =
    projectedPct >= 100
      ? { background: C.red50, color: C.red600 }
      : projectedPct >= 85
      ? { background: C.amber50, color: C.amber700 }
      : { background: C.emerald50, color: C.emerald700 }

  function commit() {
    const value = Number(draft)
    if (!Number.isNaN(value) && value > 0) onChangeBudget(value)
    else setDraft(String(budget))
    setEditing(false)
  }

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 2 }}>Budget Utilization</h3>
      {scopeLabel && <p style={{ fontSize: 11, color: C.gray400, marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scopeLabel}</p>}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 22, fontWeight: 600, color: C.gray900 }}>{formatCurrency(spend)}</span>
        <span style={{ fontSize: 14, color: C.gray400 }}>/ {formatCurrency(budget)}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: pct >= 100 ? C.red500 : C.emerald600 }}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div style={{ width: '100%', height: 10, borderRadius: 9999, background: C.gray100, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ height: '100%', borderRadius: 9999, background: barColor, transition: 'all .15s', width: `${pct}%` }} />
      </div>

      {showProjection && (
        <div style={{ marginBottom: 16, borderRadius: 8, padding: '8px 10px', fontSize: 12, ...projStyle }}>
          On pace for <span style={{ fontWeight: 600 }}>{formatCurrency(projected)}</span> by month end ({projectedPct.toFixed(0)}% of budget)
        </div>
      )}

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.gray500 }}>
          Monthly Budget
          {editable && editing ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                autoFocus
                type="number"
                min={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commit()}
                style={{ width: 96, padding: '2px 6px', borderRadius: 4, border: '1px solid ' + C.gray200, fontSize: 12.5 }}
              />
              <button
                onClick={commit}
                style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, color: C.emerald600 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald50)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Check size={13} />
              </button>
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500, color: C.gray700 }}>
              {formatCurrency(budget)}
              {editable && (
                <button
                  onClick={() => {
                    setDraft(String(budget))
                    setEditing(true)
                  }}
                  style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, color: C.gray400 }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = C.gray100; e.currentTarget.style.color = C.gray600 }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.gray400 }}
                >
                  <Pencil size={11} />
                </button>
              )}
            </span>
          )}
        </div>
        <div style={{ color: C.gray500 }}>
          Remaining <span style={{ fontWeight: 500, color: remaining < 0 ? C.red500 : C.gray700 }}>{formatCurrency(remaining)}</span>
        </div>
        {!editable && <div style={{ fontSize: 11, color: C.gray400 }}>Select a property to edit its budget.</div>}
      </div>
    </div>
  )
}
