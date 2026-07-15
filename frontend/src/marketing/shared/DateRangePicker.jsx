import { useEffect, useRef, useState } from 'react'
import { Calendar, ChevronDown } from 'lucide-react'
import { DATA_END, DATA_START, lastMonth, lastNDays, thisMonth } from './utils'
import { C, FONT } from '../theme'

const presets = [
  { label: 'Last 7 Days', get: () => lastNDays(7) },
  { label: 'Last 30 Days', get: () => lastNDays(30) },
  { label: 'This Month', get: () => thisMonth() },
  { label: 'Last Month', get: () => lastMonth() },
]

export default function DateRangePicker({ range, onChange }) {
  const [open, setOpen] = useState(false)
  const [customStart, setCustomStart] = useState(range.start)
  const [customEnd, setCustomEnd] = useState(range.end)
  const ref = useRef(null)

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  useEffect(() => {
    setCustomStart(range.start)
    setCustomEnd(range.end)
  }, [range])

  return (
    <div style={{ position: 'relative', fontFamily: FONT }} ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
        onMouseLeave={(e) => (e.currentTarget.style.background = C.white)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid ' + C.gray200,
          background: C.white,
          fontSize: 13,
          fontWeight: 500,
          color: C.gray700,
          cursor: 'pointer',
        }}
      >
        <Calendar size={14} color={C.gray400} />
        Filter
        <ChevronDown size={14} color={C.gray400} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            marginTop: 8,
            width: 256,
            borderRadius: 12,
            border: '1px solid ' + C.gray200,
            background: C.white,
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
            zIndex: 20,
            padding: 12,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 }}>
            {presets.map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  onChange(p.get())
                  setOpen(false)
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.gray100)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                style={{
                  textAlign: 'left',
                  padding: '6px 10px',
                  borderRadius: 6,
                  fontSize: 13,
                  color: C.gray700,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ borderTop: '1px solid ' + C.gray100, paddingTop: 12 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: C.gray400,
                textTransform: 'uppercase',
                letterSpacing: '0.025em',
                marginBottom: 8,
              }}
            >
              Custom Range
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input
                type="date"
                value={customStart}
                min={DATA_START}
                max={customEnd}
                onChange={(e) => setCustomStart(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid ' + C.gray200,
                  fontSize: 12,
                  color: C.gray700,
                  fontFamily: FONT,
                }}
              />
              <span style={{ color: C.gray300, fontSize: 12 }}>-</span>
              <input
                type="date"
                value={customEnd}
                min={customStart}
                max={DATA_END}
                onChange={(e) => setCustomEnd(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid ' + C.gray200,
                  fontSize: 12,
                  color: C.gray700,
                  fontFamily: FONT,
                }}
              />
            </div>
            <button
              onClick={() => {
                onChange({ start: customStart, end: customEnd })
                setOpen(false)
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.gray800)}
              onMouseLeave={(e) => (e.currentTarget.style.background = C.gray900)}
              style={{
                width: '100%',
                padding: '6px 10px',
                borderRadius: 6,
                background: C.gray900,
                color: C.white,
                fontSize: 12,
                fontWeight: 500,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
