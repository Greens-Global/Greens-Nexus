import { Download, Wallet, AlertTriangle } from 'lucide-react'
import DateRangePicker from './DateRangePicker'
import PropertyFilter from '../shared/PropertyFilter'
import MarketingTabBar from '../shared/MarketingTabBar'
import ScopeBadge from '../shared/ScopeBadge'
import { ALL_PROPERTIES } from '../shared/facilities'
import { formatCurrency } from './utils'
import { C } from '../theme'

const PLATFORMS = [
  { key: 'google', label: 'Google Ads' },
  { key: 'yelp', label: 'Yelp Ads' },
]

export default function GoogleAdsHeader({
  range,
  onRangeChange,
  property,
  properties,
  onPropertyChange,
  platform,
  onPlatformChange,
  onDownload,
  onCompare,
  onNavigate,
  alerts,
  insights,
  onClearAlert,
  monthlyBudget = 0,
  monthSpend = 0,
}) {
  const platformLabel = platform === 'google' ? 'Google Ads' : 'Yelp Ads'

  const pct = monthlyBudget > 0 ? (monthSpend / monthlyBudget) * 100 : 0
  const isOver = monthlyBudget > 0 && pct >= 100
  const isWarning = monthlyBudget > 0 && pct >= 90 && pct < 100

  // Tailwind red-200 (#fecaca) isn't in the theme palette, so it's inlined here.
  const pillColors = isOver
    ? { color: C.red700, background: C.red50, borderColor: '#fecaca' }
    : isWarning
    ? { color: C.amber700, background: C.amber50, borderColor: C.amber200 }
    : { color: C.blue700, background: C.blue50, borderColor: C.blue200 }

  return (
    <div style={{ marginBottom: 20 }}>
      <MarketingTabBar active="google-ads" onNavigate={onNavigate} alerts={alerts} insights={insights} onClearAlert={onClearAlert} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 16, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 576 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, border: '1px solid ' + C.gray200, padding: 4, width: 'fit-content' }}>
            {PLATFORMS.map((p) => {
              const active = platform === p.key
              return (
                <button
                  key={p.key}
                  onClick={() => onPlatformChange(p.key)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 6,
                    fontSize: 12.5,
                    fontWeight: 500,
                    transition: 'all .15s',
                    background: active ? C.gray900 : 'transparent',
                    color: active ? C.white : C.gray500,
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = C.gray50 }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <ScopeBadge label={property === ALL_PROPERTIES ? 'All Properties' : property} />
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 9999,
                border: '1px solid ' + pillColors.borderColor,
                fontSize: 12,
                fontWeight: 500,
                transition: 'all .15s',
                color: pillColors.color,
                background: pillColors.background,
                ...(isOver ? { animation: 'mktgBudgetPulse 2s cubic-bezier(0.4,0,0.6,1) infinite' } : {}),
              }}
            >
              {isOver ? <AlertTriangle size={12} /> : <Wallet size={12} />}
              Monthly Budget: {formatCurrency(monthlyBudget)}
            </span>
            {isOver && <style>{'@keyframes mktgBudgetPulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }'}</style>}
          </div>
          <p style={{ fontSize: 13, color: C.gray500 }}>
            Track, optimize, and analyze your {platformLabel} performance across all storage facilities.
          </p>
          {(isOver || isWarning) && (
            <p style={{ fontSize: 12.5, fontWeight: 500, color: isOver ? C.red600 : C.amber600 }}>
              {isOver
                ? `Monthly budget used up — ${formatCurrency(monthSpend)} of ${formatCurrency(monthlyBudget)} spent (${pct.toFixed(0)}%).`
                : `Nearing monthly budget — ${formatCurrency(monthSpend)} of ${formatCurrency(monthlyBudget)} used (${pct.toFixed(0)}%).`}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button
            onClick={onDownload}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, fontWeight: 500, color: C.gray600, background: C.white }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
            onMouseLeave={(e) => (e.currentTarget.style.background = C.white)}
          >
            <Download size={13} />
            Download Report
          </button>
          <DateRangePicker range={range} onChange={onRangeChange} />
          <PropertyFilter value={property} options={properties} onChange={onPropertyChange} onCompare={onCompare} />
        </div>
      </div>
    </div>
  )
}
