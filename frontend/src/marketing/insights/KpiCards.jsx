import { UserPlus, Globe, TrendingUp, Wallet, Search, Star, Gauge, ArrowUp, ArrowDown } from 'lucide-react'
import { formatCurrency, formatNumber, formatPercent, formatRangeLabelMonthYear, pctChange } from '../shared/utils'
import StarRating from '../shared/StarRating'
import { C, card, shadowMd } from '../theme'

export const KPI_CARD_DEFS = [
  { key: 'totalLeads', label: 'Total Leads', icon: UserPlus, color: { color: C.blue500, background: C.blue50 }, format: formatNumber },
  { key: 'sessions', label: 'Website Sessions', icon: Globe, color: { color: C.purple500, background: C.purple50 }, format: formatNumber },
  { key: 'leadToMoveInRate', label: 'Lead to Move-In Rate', icon: TrendingUp, color: { color: C.blue500, background: C.blue50 }, format: (n) => formatPercent(n) },
  { key: 'costPerLead', label: 'Cost per Lead', icon: Wallet, color: { color: C.orange500, background: C.orange50 }, format: formatCurrency, lowerIsBetter: true },
  { key: 'organicTraffic', label: 'Organic Traffic', icon: Search, color: { color: C.emerald500, background: C.emerald50 }, format: formatNumber },
  { key: 'reviewRating', label: 'Review Rating (Avg.)', icon: Star, color: { color: C.amber500, background: C.amber50 }, format: (n) => n.toFixed(1) },
  { key: 'nps', label: 'Net Promoter Score', icon: Gauge, color: { color: C.teal500, background: C.teal50 }, format: (n) => Math.round(n).toString() },
]

export default function KpiCards({ current, previous, previousRange, onSelectMetric }) {
  const prevLabel = `vs ${formatRangeLabelMonthYear(previousRange)}`

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 12, marginBottom: 20 }}>
      {KPI_CARD_DEFS.map((c) => {
        const Icon = c.icon
        const change = c.key === 'nps' ? current[c.key] - previous[c.key] : pctChange(current[c.key], previous[c.key])
        const isUp = change >= 0
        const isGood = c.lowerIsBetter ? change <= 0 : change >= 0
        const deltaText = c.key === 'nps' ? `${Math.abs(change).toFixed(0)}` : `${Math.abs(change).toFixed(1)}%`
        return (
          <button
            key={c.key}
            onClick={() => onSelectMetric(c.key, c.label, c.format)}
            style={{ textAlign: 'left', ...card, padding: 16, minWidth: 0, overflow: 'hidden', transition: 'all .15s', cursor: 'pointer' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = C.gray300
              e.currentTarget.style.boxShadow = shadowMd
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = C.gray200
              e.currentTarget.style.boxShadow = card.boxShadow
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', ...c.color }}>
                <Icon size={14} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, fontWeight: 600, color: isGood ? C.emerald600 : C.red500 }}>
                  {isUp ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                  {deltaText}
                </span>
                <span style={{ fontSize: 10, color: C.gray400, whiteSpace: 'nowrap' }}>{prevLabel}</span>
              </div>
            </div>
            <div style={{ fontSize: 12, color: C.gray500, marginBottom: 4, lineHeight: 1.25 }}>{c.label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.format(current[c.key])}</span>
              {c.key === 'reviewRating' && <StarRating value={current[c.key]} size={11} />}
            </div>
          </button>
        )
      })}
    </div>
  )
}
