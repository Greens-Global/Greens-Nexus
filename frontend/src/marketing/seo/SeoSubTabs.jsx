import { LayoutGrid, ListOrdered, MapPin, Grid3x3, Gauge, Swords } from 'lucide-react'
import { C } from '../theme'

const TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'rankings', label: 'Keyword Rankings', icon: ListOrdered },
  { key: 'local', label: 'Local Search', icon: MapPin },
  { key: 'heatmap', label: 'Heatmap', icon: Grid3x3 },
  { key: 'performance', label: 'Website Performance', icon: Gauge },
  { key: 'competitors', label: 'Competitors', icon: Swords },
]

export default function SeoSubTabs({ active, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, borderBottom: `1px solid ${C.gray200}`, marginBottom: 16, overflowX: 'auto' }}>
      {TABS.map((t) => {
        const Icon = t.icon
        const isActive = active === t.key
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 0 10px',
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${isActive ? C.emerald600 : 'transparent'}`,
              marginBottom: -1,
              transition: 'color .15s, border-color .15s',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              color: isActive ? C.gray900 : C.gray400,
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.color = C.gray600
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.color = C.gray400
            }}
          >
            <Icon size={13} />
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
