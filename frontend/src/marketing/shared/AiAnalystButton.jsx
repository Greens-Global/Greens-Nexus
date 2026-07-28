import { useEffect, useRef, useState } from 'react'
import { Sparkles, ArrowRight } from 'lucide-react'
import { C, FONT } from '../theme'

const SEVERITY_DOT = {
  High: C.red500,
  Medium: C.amber500,
  Low: C.blue500,
}
const CATEGORY_BADGE = {
  Risk: { color: C.red600, background: C.red50 },
  Opportunity: { color: C.emerald600, background: C.emerald50 },
  Efficiency: { color: C.blue600, background: C.blue50 },
  Reputation: { color: C.purple600, background: C.purple50 },
}

const MAX_SHOWN = 5

export default function AiAnalystButton({ insights, onNavigate }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const shown = insights.slice(0, MAX_SHOWN)

  return (
    <div style={{ position: 'relative', fontFamily: FONT }} ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={(e) => (e.currentTarget.style.background = C.purple100)}
        onMouseLeave={(e) => (e.currentTarget.style.background = C.purple50)}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 9999,
          fontSize: 13,
          fontWeight: 500,
          border: '1px solid ' + C.purple200,
          color: C.purple700,
          background: C.purple50,
          transition: 'all .15s',
          cursor: 'pointer',
        }}
      >
        <Sparkles size={13} />
        AI Analyst
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            marginTop: 8,
            width: 384,
            borderRadius: 12,
            border: '1px solid ' + C.gray200,
            background: C.white,
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
            zIndex: 30,
            padding: 8,
          }}
        >
          <div
            style={{
              padding: '6px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
              color: C.gray900,
            }}
          >
            <Sparkles size={12} color={C.purple500} />
            AI Marketing Analyst
          </div>
          {shown.length === 0 ? (
            <div style={{ padding: '16px 8px', textAlign: 'center', fontSize: 12.5, color: C.gray400 }}>
              No notable changes this month - performance is holding steady.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 384, overflowY: 'auto' }}>
              {shown.map((insight) => (
                <button
                  key={insight.id}
                  onClick={() => {
                    if (insight.tab) onNavigate(insight.tab)
                    else onNavigate('insights')
                    setOpen(false)
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  style={{
                    textAlign: 'left',
                    padding: 8,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    width: '100%',
                  }}
                >
                  <span
                    style={{
                      marginTop: 6,
                      width: 6,
                      height: 6,
                      borderRadius: 9999,
                      flexShrink: 0,
                      background: SEVERITY_DOT[insight.severity],
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 500, color: C.gray900 }}>{insight.title}</span>
                      <span
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 9999,
                          fontWeight: 500,
                          ...CATEGORY_BADGE[insight.category],
                        }}
                      >
                        {insight.category}
                      </span>
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: C.gray500, marginTop: 2 }}>
                      {insight.whatHappened}
                    </span>
                  </span>
                  <ArrowRight size={12} color={C.gray300} style={{ flexShrink: 0, marginTop: 6 }} />
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => {
              onNavigate('insights', 'view-ai-analysis')
              setOpen(false)
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.purple50)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            style={{
              width: '100%',
              textAlign: 'center',
              marginTop: 4,
              padding: 8,
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 500,
              color: C.purple600,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            View full analysis in Insights →
          </button>
        </div>
      )}
    </div>
  )
}
