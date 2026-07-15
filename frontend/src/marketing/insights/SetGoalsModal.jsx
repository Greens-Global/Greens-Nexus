import { useState } from 'react'
import Modal from '../googleAds/Modal'
import { formatNumber } from '../shared/utils'
import { C } from '../theme'

export default function SetGoalsModal({ facilities, leadGoalByProperty, onChangeLeadGoal, onClose }) {
  const [draft, setDraft] = useState(leadGoalByProperty)
  const [error, setError] = useState('')

  function handleChange(facility, raw) {
    if (raw.trim() === '') {
      setError('')
      setDraft((prev) => ({ ...prev, [facility]: 0 }))
      return
    }
    const parsed = Number(raw)
    if (Number.isNaN(parsed) || parsed < 0) {
      setError('Goals must be positive numbers.')
      return
    }
    setError('')
    setDraft((prev) => ({ ...prev, [facility]: parsed }))
  }

  const total = facilities.reduce((a, f) => a + (draft[f] ?? 0), 0)

  function handleSave() {
    if (error) return
    for (const f of facilities) onChangeLeadGoal(f, draft[f] ?? 0)
    onClose()
  }

  return (
    <Modal title="Set Goals" onClose={onClose} width="max-w-md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ fontSize: 12.5, color: C.gray500 }}>Set a monthly lead goal for each property.</p>

        <div style={{ borderRadius: 8, border: '1px solid ' + C.gray100, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8, padding: '8px 12px', background: C.gray50, fontSize: 11.5, fontWeight: 500, color: C.gray500 }}>
            <div>Property</div>
            <div>Monthly Lead Goal</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {facilities.map((f, i) => (
              <div key={f} style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8, padding: '8px 12px', alignItems: 'center', borderTop: i > 0 ? '1px solid ' + C.gray100 : 'none' }}>
                <div style={{ fontSize: 12.5, color: C.gray700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</div>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={draft[f] ? String(draft[f]) : ''}
                  onChange={(e) => handleChange(f, e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 12.5, outline: 'none' }}
                />
              </div>
            ))}
          </div>
        </div>

        {error && <div style={{ fontSize: 12.5, color: C.red500 }}>{error}</div>}

        <div style={{ borderRadius: 8, background: C.gray50, border: '1px solid ' + C.gray100, padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
          <div style={{ color: C.gray400 }}>Total Monthly Lead Goal</div>
          <div style={{ fontWeight: 600, color: C.gray900, fontSize: 13 }}>{formatNumber(total)}</div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500, color: C.gray600, background: 'transparent', border: 'none', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.gray100)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            style={{ padding: '8px 12px', borderRadius: 8, background: C.emerald600, color: C.white, fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer' }}
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
