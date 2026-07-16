import { DollarSign, Layers, MousePointerClick, Target, Wallet, Percent, CircleDollarSign, ArrowUp, ArrowDown } from 'lucide-react'
import { formatCurrency, formatNumber, formatPercent, formatRangeLabelUS, pctChange } from './utils'
import { C } from '../theme'

const cards = [
  { key: 'spend', label: 'Total Spend', icon: DollarSign, color: { c: C.blue500, bg: C.blue50 }, format: formatCurrency },
  { key: 'impressions', label: 'Impressions', icon: Layers, color: { c: C.indigo500, bg: '#eef2ff' }, format: formatNumber },
  { key: 'clicks', label: 'Clicks', icon: MousePointerClick, color: { c: C.purple500, bg: C.purple50 }, format: formatNumber },
  { key: 'conversions', label: 'Conversions', icon: Target, color: { c: C.emerald500, bg: C.emerald50 }, format: formatNumber },
  { key: 'costPerConv', label: 'Cost / Conversion', icon: Wallet, color: { c: C.orange500, bg: C.orange50 }, format: formatCurrency, lowerIsBetter: true },
  { key: 'ctr', label: 'CTR', icon: Percent, color: { c: '#06b6d4', bg: '#ecfeff' }, format: (n) => formatPercent(n) },
  { key: 'avgCpc', label: 'Avg. CPC', icon: CircleDollarSign, color: { c: C.pink500, bg: C.pink50 }, format: formatCurrency, lowerIsBetter: true },
]

export default function KpiCards({ current, previous, previousRange, onSelectMetric }) {
  const prevLabel = `vs ${formatRangeLabelUS(previousRange)}`

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 12, marginBottom: 20 }}>
      {cards.map((c) => {
        const Icon = c.icon
        const change = pctChange(current[c.key], previous[c.key])
        const isUp = change >= 0
        const isGood = c.lowerIsBetter ? change <= 0 : change >= 0
        return (
          <button
            key={c.key}
            onClick={() => onSelectMetric(c.key, c.label, c.format)}
            style={{
              textAlign: 'left',
              borderRadius: 12,
              border: '1px solid ' + C.gray200,
              background: C.white,
              padding: 16,
              boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',
              minWidth: 0,
              overflow: 'hidden',
              transition: 'all .15s',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = C.gray300
              e.currentTarget.style.boxShadow = '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = C.gray200
              e.currentTarget.style.boxShadow = '0 1px 2px 0 rgba(0,0,0,0.05)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.color.c, background: c.color.bg }}>
                <Icon size={14} />
              </div>
              <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, fontWeight: 600, color: isGood ? C.emerald600 : C.red500 }}>
                {isUp ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                {Math.abs(change).toFixed(1)}%
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: C.gray500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: C.gray900, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.format(current[c.key])}
            </div>
            <div style={{ fontSize: 10, color: C.gray400, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prevLabel}</div>
          </button>
        )
      })}
    </div>
  )
}
