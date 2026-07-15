import { useMemo } from 'react'
import { buildHeatmapRows, MONTH_LABELS } from './aggregate'
import { formatNumber } from '../shared/utils'
import { C, alpha } from '../theme'

export default function KeywordHeatmap({ keywords }) {
  const rows = useMemo(() => buildHeatmapRows(keywords, 10), [keywords])

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${C.gray200}`, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900 }}>Keyword Volume Heatmap</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.gray400 }}>
          Low
          <span style={{ display: 'flex', gap: 2, borderRadius: 9999, border: `1px solid ${C.gray100}`, padding: 2 }}>
            {[0.2, 0.4, 0.6, 0.8, 1].map((o) => (
              <span key={o} style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: `rgba(16,185,129,${0.15 + o * 0.75})` }} />
            ))}
          </span>
          Peak season
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '6px 8px', paddingLeft: 0, whiteSpace: 'nowrap' }}>Keyword</th>
              {MONTH_LABELS.map((m) => (
                <th key={m} style={{ fontWeight: 500, padding: '6px 0', textAlign: 'center', width: 46 }}>
                  {m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.keyword}
                style={{ transition: 'background-color .15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.gray50, 0.8))}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td
                  title={r.keyword}
                  style={{
                    padding: '4px 8px',
                    paddingLeft: 0,
                    fontWeight: 500,
                    color: C.gray700,
                    whiteSpace: 'nowrap',
                    maxWidth: 180,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.keyword}
                </td>
                {r.cells.map((c, i) => (
                  <td key={i} style={{ padding: 2 }}>
                    <div
                      title={`${MONTH_LABELS[i]}: ${formatNumber(c.raw)} searches/mo`}
                      style={{ height: 24, borderRadius: 3, backgroundColor: `rgba(16,185,129,${0.15 + c.normalized * 0.75})`, transition: 'box-shadow .15s' }}
                      onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 0 0 2px #6ee7b7')}
                      onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'none')}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: C.gray400, marginTop: 8 }}>
        Each row is normalized to its own min/max so seasonal shape is comparable across head and long-tail terms.
      </p>
    </div>
  )
}
