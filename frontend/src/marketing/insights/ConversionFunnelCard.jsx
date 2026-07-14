import { FunnelChart, Funnel, LabelList, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { formatNumber } from '../shared/utils'
import { C, card } from '../theme'

const COLORS = ['#bfdbfe', '#4ade80', '#15803d']

export default function ConversionFunnelCard({ sessions, leads, moveIns }) {
  const data = [
    { name: 'Sessions', value: sessions, pct: 100 },
    { name: 'Leads', value: leads, pct: sessions > 0 ? (leads / sessions) * 100 : 0 },
    { name: 'Move-Ins', value: moveIns, pct: leads > 0 ? (moveIns / leads) * 100 : 0 },
  ]

  return (
    <div style={{ ...card, padding: 16, height: '100%' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Conversion Funnel</h3>
      <ResponsiveContainer width="100%" height={230}>
        <FunnelChart>
          <Tooltip
            formatter={(v, _n, item) => [`${formatNumber(Number(v) || 0)} (${item?.payload?.pct?.toFixed(1) ?? '0.0'}%)`, item?.payload?.name ?? '']}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
          />
          <Funnel dataKey="value" data={data} isAnimationActive={false}>
            <LabelList
              position="center"
              fill="#111827"
              stroke="none"
              style={{ fontSize: 12, fontWeight: 600 }}
              content={(props) => {
                const { x, y, width, height, index } = props
                const d = data[index]
                if (!d) return null
                return (
                  <g>
                    <text x={x + width / 2} y={y + height / 2 - 6} textAnchor="middle" fontSize={12} fontWeight={600} fill="#111827">
                      {d.name}
                    </text>
                    <text x={x + width / 2} y={y + height / 2 + 10} textAnchor="middle" fontSize={11} fill="#374151">
                      {formatNumber(d.value)} ({d.pct.toFixed(1)}%)
                    </text>
                  </g>
                )
              }}
            />
            {data.map((_d, i) => (
              <Cell key={i} fill={COLORS[i]} />
            ))}
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </div>
  )
}
