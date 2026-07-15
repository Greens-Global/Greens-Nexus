import { Download } from 'lucide-react'
import DateRangePicker from '../shared/DateRangePicker'
import PropertyFilter from '../shared/PropertyFilter'
import MarketingTabBar from '../shared/MarketingTabBar'
import ScopeBadge from '../shared/ScopeBadge'
import { ALL_PROPERTIES } from '../shared/facilities'
import { C } from '../theme'

export default function BusinessProfileHeader({
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
      <MarketingTabBar active="listings" onNavigate={onNavigate} alerts={alerts} insights={insights} onClearAlert={onClearAlert} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 16, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 576 }}>
          <ScopeBadge label={property === ALL_PROPERTIES ? 'All Properties' : property} />
          <p style={{ fontSize: 13, color: C.gray500 }}>
            Track profile views, clicks, and calls, and manage posts, photos, and Q&A on your Google and Yelp listings.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button
            onClick={onDownload}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid ' + C.gray200,
              fontSize: 13,
              fontWeight: 500,
              color: C.gray600,
              background: C.white,
              cursor: 'pointer',
            }}
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
