import { Download } from 'lucide-react'
import MarketingTabBar from '../shared/MarketingTabBar'
import ScopeBadge from '../shared/ScopeBadge'
import PropertyFilter from '../shared/PropertyFilter'
import { REGIONS, ALL_REGIONS } from '../shared/facilities'
import { C } from '../theme'

export default function SeoHeader({ region, onRegionChange, onDownload, onNavigate, alerts, insights, onClearAlert }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <MarketingTabBar active="seo" onNavigate={onNavigate} alerts={alerts} insights={insights} onClearAlert={onClearAlert} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 16, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 576 }}>
          <ScopeBadge label={region === ALL_REGIONS ? 'All Regions' : region} />
          <p style={{ fontSize: 13, color: C.gray500 }}>
            Research keywords, track rankings, and spot organic search opportunities across all storage facilities.
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
              border: `1px solid ${C.gray200}`,
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
          <PropertyFilter value={region} options={REGIONS.map((r) => r.name)} onChange={onRegionChange} allLabel={ALL_REGIONS} />
        </div>
      </div>
    </div>
  )
}
