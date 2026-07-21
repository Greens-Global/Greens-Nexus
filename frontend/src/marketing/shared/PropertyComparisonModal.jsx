import { useState } from 'react'
import { ArrowUpDown } from 'lucide-react'
import Modal from './Modal'
import { useSortable } from './useSortable'
import { C, FONT, alpha } from '../theme'

export default function PropertyComparisonModal({ title, rows, columns, onClose }) {
  const [hoveredRow, setHoveredRow] = useState(null)

  function getValue(row, key) {
    const col = columns.find((c) => c.key === key)
    return col ? col.value(row) : ''
  }
  const { sorted, sortKey, sortDir, toggleSort } = useSortable(rows, getValue, columns[0]?.key ?? 'name')

  return (
    <Modal title={title} onClose={onClose} width="max-w-4xl">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, fontFamily: FONT, borderCollapse: 'collapse' }}>
          <thead>
            <tr
              style={{
                borderBottom: '1px solid ' + C.gray100,
                color: C.gray400,
                fontSize: 10.5,
                textTransform: 'uppercase',
              }}
            >
              <th
                style={{
                  textAlign: 'left',
                  fontWeight: 500,
                  padding: '8px 10px',
                  paddingLeft: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                Property
              </th>
              {columns.map((col) => {
                const isActive = sortKey === col.key
                return (
                  <th
                    key={col.key}
                    style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', whiteSpace: 'nowrap' }}
                  >
                    <button
                      onClick={() => toggleSort(col.key)}
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.color = C.gray600
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) e.currentTarget.style.color = 'inherit'
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        color: isActive ? C.gray700 : 'inherit',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        font: 'inherit',
                        textTransform: 'uppercase',
                      }}
                    >
                      {col.label}
                      <ArrowUpDown
                        size={10}
                        style={{
                          transition: 'transform .15s',
                          opacity: isActive ? 1 : 0.3,
                          transform: isActive && sortDir === 'asc' ? 'rotate(180deg)' : 'none',
                        }}
                      />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => {
              const isLast = idx === sorted.length - 1
              return (
                <tr
                  key={r.name}
                  onMouseEnter={() => setHoveredRow(r.name)}
                  onMouseLeave={() => setHoveredRow(null)}
                  style={{
                    borderBottom: isLast ? 'none' : '1px solid ' + C.gray50,
                    background: hoveredRow === r.name ? alpha(C.gray50, 0.6) : 'transparent',
                  }}
                >
                  <td
                    style={{
                      padding: '10px 10px',
                      paddingLeft: 0,
                      fontWeight: 500,
                      color: C.gray900,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.name}
                  </td>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: '10px 10px',
                        whiteSpace: 'nowrap',
                        color: col.highlight ? C.emerald600 : C.gray700,
                        fontWeight: col.highlight ? 500 : 400,
                      }}
                    >
                      {col.format(r)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
