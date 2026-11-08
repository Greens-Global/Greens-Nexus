import { useState } from 'react'
import { Megaphone, Star, Lightbulb, Search, Building2, KanbanSquare } from 'lucide-react'
import { C, FONT } from '../theme'
import ModuleTabs from '../../components/ModuleTabs'
import { useIsMobile } from '../../lib/useIsMobile'
import { PHONE_QUERY } from '../../lib/keys'

const OPERATIONAL_TABS = [
  { key: 'google-ads', label: 'Ad Performance', icon: Megaphone },
  { key: 'reputation', label: 'Reputation Management', icon: Star },
  { key: 'insights', label: 'Insights', icon: Lightbulb },
  { key: 'seo', label: 'SEO Research', icon: Search },
  { key: 'listings', label: 'Business Profile', icon: Building2 },
  { key: 'leads', label: 'Leads', icon: KanbanSquare },
]

const HEADER_TABS = OPERATIONAL_TABS.map(({ key, label, icon }) => ({ key, label, Icon: icon }))

export default function MarketingTabs({ active, onChange }) {
  const [hovered, setHovered] = useState(null)
  // The pages ride the top header on a computer (Neil, 11/06/2026); the strip
  // below is drawn only where the header has no tabs (900px and under).
  const narrow = useIsMobile(PHONE_QUERY)
  const publish = <ModuleTabs tabs={HEADER_TABS} active={active} onChange={onChange} mobileInline={false} />
  if (!narrow) return <span className="mktg-tabbar-tabs">{publish}</span>
  // The baseline is an inset shadow, not a border the tabs overlap with a -1px
  // margin: the strip scrolls now, and that overlap would scroll it vertically.
  return (
    <div className="scroll-tabs mktg-tabbar-tabs" style={{ display: 'flex', alignItems: 'center', gap: 24, boxShadow: 'inset 0 -1px 0 ' + C.gray200 }}>
      {publish}
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
              transition: 'color .15s, border-color .15s',
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
