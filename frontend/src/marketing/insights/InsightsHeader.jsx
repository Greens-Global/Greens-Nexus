import { Download, Sparkles } from 'lucide-react'
import DateRangePicker from '../shared/DateRangePicker'
import PropertyFilter from '../shared/PropertyFilter'
import MarketingTabBar from '../shared/MarketingTabBar'
import ScopeBadge from '../shared/ScopeBadge'
import { ALL_PROPERTIES } from '../shared/facilities'
import { C } from '../theme'

export default function InsightsHeader({
  range,
  onRangeChange,
  property,
  properties,
  onPropertyChange,
  onDownload,
  onCompare,
  onNavigate,
  alerts,
  insights,
  onClearAlert,
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <MarketingTabBar active="insights" onNavigate={onNavigate} alerts={alerts} insights={insights} onClearAlert={onClearAlert} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 16, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 576 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <ScopeBadge label={property === ALL_PROPERTIES ? 'All Properties' : property} />
            <button
              onClick={() => onNavigate('insights', 'view-ai-analysis')}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 9999, border: '1px solid ' + C.purple200, fontSize: 12, fontWeight: 500, color: C.purple700, background: C.purple50, cursor: 'pointer', transition: 'background-color .15s' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = C.purple100)}
              onMouseLeave={(e) => (e.currentTarget.style.background = C.purple50)}
            >
              <Sparkles size={12} />
              AI Marketing Analyst
            </button>
          </div>
          <p style={{ fontSize: 13, color: C.gray500 }}>
            Uncover key insights to drive growth across campaigns, reviews, and customer interactions.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button
            onClick={onDownload}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, fontWeight: 500, color: C.gray600, background: 'transparent', cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = C.gray50)}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
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
