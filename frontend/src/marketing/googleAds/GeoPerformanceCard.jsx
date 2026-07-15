import { ArrowUpDown } from 'lucide-react'
import { formatCurrency, formatNumber, formatPercent } from './utils'
import { useSortable } from './useSortable'
import { C } from '../theme'

function ctr(r) {
  return r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0
}
function costPerConv(r) {
  return r.conversions > 0 ? r.spend / r.conversions : 0
}

function getValue(r, key) {
  switch (key) {
    case 'location':
      return r.location
    case 'impressions':
      return r.impressions
    case 'clicks':
      return r.clicks
    case 'ctr':
      return ctr(r)
    case 'conversions':
      return r.conversions
    case 'costPerConv':
      return costPerConv(r)
  }
}

const columns = [
  { key: 'location', label: 'Location' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'ctr', label: 'CTR' },
  { key: 'conversions', label: 'Conv.' },
  { key: 'costPerConv', label: 'Cost/Conv' },
]

const td = { padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }

export default function GeoPerformanceCard({ rows }) {
  const { sorted, sortKey, sortDir, toggleSort } = useSortable(rows, getValue, 'impressions')

  return (
    <div className="mktg-card" style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Geographic Performance</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid ' + C.gray100, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
              {columns.map((col, i) => (
                <th key={col.key} style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: i === 0 ? 0 : 10, whiteSpace: 'nowrap' }}>
                  <button
                    onClick={() => toggleSort(col.key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, color: sortKey === col.key ? C.gray700 : 'inherit' }}
                  >
                    {col.label}
                    <ArrowUpDown
                      size={10}
                      style={{
                        transition: 'transform .15s',
                        opacity: sortKey === col.key ? 1 : 0.3,
                        transform: sortKey === col.key && sortDir === 'asc' ? 'rotate(180deg)' : 'none',
                      }}
                    />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.location}
                style={{ borderBottom: '1px solid ' + C.gray50 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(249,250,251,0.6)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ ...td, paddingLeft: 0, fontWeight: 500, color: C.gray900 }}>{r.location}</td>
                <td style={td}>{formatNumber(r.impressions)}</td>
                <td style={td}>{formatNumber(r.clicks)}</td>
                <td style={td}>{formatPercent(ctr(r))}</td>
                <td style={{ ...td, color: C.emerald600, fontWeight: 500 }}>{r.conversions}</td>
                <td style={td}>{formatCurrency(costPerConv(r))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
