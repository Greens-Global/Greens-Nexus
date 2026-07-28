import { MapPin, Trophy, TrendingUp, Search, ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { computeLocalSearchStats } from './aggregate'
import { formatNumber } from '../shared/utils'
import { C, alpha } from '../theme'

const truncate = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

function StatCard({ icon: Icon, color, label, value, caption }) {
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

export default function LocalSearchCard({ rows }) {
  const stats = computeLocalSearchStats(rows)

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
        <StatCard
          icon={MapPin}
          color={{ color: C.emerald600, background: C.emerald50 }}
          label="Queries in Map Pack"
          value={`${stats.inMapPack} / ${stats.totalQueries}`}
          caption="Appearing in the local 3-pack"
        />
        <StatCard
          icon={Trophy}
          color={{ color: C.amber600, background: C.amber50 }}
          label="Avg. Map Pack Position"
          value={stats.inMapPack > 0 ? `#${stats.avgMapPackPosition.toFixed(1)}` : '-'}
          caption="Among queries in the pack"
        />
        <StatCard
          icon={TrendingUp}
          color={{ color: C.blue600, background: C.blue50 }}
          label="Avg. Organic Position"
          value={stats.totalQueries > 0 ? `#${stats.avgOrganicPosition.toFixed(1)}` : '-'}
          caption="Across all local queries"
        />
        <StatCard
          icon={Search}
          color={{ color: C.purple600, background: C.purple50 }}
          label="Local Search Volume"
          value={formatNumber(stats.totalVolume)}
          caption="Combined monthly searches"
        />
      </div>

      <div style={{ borderRadius: 12, border: `1px solid ${C.gray200}`, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Local Pack Rankings</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.gray100}`, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: 0 }}>Facility</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Local Query</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Map Pack</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Organic Position</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Volume</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingRight: 0 }}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr
                  key={`${r.facility}-${r.keyword}`}
                  style={{ borderBottom: ri === rows.length - 1 ? 'none' : `1px solid ${C.gray50}` }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.gray50, 0.6))}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '10px', paddingLeft: 0, fontWeight: 500, color: C.gray900, whiteSpace: 'nowrap' }}>{r.facility}</td>
                  <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{r.keyword}</td>
                  <td style={{ padding: '10px', whiteSpace: 'nowrap' }}>
                    {r.mapPackPosition != null ? (
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 500, color: C.emerald700, background: C.emerald50 }}>
                        #{r.mapPackPosition} in pack
                      </span>
                    ) : (
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 500, color: C.gray500, background: C.gray100 }}>Not in pack</span>
                    )}
                  </td>
                  <td style={{ padding: '10px', fontWeight: 600, color: C.gray900, whiteSpace: 'nowrap' }}>#{r.organicPosition}</td>
                  <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{formatNumber(r.volume)}</td>
                  <td style={{ padding: '10px', paddingRight: 0, whiteSpace: 'nowrap' }}>
                    {r.delta > 0 ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: C.emerald600, fontWeight: 500 }}>
                        <ArrowUp size={12} />
                        {r.delta}
                      </span>
                    ) : r.delta < 0 ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: C.red500, fontWeight: 500 }}>
                        <ArrowDown size={12} />
                        {Math.abs(r.delta)}
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: C.gray400 }}>
                        <Minus size={12} />
                        0
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: C.gray400, padding: '24px 0' }}>
                    No local queries for this region.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: C.gray400, marginTop: 8 }}>
          "Map Pack" is Google's local 3-pack, shown above organic results for "near me" style searches.
        </p>
      </div>
    </div>
  )
}
