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

// The filter always displays and accepts dates as YYYY/MM/DD — native
// `<input type="date">` renders in whatever format the browser/OS locale
// dictates, which can't be forced to a specific format, so custom range
// entry uses a plain text field instead.
function toDisplay(iso) {
  return iso.replaceAll('-', '/')
}

function toISO(display) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(display.trim())
  if (!m) return null
  const [, y, mo, d] = m
  const iso = `${y}-${mo}-${d}`
  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null
  return iso
}

export default function DateRangePicker({ range, onChange }) {
  const [open, setOpen] = useState(false)
  const [startText, setStartText] = useState(toDisplay(range.start))
  const [endText, setEndText] = useState(toDisplay(range.end))
  const [error, setError] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  useEffect(() => {
    setStartText(toDisplay(range.start))
    setEndText(toDisplay(range.end))
    setError('')
  }, [range])

  function applyCustomRange() {
    const start = toISO(startText)
    const end = toISO(endText)
    if (!start || !end) {
      setError('Enter dates as YYYY/MM/DD.')
      return
    }
    if (start > end) {
      setError('Start date must be before end date.')
      return
    }
    if (start < DATA_START || end > DATA_END) {
      setError(`Dates must be between ${toDisplay(DATA_START)} and ${toDisplay(DATA_END)}.`)
      return
    }
    onChange({ start, end })
    setOpen(false)
  }

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
              Custom Range (YYYY/MM/DD)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY/MM/DD"
                maxLength={10}
                value={startText}
                onChange={(e) => setStartText(e.target.value)}
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
                type="text"
                inputMode="numeric"
                placeholder="YYYY/MM/DD"
                maxLength={10}
                value={endText}
                onChange={(e) => setEndText(e.target.value)}
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
            {error && <div style={{ fontSize: 11, color: C.red500, marginBottom: 8 }}>{error}</div>}
            <button
              onClick={applyCustomRange}
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
