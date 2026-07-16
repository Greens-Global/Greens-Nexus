import { Gauge, MousePointerClick, LayoutPanelTop, Activity } from 'lucide-react'
import { C } from '../theme'

const truncate = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const RATING_COLOR = {
  Good: { color: C.emerald600, background: C.emerald50 },
  'Needs Improvement': { color: C.amber600, background: C.amber50 },
  Poor: { color: C.red600, background: C.red50 },
}

const VITAL_ICON = {
  lcp: Gauge,
  inp: MousePointerClick,
  cls: LayoutPanelTop,
}

function VitalCard({ vital }) {
  const Icon = VITAL_ICON[vital.key]
  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${C.gray200}`,
        background: C.white,
        padding: 16,
        boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            ...RATING_COLOR[vital.rating],
          }}
        >
          <Icon size={14} />
        </div>
        <span style={{ padding: '2px 8px', borderRadius: 9999, fontSize: 10.5, fontWeight: 500, ...RATING_COLOR[vital.rating] }}>{vital.rating}</span>
      </div>
      <div style={{ fontSize: 12, color: C.gray500, marginBottom: 4, lineHeight: 1.25 }}>{vital.label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, ...truncate }}>
        {vital.value}
        {vital.unit}
      </div>
    </div>
  )
}

export default function WebsitePerformanceStatCards({ vitals, totalOrganicSessions }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
      {vitals.map((v) => (
        <VitalCard key={v.key} vital={v} />
      ))}
      <div
        style={{
          borderRadius: 12,
          border: `1px solid ${C.gray200}`,
          background: C.white,
          padding: 16,
          boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',
          minWidth: 0,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 8,
            color: C.blue600,
            background: C.blue50,
          }}
        >
          <Activity size={14} />
        </div>
        <div style={{ fontSize: 12, color: C.gray500, marginBottom: 4, lineHeight: 1.25 }}>Organic Sessions (YTD)</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, marginBottom: 4, ...truncate }}>{totalOrganicSessions.toLocaleString()}</div>
        <div style={{ fontSize: 11, color: C.gray400, ...truncate }}>Jan – Jun 2025</div>
      </div>
    </div>
  )
}
