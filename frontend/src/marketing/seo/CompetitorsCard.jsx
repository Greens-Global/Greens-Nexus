import { Shield, Trophy, TrendingUp, Users } from 'lucide-react'
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

export default function CompetitorsCard({ own, competitors }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
        <StatCard
          icon={Shield}
          color={{ color: C.emerald600, background: C.emerald50 }}
          label="Your Domain Rating"
          value={String(own.domainRating)}
          caption="greensstorage.com"
        />
        <StatCard
          icon={Trophy}
          color={{ color: C.amber600, background: C.amber50 }}
          label="Your Avg. Position"
          value={own.avgPosition > 0 ? `#${own.avgPosition.toFixed(1)}` : '-'}
          caption={`${own.keywordsInTop10} keywords in top 10`}
        />
        <StatCard
          icon={TrendingUp}
          color={{ color: C.blue600, background: C.blue50 }}
          label="Your Est. Traffic"
          value={formatNumber(own.estTraffic)}
          caption="Estimated monthly organic clicks"
        />
        <StatCard
          icon={Users}
          color={{ color: C.purple600, background: C.purple50 }}
          label="Competitors Tracked"
          value={String(competitors.length)}
          caption="Appearing in your tracked SERPs"
        />
      </div>

      <div style={{ borderRadius: 12, border: `1px solid ${C.gray200}`, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Competitor Domains</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.gray100}`, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: 0 }}>Domain</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>DR</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Keywords in Top 10</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Avg. Position</th>
                <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingRight: 0 }}>Est. Traffic</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: `1px solid ${C.gray100}`, background: alpha(C.emerald50, 0.6) }}>
                <td style={{ padding: '10px', paddingLeft: 0, fontWeight: 500, color: C.emerald700, whiteSpace: 'nowrap' }}>
                  greensstorage.com
                  <span style={{ marginLeft: 6, padding: '2px 6px', borderRadius: 9999, fontSize: 10, fontWeight: 500, color: C.emerald700, background: C.emerald100 }}>Your Site</span>
                </td>
                <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{own.domainRating}</td>
                <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{own.keywordsInTop10}</td>
                <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{own.avgPosition > 0 ? `#${own.avgPosition.toFixed(1)}` : '-'}</td>
                <td style={{ padding: '10px', paddingRight: 0, color: C.gray700, whiteSpace: 'nowrap' }}>{formatNumber(own.estTraffic)}</td>
              </tr>
              {competitors.map((c, ri) => (
                <tr
                  key={c.domain}
                  style={{ borderBottom: ri === competitors.length - 1 ? 'none' : `1px solid ${C.gray50}` }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = alpha(C.gray50, 0.6))}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '10px', paddingLeft: 0, fontWeight: 500, color: C.gray900, whiteSpace: 'nowrap' }}>{c.domain}</td>
                  <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{c.domainRating}</td>
                  <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{c.keywordsInTop10}</td>
                  <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>#{c.avgPosition.toFixed(1)}</td>
                  <td style={{ padding: '10px', paddingRight: 0, color: C.gray700, whiteSpace: 'nowrap' }}>{formatNumber(c.estTraffic)}</td>
                </tr>
              ))}
              {competitors.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: C.gray400, padding: '24px 0' }}>
                    No competitor data for the tracked keywords in this region.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: C.gray400, marginTop: 8 }}>
          Based on simulated SERPs across your currently tracked keyword database, scoped to the selected region.
        </p>
      </div>
    </div>
  )
}
