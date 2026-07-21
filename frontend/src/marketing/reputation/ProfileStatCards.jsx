import { Eye, Globe, Phone, Navigation, ArrowUp, ArrowDown } from 'lucide-react'
import { formatNumber, pctChange } from '../shared/utils'
import { C } from '../theme'

function Card({
  icon: Icon,
  color,
  label,
  value,
  delta,
  caption,
}) {
  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: color.color, background: color.background }}>
          <Icon size={14} />
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, fontWeight: 600, color: delta >= 0 ? C.emerald600 : C.red500 }}>
          {delta >= 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
          {Math.abs(delta).toFixed(1)}%
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.gray500, marginBottom: 4, lineHeight: 1.25 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      <div style={{ fontSize: 11, color: C.gray400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{caption}</div>
    </div>
  )
}

export default function ProfileStatCards({ current, previous, platform = 'google' }) {
  const primaryLabel = platform === 'google' ? 'Maps' : 'Direct'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
      <Card
        icon={Eye}
        color={{ color: C.blue600, background: C.blue50 }}
        label="Total Profile Views"
        value={formatNumber(current.totalViews)}
        delta={pctChange(current.totalViews, previous.totalViews)}
        caption={`${formatNumber(current.mapsViews)} ${primaryLabel} · ${formatNumber(current.searchViews)} Search`}
      />
      <Card
        icon={Globe}
        color={{ color: C.purple600, background: C.purple50 }}
        label="Website Clicks"
        value={formatNumber(current.websiteClicks)}
        delta={pctChange(current.websiteClicks, previous.websiteClicks)}
        caption="From your Business Profile"
      />
      <Card
        icon={Phone}
        color={{ color: C.emerald600, background: C.emerald50 }}
        label="Calls"
        value={formatNumber(current.callClicks)}
        delta={pctChange(current.callClicks, previous.callClicks)}
        caption="Call button taps"
      />
      <Card
        icon={Navigation}
        color={{ color: C.amber600, background: C.amber50 }}
        label="Direction Requests"
        value={formatNumber(current.directionRequests)}
        delta={pctChange(current.directionRequests, previous.directionRequests)}
        caption="Taps for driving directions"
      />
    </div>
  )
}
