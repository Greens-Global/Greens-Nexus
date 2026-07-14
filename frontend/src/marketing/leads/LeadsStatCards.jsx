import { Users, Activity, Trophy, UserX } from 'lucide-react'
import { formatNumber, formatPercent } from '../shared/utils'
import { C } from '../theme'

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function Card({ icon: Icon, color, label, value, caption }) {
  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', minWidth: 0 }}>
      <div style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8, ...color }}>
        <Icon size={14} />
      </div>
      <div style={{ fontSize: 12, color: C.gray500, marginBottom: 4, lineHeight: 1.25 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, marginBottom: 4, ...ellipsis }}>{value}</div>
      <div style={{ fontSize: 11, color: C.gray400, ...ellipsis }}>{caption}</div>
    </div>
  )
}

export default function LeadsStatCards({ stats }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
      <Card icon={Users} color={{ color: C.blue600, background: C.blue50 }} label="Total Leads" value={formatNumber(stats.total)} caption={`${stats.active} active in pipeline`} />
      <Card
        icon={Trophy}
        color={{ color: C.emerald600, background: C.emerald50 }}
        label="Conversion Rate"
        value={formatPercent(stats.conversionRate, 1)}
        caption={`${stats.moveIns} move-ins · ${stats.lost} lost`}
      />
      <Card icon={Activity} color={{ color: C.purple600, background: C.purple50 }} label="Move-Ins" value={formatNumber(stats.moveIns)} caption="Closed-won leads" />
      <Card
        icon={UserX}
        color={{ color: C.amber600, background: C.amber50 }}
        label="Unassigned Leads"
        value={formatNumber(stats.unassigned)}
        caption="Need an owner assigned"
      />
    </div>
  )
}
