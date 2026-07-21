import { useState } from 'react'
import Modal from './Modal'
import { formatCurrency } from './utils'
import { C } from '../theme'

const PERIODS = [
  { key: 'monthly', label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'half-yearly', label: 'Half-Yearly' },
  { key: 'yearly', label: 'Yearly' },
]

const MULTIPLIER = {
  monthly: 1,
  quarterly: 3,
  'half-yearly': 6,
  yearly: 12,
}

function toDisplay(monthly, period) {
  const value = monthly * MULTIPLIER[period]
  return value === 0 ? '' : String(Math.round(value * 100) / 100)
}

const cellInput = { width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 12.5, outline: 'none' }

export default function SetBudgetModal({
  facilities,
  googleBudgetByProperty,
  onChangeGoogleBudget,
  onClose,
}) {
  const [period, setPeriod] = useState('monthly')
  const [google, setGoogle] = useState(googleBudgetByProperty)
  const [error, setError] = useState('')

  function handleChange(facility, raw) {
    if (raw.trim() === '') {
      setError('')
      setGoogle((prev) => ({ ...prev, [facility]: 0 }))
      return
    }
    const parsed = Number(raw)
    if (Number.isNaN(parsed) || parsed < 0) {
      setError('Budgets must be positive numbers.')
      return
    }
    setError('')
    const monthly = parsed / MULTIPLIER[period]
    setGoogle((prev) => ({ ...prev, [facility]: monthly }))
  }

  const googleSubtotal = facilities.reduce((a, f) => a + (google[f] ?? 0), 0) * MULTIPLIER[period]

  function handleSave() {
    if (error) return
    for (const f of facilities) {
      onChangeGoogleBudget(f, google[f] ?? 0)
    }
    onClose()
  }

  return (
    <Modal title="Set Budget" onClose={onClose} width="max-w-2xl">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12.5, fontWeight: 500, color: C.gray600, marginBottom: 6 }}>Budget Period</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {PERIODS.map((p) => {
              const active = period === p.key
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPeriod(p.key)}
                  style={{
                    flex: 1,
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: '1px solid ' + (active ? C.gray900 : C.gray200),
                    fontSize: 12.5,
                    fontWeight: 500,
                    background: active ? C.gray900 : 'transparent',
                    color: active ? C.white : C.gray600,
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ borderRadius: 8, border: '1px solid ' + C.gray100, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '8px 12px', background: C.gray50, fontSize: 11.5, fontWeight: 500, color: C.gray500 }}>
            <div>Property</div>
            <div>Google Ads Budget</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {facilities.map((f, i) => (
              <div key={f} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '8px 12px', alignItems: 'center', borderTop: i === 0 ? 'none' : '1px solid ' + C.gray100 }}>
                <div style={{ fontSize: 12.5, color: C.gray700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</div>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={toDisplay(google[f] ?? 0, period)}
                  onChange={(e) => handleChange(f, e.target.value)}
                  style={cellInput}
                />
              </div>
            ))}
          </div>
        </div>

        {error && <div style={{ fontSize: 12.5, color: C.red500 }}>{error}</div>}

        <div style={{ borderRadius: 8, background: C.gray50, border: '1px solid ' + C.gray100, padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
          <div style={{ color: C.gray400 }}>Google Ads Total</div>
          <div style={{ fontWeight: 600, color: C.gray900 }}>{formatCurrency(googleSubtotal)}</div>
        </div>
        <p style={{ fontSize: 11, color: C.gray400, marginTop: -8 }}>
          Budgets are always stored monthly — switching the period just rescales what you see and enter.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500, color: C.gray600, background: 'transparent' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.gray100)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            style={{ padding: '8px 12px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 13, fontWeight: 500 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald700)}
            onMouseLeave={(e) => (e.currentTarget.style.background = C.emerald600)}
          >
            Save Changes
          </button>
        </div>
      </div>
    </Modal>
  )
}
