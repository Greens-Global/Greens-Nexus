import { Search, Grid3x3, ListOrdered } from 'lucide-react'
import { C } from '../theme'

const SECTIONS = [
  { key: 'explorer', label: 'Keyword Explorer', icon: Search },
  { key: 'heatmap', label: 'Volume Heatmap', icon: Grid3x3 },
  { key: 'tracker', label: 'Rank Tracker', icon: ListOrdered },
]

export default function SeoSectionNav({ onJump }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
      {SECTIONS.map((s) => (
        <button
          key={s.key}
          onClick={() => onJump(s.key)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 8,
            border: `1px solid ${C.gray200}`,
            background: C.white,
            fontSize: 12.5,
            fontWeight: 500,
            color: C.gray600,
            boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',
            transition: 'all .15s',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = C.gray300
            e.currentTarget.style.background = C.gray50
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = C.gray200
            e.currentTarget.style.background = C.white
          }}
        >
          <s.icon size={13} style={{ color: C.gray400 }} />
          {s.label}
        </button>
      ))}
    </div>
  )
}
