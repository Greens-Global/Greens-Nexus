import { useEffect, useRef, useState } from 'react'
import { ChevronDown, GitCompare, ArrowLeft } from 'lucide-react'
import { C, FONT } from '../theme'

export default function PropertyFilter({ value, options, onChange, allLabel = 'All Properties', onCompare, compareLabel = 'Compare Properties' }) {
  const [open, setOpen] = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [checked, setChecked] = useState(new Set())
  const ref = useRef(null)

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
        setCompareMode(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  function toggleChecked(o) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(o)) next.delete(o)
      else next.add(o)
      return next
    })
  }

  function submitCompare() {
    if (!onCompare || checked.size < 2) return
    onCompare(Array.from(checked))
    setOpen(false)
    setCompareMode(false)
  }

  function optionButtonStyle(selected) {
    return {
      width: '100%',
      textAlign: 'left',
      padding: '6px 10px',
      borderRadius: 6,
      fontSize: 13,
      background: selected ? C.gray100 : 'transparent',
      fontWeight: selected ? 500 : 400,
      color: selected ? C.gray900 : C.gray600,
      border: 'none',
      cursor: 'pointer',
    }
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
        {value}
        <ChevronDown size={14} color={C.gray400} />
      </button>

      {open && !compareMode && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            marginTop: 8,
            width: 192,
            borderRadius: 12,
            border: '1px solid ' + C.gray200,
            background: C.white,
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
            zIndex: 20,
            padding: 6,
          }}
        >
          <button
            onClick={() => {
              onChange(allLabel)
              setOpen(false)
            }}
            onMouseEnter={(e) => {
              if (value !== allLabel) e.currentTarget.style.background = C.gray50
            }}
            onMouseLeave={(e) => {
              if (value !== allLabel) e.currentTarget.style.background = 'transparent'
            }}
            style={optionButtonStyle(value === allLabel)}
          >
            {allLabel}
          </button>
          {options.map((o) => (
            <button
              key={o}
              onClick={() => {
                onChange(o)
                setOpen(false)
              }}
              onMouseEnter={(e) => {
                if (value !== o) e.currentTarget.style.background = C.gray50
              }}
              onMouseLeave={(e) => {
                if (value !== o) e.currentTarget.style.background = 'transparent'
              }}
              style={optionButtonStyle(value === o)}
            >
              {o}
            </button>
          ))}
          {onCompare && (
            <>
              <div style={{ margin: '4px 0', borderTop: '1px solid ' + C.gray100 }} />
              <button
                onClick={() => {
                  setChecked(new Set(options))
                  setCompareMode(true)
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.emerald50)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'left',
                  padding: '6px 10px',
                  borderRadius: 6,
                  fontSize: 13,
                  color: C.emerald600,
                  fontWeight: 500,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <GitCompare size={13} />
                {compareLabel}
              </button>
            </>
          )}
        </div>
      )}

      {open && compareMode && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            marginTop: 8,
            width: 224,
            borderRadius: 12,
            border: '1px solid ' + C.gray200,
            background: C.white,
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
            zIndex: 20,
            padding: 6,
          }}
        >
          <button
            onClick={() => setCompareMode(false)}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 8px',
              borderRadius: 6,
              fontSize: 11.5,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.025em',
              color: C.gray400,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <ArrowLeft size={12} />
            Select properties
          </button>
          <div style={{ maxHeight: 224, overflowY: 'auto' }}>
            {options.map((o) => (
              <label
                key={o}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 6,
                  fontSize: 13,
                  color: C.gray700,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked.has(o)}
                  onChange={() => toggleChecked(o)}
                  style={{ borderRadius: 4, accentColor: C.emerald600 }}
                />
                {o}
              </label>
            ))}
          </div>
          <div style={{ marginTop: 4, paddingTop: 6, borderTop: '1px solid ' + C.gray100 }}>
            <button
              onClick={submitCompare}
              disabled={checked.size < 2}
              onMouseEnter={(e) => {
                if (checked.size >= 2) e.currentTarget.style.background = C.emerald700
              }}
              onMouseLeave={(e) => {
                if (checked.size >= 2) e.currentTarget.style.background = C.emerald600
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '6px 10px',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                background: C.emerald600,
                color: C.white,
                border: 'none',
                opacity: checked.size < 2 ? 0.4 : 1,
                cursor: checked.size < 2 ? 'not-allowed' : 'pointer',
              }}
            >
              <GitCompare size={13} />
              Compare ({checked.size})
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
