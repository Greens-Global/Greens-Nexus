import { formatNumber, formatPercent } from '../shared/utils'
import { C, alpha } from '../theme'

export default function TopLandingPagesCard({ rows }) {
  return (
    <div style={{ borderRadius: 12, border: `1px solid ${C.gray200}`, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Top Organic Landing Pages</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.gray100}`, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: 0 }}>Page</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Sessions</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Avg. Position</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingRight: 0 }}>Bounce Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr
                key={r.path}
                style={{ borderBottom: ri === rows.length - 1 ? 'none' : `1px solid ${C.gray50}` }}
                onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.gray50, 0.6))}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <td style={{ padding: '10px', paddingLeft: 0, fontWeight: 500, color: C.gray900, whiteSpace: 'nowrap' }}>{r.path}</td>
                <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{formatNumber(r.sessions)}</td>
                <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>#{r.avgPosition.toFixed(1)}</td>
                <td style={{ padding: '10px', paddingRight: 0, color: C.gray700, whiteSpace: 'nowrap' }}>{formatPercent(r.bounceRate, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
