import { useState } from 'react'
import { ArrowRight, ArrowUpDown, Search } from 'lucide-react'
import { useSortable } from '../shared/useSortable'
import Modal from '../shared/Modal'
import { formatNumber } from '../shared/utils'
import { C, card, alpha } from '../theme'

function rate(r) {
  return r.leads > 0 ? (r.moveIns / r.leads) * 100 : 0
}

function getValue(r, key) {
  switch (key) {
    case 'name':
      return r.name
    case 'leads':
      return r.leads
    case 'moveIns':
      return r.moveIns
    case 'rate':
      return rate(r)
  }
}

const columns = [
  { key: 'name', label: 'Property' },
  { key: 'leads', label: 'Leads' },
  { key: 'moveIns', label: 'Move-Ins' },
  { key: 'rate', label: 'Conversion Rate' },
]

function PropertyTable({ rows, searchable, onSelectProperty }) {
  const [query, setQuery] = useState('')
  const { sorted, sortKey, sortDir, toggleSort } = useSortable(rows, getValue, 'leads')
  const filtered = searchable && query.trim() ? sorted.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase())) : sorted

  return (
    <div>
      {searchable && (
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.gray400 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search properties..."
            style={{ width: '100%', paddingLeft: 36, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 8, border: '1px solid ' + C.gray200, fontSize: 13, outline: 'none' }}
          />
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid ' + C.gray100, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
              {columns.map((col, ci) => {
                const active = sortKey === col.key
                return (
                  <th key={col.key} style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: ci === 0 ? 0 : 10, whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => toggleSort(col.key)}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', color: active ? C.gray700 : C.gray400 }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = C.gray600)}
                      onMouseLeave={(e) => (e.currentTarget.style.color = active ? C.gray700 : C.gray400)}
                    >
                      {col.label}
                      <ArrowUpDown
                        size={10}
                        style={{ transition: 'transform .15s', opacity: active ? 1 : 0.3, transform: active && sortDir === 'asc' ? 'rotate(180deg)' : 'none' }}
                      />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, ri) => (
              <tr
                key={r.name}
                style={{ borderBottom: ri < filtered.length - 1 ? '1px solid ' + C.gray50 : 'none' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.gray50, 0.6))}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '10px 10px', paddingLeft: 0, fontWeight: 500, whiteSpace: 'nowrap' }}>
                  {onSelectProperty ? (
                    <button
                      onClick={() => onSelectProperty(r.name)}
                      style={{ color: C.gray900, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', fontWeight: 500 }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = C.emerald600
                        e.currentTarget.style.textDecoration = 'underline'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = C.gray900
                        e.currentTarget.style.textDecoration = 'none'
                      }}
                    >
                      {r.name}
                    </button>
                  ) : (
                    <span style={{ color: C.gray900 }}>{r.name}</span>
                  )}
                </td>
                <td style={{ padding: '10px 10px', color: C.gray700, whiteSpace: 'nowrap' }}>{formatNumber(r.leads)}</td>
                <td style={{ padding: '10px 10px', color: C.emerald600, fontWeight: 500, whiteSpace: 'nowrap' }}>{formatNumber(r.moveIns)}</td>
                <td style={{ padding: '10px 10px', color: C.gray700, whiteSpace: 'nowrap' }}>{rate(r).toFixed(1)}%</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: 'center', color: C.gray400, padding: '24px 0' }}>
                  No properties match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function TopPropertiesCard({ rows, allRows, onSelectProperty }) {
  const [showAll, setShowAll] = useState(false)

  function selectAndClose(name) {
    onSelectProperty?.(name)
    setShowAll(false)
  }

  return (
    <div style={{ ...card, padding: 16, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Top Performing Properties</h3>
      <div style={{ flex: 1 }}>
        <PropertyTable rows={rows} onSelectProperty={onSelectProperty} />
      </div>
      <button
        onClick={() => setShowAll(true)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 500, color: C.emerald600, background: 'transparent', border: 'none', cursor: 'pointer', marginTop: 12 }}
        onMouseEnter={(e) => (e.currentTarget.style.color = C.emerald700)}
        onMouseLeave={(e) => (e.currentTarget.style.color = C.emerald600)}
      >
        View all properties
        <ArrowRight size={13} />
      </button>

      {showAll && (
        <Modal title="All Properties" onClose={() => setShowAll(false)} width="max-w-2xl">
          <PropertyTable rows={allRows} searchable onSelectProperty={onSelectProperty ? selectAndClose : undefined} />
        </Modal>
      )}
    </div>
  )
}
