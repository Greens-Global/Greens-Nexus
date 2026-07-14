import { useMemo, useState } from 'react'
import { Search, ArrowUpDown, Plus, ExternalLink } from 'lucide-react'
import { LineChart, Line } from 'recharts'
import { useSortable } from '../shared/useSortable'
import { formatNumber, formatCurrency } from '../shared/utils'
import { searchKeywords } from './aggregate'
import { C, alpha } from '../theme'

const INTENT_STYLE = {
  Informational: { color: C.blue600, background: C.blue50 },
  Commercial: { color: C.purple600, background: C.purple50 },
  Transactional: { color: C.emerald600, background: C.emerald50 },
  Navigational: { color: C.gray600, background: C.gray100 },
}

function kdStyle(kd) {
  if (kd < 30) return { label: 'Easy', style: { color: C.emerald600, background: C.emerald50 } }
  if (kd < 50) return { label: 'Medium', style: { color: C.amber600, background: C.amber50 } }
  if (kd < 70) return { label: 'Hard', style: { color: C.orange600, background: C.orange50 } }
  return { label: 'Very Hard', style: { color: C.red600, background: C.red50 } }
}

function getValue(k, key) {
  switch (key) {
    case 'keyword':
      return k.keyword
    case 'volume':
      return k.volume
    case 'difficulty':
      return k.difficulty
    case 'cpc':
      return k.cpc
    case 'intent':
      return k.intent
  }
}

const columns = [
  { key: 'keyword', label: 'Keyword' },
  { key: 'volume', label: 'Volume' },
  { key: 'difficulty', label: 'KD' },
  { key: 'cpc', label: 'CPC' },
  { key: 'intent', label: 'Intent' },
]

export default function KeywordExplorerCard({ database, trackedKeywordNames, onSelectKeyword, onTrackKeyword }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => searchKeywords(database, query), [database, query])
  const { sorted, sortKey, sortDir, toggleSort } = useSortable(filtered, getValue, 'volume')

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${C.gray200}`, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Keyword Explorer</h3>

      <div style={{ position: 'relative', marginBottom: 16 }}>
        <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.gray400 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a seed keyword (e.g. storage units)..."
          style={{
            width: '100%',
            padding: '8px 12px 8px 36px',
            borderRadius: 8,
            border: `1px solid ${C.gray200}`,
            fontSize: 13,
            outline: 'none',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => (e.currentTarget.style.boxShadow = `0 0 0 2px ${C.gray200}`)}
          onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
        />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.gray100}`, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
              {columns.map((col, ci) => {
                const active = sortKey === col.key
                return (
                  <th key={col.key} style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: ci === 0 ? 0 : 10, whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => toggleSort(col.key)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        font: 'inherit',
                        textTransform: 'inherit',
                        letterSpacing: 'inherit',
                        cursor: 'pointer',
                        color: active ? C.gray700 : 'inherit',
                      }}
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
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', whiteSpace: 'nowrap' }}>Trend</th>
              <th style={{ textAlign: 'right', fontWeight: 500, padding: '8px 10px', paddingRight: 0, whiteSpace: 'nowrap' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((k, ri) => {
              const kd = kdStyle(k.difficulty)
              const tracked = trackedKeywordNames.has(k.keyword)
              return (
                <tr
                  key={k.keyword}
                  style={{ borderBottom: ri === sorted.length - 1 ? 'none' : `1px solid ${C.gray50}` }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.gray50, 0.6))}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '10px', paddingLeft: 0, whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => onSelectKeyword(k)}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500, color: C.gray900, background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = C.emerald600
                        e.currentTarget.style.textDecoration = 'underline'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = C.gray900
                        e.currentTarget.style.textDecoration = 'none'
                      }}
                    >
                      {k.keyword}
                      <ExternalLink size={11} style={{ color: C.gray300 }} />
                    </button>
                  </td>
                  <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{formatNumber(k.volume)}</td>
                  <td style={{ padding: '10px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 500, ...kd.style }}>
                      {k.difficulty} · {kd.label}
                    </span>
                  </td>
                  <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{formatCurrency(k.cpc)}</td>
                  <td style={{ padding: '10px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 500, ...INTENT_STYLE[k.intent] }}>{k.intent}</span>
                  </td>
                  <td style={{ padding: '10px', whiteSpace: 'nowrap' }}>
                    <LineChart width={72} height={24} data={k.trend.map((v) => ({ v }))}>
                      <Line type="monotone" dataKey="v" stroke="#10b981" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </td>
                  <td style={{ padding: '10px', paddingRight: 0, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => onTrackKeyword(k)}
                      disabled={tracked}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '4px 8px',
                        borderRadius: 6,
                        fontSize: 12,
                        fontWeight: 500,
                        background: C.white,
                        border: `1px solid ${tracked ? C.gray100 : C.gray200}`,
                        color: tracked ? C.gray300 : C.gray600,
                        cursor: tracked ? 'default' : 'pointer',
                      }}
                      onMouseEnter={(e) => {
                        if (!tracked) e.currentTarget.style.background = C.gray50
                      }}
                      onMouseLeave={(e) => {
                        if (!tracked) e.currentTarget.style.background = C.white
                      }}
                    >
                      <Plus size={11} />
                      {tracked ? 'Tracked' : 'Track'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} style={{ textAlign: 'center', color: C.gray400, padding: '24px 0' }}>
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
