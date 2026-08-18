import { useState } from 'react'
import Modal from '../shared/Modal'
import { FACILITIES } from '../shared/facilities'
import { C } from '../theme'

const PRIORITIES = ['High', 'Medium', 'Low']

export default function AddTrackedKeywordModal({ database, trackedKeywordNames, presetKeyword, initialFacility, onAdd, onClose }) {
  const untracked = database.filter((k) => !trackedKeywordNames.has(k.keyword))
  const [keywordName, setKeywordName] = useState(presetKeyword?.keyword ?? untracked[0]?.keyword ?? '')
  const [facility, setFacility] = useState(presetKeyword?.facility ?? initialFacility ?? FACILITIES[0])
  const [priority, setPriority] = useState('Medium')
  const initialKeyword = presetKeyword?.keyword ?? untracked[0]?.keyword ?? ''
  const initialFacilityVal = presetKeyword?.facility ?? initialFacility ?? FACILITIES[0]
  const dirty = keywordName !== initialKeyword || facility !== initialFacilityVal || priority !== 'Medium'

  function submit() {
    const kw = database.find((k) => k.keyword === keywordName)
    if (!kw) return
    onAdd(kw, facility, priority)
    onClose()
  }

  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 500, color: C.gray600, marginBottom: 6 }
  const selectStyle = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: 8,
    border: `1px solid ${C.gray200}`,
    fontSize: 13,
    color: C.gray700,
    outline: 'none',
    background: C.white,
    boxSizing: 'border-box',
  }

  return (
    <Modal title="Add Keyword to Rank Tracker" onClose={onClose} width="max-w-md" isDirty={dirty} onSave={keywordName ? submit : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={labelStyle}>Keyword</label>
          {presetKeyword ? (
            <div style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${C.gray200}`, fontSize: 13, color: C.gray700, background: C.gray50 }}>{presetKeyword.keyword}</div>
          ) : (
            <select
              value={keywordName}
              onChange={(e) => setKeywordName(e.target.value)}
              style={selectStyle}
              onFocus={(e) => (e.currentTarget.style.boxShadow = `0 0 0 2px ${C.gray200}`)}
              onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
            >
              {untracked.map((k) => (
                <option key={k.keyword} value={k.keyword}>
                  {k.keyword}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label style={labelStyle}>Facility</label>
          <select
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            style={selectStyle}
            onFocus={(e) => (e.currentTarget.style.boxShadow = `0 0 0 2px ${C.gray200}`)}
            onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
          >
            {FACILITIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Priority</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {PRIORITIES.map((p) => {
              const active = priority === p
              return (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  style={{
                    flex: 1,
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: `1px solid ${active ? C.gray900 : C.gray200}`,
                    fontSize: 12.5,
                    fontWeight: 500,
                    background: active ? C.gray900 : C.white,
                    color: active ? C.white : C.gray600,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = C.gray50
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = C.white
                  }}
                >
                  {p}
                </button>
              )
            })}
          </div>
        </div>

        <button
          onClick={submit}
          disabled={!keywordName}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 8,
            background: C.emerald600,
            color: C.white,
            fontSize: 13,
            fontWeight: 500,
            border: 'none',
            cursor: keywordName ? 'pointer' : 'default',
            opacity: keywordName ? 1 : 0.5,
          }}
          onMouseEnter={(e) => {
            if (keywordName) e.currentTarget.style.background = C.emerald700
          }}
          onMouseLeave={(e) => {
            if (keywordName) e.currentTarget.style.background = C.emerald600
          }}
        >
          Add to Tracker
        </button>
      </div>
    </Modal>
  )
}
