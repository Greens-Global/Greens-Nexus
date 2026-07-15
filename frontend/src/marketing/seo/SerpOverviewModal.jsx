import { Search, Gauge, DollarSign, Target } from 'lucide-react'
import { useState } from 'react'
import Modal from '../shared/Modal'
import { formatNumber } from '../shared/utils'
import { buildSerpResults } from './data'
import { C, alpha } from '../theme'

function kdColor(kd) {
  if (kd < 30) return { color: C.emerald600, background: C.emerald50 }
  if (kd < 50) return { color: C.amber600, background: C.amber50 }
  if (kd < 70) return { color: C.orange600, background: C.orange50 }
  return { color: C.red600, background: C.red50 }
}

function StatBox({ icon: Icon, color, value, label }) {
  return (
    <div style={{ borderRadius: 8, border: `1px solid ${C.gray200}`, padding: 10, textAlign: 'center' }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 6,
          margin: '0 auto 6px',
          color: color.color,
          background: color.background,
        }}
      >
        <Icon size={14} />
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: C.gray900 }}>{value}</div>
      <div style={{ fontSize: 11, color: C.gray500 }}>{label}</div>
    </div>
  )
}

export default function SerpOverviewModal({ keyword, onClose }) {
  const results = buildSerpResults(keyword)
  const [hoverPos, setHoverPos] = useState(null)

  return (
    <Modal title={`SERP Overview — ${keyword.keyword}`} onClose={onClose} width="max-w-3xl">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
        <StatBox icon={Search} color={{ color: C.blue600, background: C.blue50 }} value={formatNumber(keyword.volume)} label="Monthly Volume" />
        <StatBox icon={Gauge} color={kdColor(keyword.difficulty)} value={String(keyword.difficulty)} label="Difficulty (KD)" />
        <StatBox icon={DollarSign} color={{ color: C.emerald600, background: C.emerald50 }} value={`$${keyword.cpc.toFixed(2)}`} label="CPC" />
        <StatBox icon={Target} color={{ color: C.purple600, background: C.purple50 }} value={keyword.intent} label="Intent" />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.gray100}`, color: C.gray400, fontSize: 10.5, textTransform: 'uppercase' }}>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingLeft: 0, width: 40 }}>#</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Domain</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>DR</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px' }}>Backlinks</th>
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '8px 10px', paddingRight: 0 }}>Est. Traffic</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, ri) => (
              <tr
                key={r.position}
                style={{
                  borderBottom: ri === results.length - 1 ? 'none' : `1px solid ${C.gray50}`,
                  background: r.isOwnDomain ? alpha(C.emerald50, 0.6) : hoverPos === r.position ? alpha(C.gray50, 0.6) : 'transparent',
                }}
                onMouseEnter={() => !r.isOwnDomain && setHoverPos(r.position)}
                onMouseLeave={() => !r.isOwnDomain && setHoverPos(null)}
              >
                <td style={{ padding: '10px', paddingLeft: 0, fontWeight: 600, color: C.gray500 }}>{r.position}</td>
                <td style={{ padding: '10px', whiteSpace: 'nowrap' }}>
                  <div style={{ fontWeight: 500, color: r.isOwnDomain ? C.emerald700 : C.gray900 }}>
                    {r.domain}
                    {r.isOwnDomain && (
                      <span style={{ marginLeft: 6, padding: '2px 6px', borderRadius: 9999, fontSize: 10, fontWeight: 500, color: C.emerald700, background: C.emerald100 }}>
                        Your Site
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.gray400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{r.title}</div>
                </td>
                <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{r.domainRating}</td>
                <td style={{ padding: '10px', color: C.gray700, whiteSpace: 'nowrap' }}>{formatNumber(r.backlinks)}</td>
                <td style={{ padding: '10px', paddingRight: 0, color: C.gray700, whiteSpace: 'nowrap' }}>{formatNumber(r.estTraffic)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
