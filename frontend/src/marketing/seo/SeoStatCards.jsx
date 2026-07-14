import { Target, TrendingUp, Trophy, Search } from 'lucide-react'
import { formatNumber } from '../shared/utils'
import { C } from '../theme'

const truncate = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function Card({ icon: Icon, color, label, value, caption }) {
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
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
          color: color.color,
          background: color.background,
        }}
      >
        <Icon size={14} />
      </div>
      <div style={{ fontSize: 12, color: C.gray500, marginBottom: 4, lineHeight: 1.25 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, marginBottom: 4, ...truncate }}>{value}</div>
      <div style={{ fontSize: 11, color: C.gray400, ...truncate }}>{caption}</div>
    </div>
  )
}

export default function SeoStatCards({ stats, totalKeywordUniverse }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
      <Card
        icon={Target}
        color={{ color: C.blue600, background: C.blue50 }}
        label="Tracked Keywords"
        value={String(stats.count)}
        caption={`${totalKeywordUniverse} in keyword universe`}
      />
      <Card
        icon={TrendingUp}
        color={{ color: C.emerald600, background: C.emerald50 }}
        label="Avg. Position"
        value={stats.count > 0 ? `#${stats.avgPosition.toFixed(1)}` : '—'}
        caption={`${stats.improved} improved · ${stats.declined} declined`}
      />
      <Card
        icon={Trophy}
        color={{ color: C.amber600, background: C.amber50 }}
        label="Keywords in Top 10"
        value={String(stats.top10)}
        caption={`${stats.top3} in top 3`}
      />
      <Card
        icon={Search}
        color={{ color: C.purple600, background: C.purple50 }}
        label="Keyword Universe"
        value={formatNumber(totalKeywordUniverse)}
        caption="Tracked search terms in database"
      />
    </div>
  )
}
