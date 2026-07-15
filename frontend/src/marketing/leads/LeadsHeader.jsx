import { Download, Plus } from 'lucide-react'
import MarketingTabBar from '../shared/MarketingTabBar'
import ScopeBadge from '../shared/ScopeBadge'
import PropertyFilter from '../shared/PropertyFilter'
import { FACILITIES, ALL_PROPERTIES } from '../shared/facilities'
import { SOURCES, ALL_SOURCES } from './data'
import { C } from '../theme'

export default function LeadsHeader({
  property,
  onPropertyChange,
  source,
  onSourceChange,
  onDownload,
  onAddLead,
  onNavigate,
  alerts,
  insights,
  onClearAlert,
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <MarketingTabBar active="leads" onNavigate={onNavigate} alerts={alerts} insights={insights} onClearAlert={onClearAlert} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 16, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 576 }}>
          <ScopeBadge label={property === ALL_PROPERTIES ? 'All Properties' : property} />
          <p style={{ fontSize: 13, color: C.gray500 }}>
            Track every lead from first touch to move-in across all storage facilities.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button
            onClick={onDownload}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.gray50 }}
            onMouseLeave={(e) => { e.currentTarget.style.background = C.white }}
            style={{
              display: 'inline-flex',
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
          >
            <Download size={13} />
            Download Report
          </button>
          <PropertyFilter value={property} options={FACILITIES} onChange={onPropertyChange} allLabel={ALL_PROPERTIES} />
          <PropertyFilter value={source} options={SOURCES} onChange={onSourceChange} allLabel={ALL_SOURCES} />
          <button
            onClick={onAddLead}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.emerald700 }}
            onMouseLeave={(e) => { e.currentTarget.style.background = C.emerald600 }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 12px',
              borderRadius: 8,
              background: C.emerald600,
              color: C.white,
              fontSize: 13,
              fontWeight: 500,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <Plus size={14} />
            Add Lead
          </button>
        </div>
      </div>
    </div>
  )
}
