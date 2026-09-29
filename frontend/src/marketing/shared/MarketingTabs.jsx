import { useState } from 'react'
import { Megaphone, Star, Lightbulb, Search, Building2, KanbanSquare } from 'lucide-react'
import { C, FONT } from '../theme'

const OPERATIONAL_TABS = [
  { key: 'google-ads', label: 'Ad Performance', icon: Megaphone },
  { key: 'reputation', label: 'Reputation Management', icon: Star },
  { key: 'insights', label: 'Insights', icon: Lightbulb },
  { key: 'seo', label: 'SEO Research', icon: Search },
  { key: 'listings', label: 'Business Profile', icon: Building2 },
  { key: 'leads', label: 'Leads', icon: KanbanSquare },
]

export default function MarketingTabs({ active, onChange }) {
  const [hovered, setHovered] = useState(null)
  // The baseline is an inset shadow, not a border the tabs overlap with a -1px
  // margin: the strip scrolls now, and that overlap would scroll it vertically.
  return (
    <div className="scroll-tabs mktg-tabbar-tabs" style={{ display: 'flex', alignItems: 'center', gap: 24, boxShadow: 'inset 0 -1px 0 ' + C.gray200 }}>
      {OPERATIONAL_TABS.map((t) => {
        const Icon = t.icon
        const isActive = active === t.key
        // gray500, not gray400: inactive labels measured 2.3:1 on white (QA, Sep 23).
        const color = isActive ? C.gray900 : hovered === t.key ? C.gray700 : C.gray500
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            onMouseEnter={() => setHovered(t.key)}
            onMouseLeave={() => setHovered(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingBottom: 12,
              paddingTop: 4,
              fontSize: 14,
              fontWeight: 500,
              fontFamily: FONT,
              background: 'none',
              border: 'none',
              borderBottom: '2px solid ' + (isActive ? C.gray900 : 'transparent'),
              transition: 'all .15s',
              whiteSpace: 'nowrap',
              color,
              cursor: 'pointer',
            }}
          >
            <Icon size={15} />
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
