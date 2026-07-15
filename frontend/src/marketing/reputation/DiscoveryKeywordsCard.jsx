import { formatNumber } from '../shared/utils'
import { C } from '../theme'

export default function DiscoveryKeywordsCard({ keywords, split }) {
  const discoveryPct = split.total > 0 ? (split.discovery / split.total) * 100 : 0
  const directPct = split.total > 0 ? (split.direct / split.total) * 100 : 0
  const maxImpressions = Math.max(...keywords.map((k) => k.impressions), 1)

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 4 }}>How Customers Find You</h3>
      <p style={{ fontSize: 11.5, color: C.gray400, marginBottom: 12 }}>Search queries that led to a Business Profile view.</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 11.5 }}>
        <div style={{ flex: 1, height: 8, borderRadius: 9999, background: C.gray100, overflow: 'hidden', display: 'flex' }}>
          <div style={{ height: '100%', background: C.blue500, width: `${discoveryPct}%` }} />
          <div style={{ height: '100%', background: C.emerald500, width: `${directPct}%` }} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, fontSize: 11.5, color: C.gray500 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 9999, background: C.blue500 }} />
          Discovery {discoveryPct.toFixed(0)}%
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 9999, background: C.emerald500 }} />
          Direct {directPct.toFixed(0)}%
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {keywords.map((k) => (
          <div key={k.keyword}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
              <span style={{ color: C.gray700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.keyword}</span>
              <span style={{ color: C.gray500, flexShrink: 0, marginLeft: 8 }}>{formatNumber(k.impressions)}</span>
            </div>
            <div style={{ height: 6, borderRadius: 9999, background: C.gray100, overflow: 'hidden' }}>
              <div
                style={{ height: '100%', borderRadius: 9999, background: k.type === 'Direct' ? C.emerald500 : C.blue500, width: `${(k.impressions / maxImpressions) * 100}%` }}
              />
            </div>
          </div>
        ))}
        {keywords.length === 0 && <div style={{ textAlign: 'center', color: C.gray400, padding: '24px 0', fontSize: 12.5 }}>No search data yet.</div>}
      </div>
    </div>
  )
}
