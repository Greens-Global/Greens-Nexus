import { ChevronRight } from 'lucide-react'
import { C, card } from '../theme'

export default function InsightListCard({ title, items }) {
  return (
    <div style={{ ...card, padding: 16, height: '100%' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>{title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {items.map((item, i) => {
          const Icon = item.icon
          const clickable = !!item.onClick
          const Wrapper = clickable ? 'button' : 'div'
          return (
            <Wrapper
              key={i}
              onClick={item.onClick}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                textAlign: 'left',
                borderRadius: 8,
                margin: '0 -4px',
                padding: '4px 4px',
                width: '100%',
                background: 'transparent',
                border: 'none',
                cursor: clickable ? 'pointer' : 'default',
              }}
              onMouseEnter={clickable ? (e) => (e.currentTarget.style.background = C.gray50) : undefined}
              onMouseLeave={clickable ? (e) => (e.currentTarget.style.background = 'transparent') : undefined}
            >
              <div
                className={item.color}
                style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}
              >
                <Icon size={14} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: C.gray900 }}>{item.title}</div>
                <p style={{ fontSize: 12, color: C.gray500, lineHeight: 1.375 }}>{item.description}</p>
              </div>
              {clickable && (
                <ChevronRight size={14} style={{ color: C.gray300, flexShrink: 0, marginTop: 4 }} />
              )}
            </Wrapper>
          )
        })}
      </div>
    </div>
  )
}
