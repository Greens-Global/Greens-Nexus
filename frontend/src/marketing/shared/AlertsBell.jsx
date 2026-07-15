import { useEffect, useRef, useState } from 'react'
import { Bell, ArrowRight, X } from 'lucide-react'
import { C, FONT } from '../theme'

const DOT_COLOR = {
  critical: C.red500,
  warning: C.amber500,
  info: C.blue500,
}
const BADGE_COLOR = {
  critical: { color: C.red600, background: C.red50 },
  warning: { color: C.amber600, background: C.amber50 },
  info: { color: C.blue600, background: C.blue50 },
}

export default function AlertsBell({ alerts, onNavigate, onClearAlert }) {
  const [open, setOpen] = useState(false)
  const [hoveredId, setHoveredId] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const activeCount = alerts.filter((a) => a.severity !== 'info').length

  return (
    <div style={{ position: 'relative', fontFamily: FONT }} ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
        onMouseLeave={(e) => (e.currentTarget.style.background = C.white)}
        style={{
          position: 'relative',
          width: 32,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 8,
          border: '1px solid ' + C.gray200,
          background: C.white,
          color: C.gray500,
          cursor: 'pointer',
        }}
      >
        <Bell size={15} />
        {activeCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              background: C.red500,
              color: C.white,
              fontSize: 10,
              lineHeight: 1,
              borderRadius: 9999,
              width: 16,
              height: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 500,
            }}
          >
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            marginTop: 8,
            width: 320,
            borderRadius: 12,
            border: '1px solid ' + C.gray200,
            background: C.white,
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
            zIndex: 30,
            padding: 8,
          }}
        >
          <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: C.gray900 }}>Alerts</span>
            {alerts.length > 0 && (
              <button
                onClick={() => alerts.forEach((a) => onClearAlert(a.id))}
                onMouseEnter={(e) => (e.currentTarget.style.color = C.gray700)}
                onMouseLeave={(e) => (e.currentTarget.style.color = C.gray400)}
                style={{
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: C.gray400,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Clear all
              </button>
            )}
          </div>
          {alerts.length === 0 ? (
            <div style={{ padding: '16px 8px', textAlign: 'center', fontSize: 12.5, color: C.gray400 }}>
              You're all caught up.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
              {alerts.map((a) => {
                const isHovered = hoveredId === a.id
                return (
                  <div
                    key={a.id}
                    onMouseEnter={() => setHoveredId(a.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      borderRadius: 8,
                      background: isHovered ? C.gray50 : 'transparent',
                    }}
                  >
                    <button
                      onClick={() => {
                        onNavigate(a.tab)
                        setOpen(false)
                      }}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'left',
                        padding: '8px 32px 8px 8px',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          marginTop: 6,
                          width: 6,
                          height: 6,
                          borderRadius: 9999,
                          flexShrink: 0,
                          background: DOT_COLOR[a.severity],
                        }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 500, color: C.gray900 }}>{a.title}</span>
                          <span
                            style={{
                              fontSize: 10,
                              padding: '2px 6px',
                              borderRadius: 9999,
                              fontWeight: 500,
                              ...BADGE_COLOR[a.severity],
                            }}
                          >
                            {a.severity}
                          </span>
                        </span>
                        <span style={{ display: 'block', fontSize: 12, color: C.gray500, marginTop: 2 }}>{a.message}</span>
                      </span>
                      <ArrowRight
                        size={12}
                        color={C.gray300}
                        style={{ flexShrink: 0, marginTop: 6, opacity: isHovered ? 0 : 1 }}
                      />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onClearAlert(a.id)
                      }}
                      title="Clear this alert"
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = C.gray700
                        e.currentTarget.style.background = C.gray100
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = C.gray400
                        e.currentTarget.style.background = 'transparent'
                      }}
                      style={{
                        position: 'absolute',
                        top: 6,
                        right: 6,
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: C.gray400,
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        opacity: isHovered ? 1 : 0,
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
