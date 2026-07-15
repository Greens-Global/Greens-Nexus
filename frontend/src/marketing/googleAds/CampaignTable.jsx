import { useMemo, useState } from 'react'
import { ArrowUpDown, Search } from 'lucide-react'
import { formatCurrency, formatNumber, formatPercent } from './utils'
import { useSortable } from './useSortable'
import { C } from '../theme'

function ctr(c) {
  return c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0
}
function costPerConv(c) {
  return c.conversions > 0 ? c.spend / c.conversions : 0
}

function getValue(c, key) {
  switch (key) {
    case 'name':
      return c.name
    case 'spend':
      return c.spend
    case 'clicks':
      return c.clicks
    case 'conversions':
      return c.conversions
    case 'ctr':
      return ctr(c)
    case 'costPerConv':
      return costPerConv(c)
    case 'status':
      return c.status
  }
}

const baseColumns = [
  { key: 'name', label: 'Campaign' },
  { key: 'spend', label: 'Spend' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'ctr', label: 'CTR' },
  { key: 'costPerConv', label: 'Cost/Conv' },
]
const statusColumn = { key: 'status', label: 'Status' }

const statusStyles = {
  Active: { background: C.gray900, color: C.white },
  Paused: { background: C.gray100, color: C.gray500 },
  Completed: { background: C.blue50, color: C.blue600 },
}

const td = { padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }

export default function CampaignTable({ campaigns, onToggleStatus, searchable, showStatus = true }) {
  const [query, setQuery] = useState('')
  const { sorted, sortKey, sortDir, toggleSort } = useSortable(campaigns, getValue, 'spend')
  const columns = useMemo(() => (showStatus ? [...baseColumns, statusColumn] : baseColumns), [showStatus])

  const filtered = searchable && query.trim()
    ? sorted.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    : sorted

  return (
    <div>
      {searchable && (
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} color={C.gray400} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search campaigns..."
            style={{ width: '100%', padding: '8px 12px 8px 36px', borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, outline: 'none' }}
          />
        </div>
      )}
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
            {filtered.map((c) => (
              <tr
                key={c.id}
                style={{ borderBottom: '1px solid ' + C.gray50 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(249,250,251,0.6)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ ...td, paddingLeft: 0, fontWeight: 500, color: C.gray900 }}>{c.name}</td>
                <td style={td}>{formatCurrency(c.spend)}</td>
                <td style={td}>{formatNumber(c.clicks)}</td>
                <td style={{ ...td, color: C.emerald600, fontWeight: 500 }}>{c.conversions}</td>
                <td style={td}>{formatPercent(ctr(c))}</td>
                <td style={td}>{formatCurrency(costPerConv(c))}</td>
                {showStatus && (
                  <td style={{ padding: '10px', whiteSpace: 'nowrap' }}>
                    <button
                      disabled={c.status === 'Completed'}
                      onClick={() => onToggleStatus(c.id)}
                      style={{
                        display: 'inline-block',
                        padding: '4px 10px',
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 500,
                        ...statusStyles[c.status],
                        cursor: c.status === 'Completed' ? 'default' : 'pointer',
                      }}
                      onMouseEnter={(e) => { if (c.status !== 'Completed') e.currentTarget.style.opacity = 0.8 }}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = 1)}
                      title={c.status === 'Completed' ? 'Completed campaigns cannot be reactivated' : 'Click to toggle Active/Paused'}
                    >
                      {c.status}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: 'center', color: C.gray400, padding: '24px 0' }}>
                  No campaigns match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
