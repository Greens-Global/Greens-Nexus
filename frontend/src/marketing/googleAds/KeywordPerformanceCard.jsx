import { useState } from 'react'
import { ArrowRight, ArrowUpDown, Search } from 'lucide-react'
import { formatCurrency, formatNumber, formatPercent } from './utils'
import { useSortable } from './useSortable'
import Modal from './Modal'
import { C } from '../theme'

function ctr(r) {
  return r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0
}
function costPerConv(r) {
  return r.conversions > 0 ? r.spend / r.conversions : 0
}

function getValue(r, key) {
  switch (key) {
    case 'keyword':
      return r.keyword
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
  { key: 'keyword', label: 'Keyword' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'ctr', label: 'CTR' },
  { key: 'conversions', label: 'Conv.' },
  { key: 'costPerConv', label: 'Cost/Conv' },
]

const td = { padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }

function KeywordTable({ rows, searchable }) {
  const [query, setQuery] = useState('')
  const { sorted, sortKey, sortDir, toggleSort } = useSortable(rows, getValue, 'clicks')
  const filtered = searchable && query.trim()
    ? sorted.filter((r) => r.keyword.toLowerCase().includes(query.trim().toLowerCase()))
    : sorted

  return (
    <div>
      {searchable && (
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} color={C.gray400} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search keywords..."
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
            {filtered.map((r) => (
              <tr
                key={r.keyword}
                style={{ borderBottom: '1px solid ' + C.gray50 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(249,250,251,0.6)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ ...td, paddingLeft: 0, fontWeight: 500, color: C.gray900 }}>{r.keyword}</td>
                <td style={td}>{formatNumber(r.clicks)}</td>
                <td style={td}>{formatPercent(ctr(r))}</td>
                <td style={{ ...td, color: C.emerald600, fontWeight: 500 }}>{r.conversions}</td>
                <td style={td}>{formatCurrency(costPerConv(r))}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: 'center', color: C.gray400, padding: '24px 0' }}>
                  No keywords match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function KeywordPerformanceCard({ rows }) {
  const [showAll, setShowAll] = useState(false)
  const top5 = [...rows].sort((a, b) => b.clicks - a.clicks).slice(0, 5)

  return (
    <div style={{ borderRadius: 12, border: '1px solid ' + C.gray200, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Keyword Performance (Top 5)</h3>
      <div style={{ flex: 1 }}>
        <KeywordTable rows={top5} />
      </div>
      <button
        onClick={() => setShowAll(true)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 500, color: C.emerald600, marginTop: 12 }}
        onMouseEnter={(e) => (e.currentTarget.style.color = C.emerald700)}
        onMouseLeave={(e) => (e.currentTarget.style.color = C.emerald600)}
      >
        View all keywords
        <ArrowRight size={13} />
      </button>

      {showAll && (
        <Modal title={`All Keywords (${rows.length})`} onClose={() => setShowAll(false)} width="max-w-3xl">
          <KeywordTable rows={rows} searchable />
        </Modal>
      )}
    </div>
  )
}
