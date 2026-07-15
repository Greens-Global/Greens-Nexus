import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList } from 'recharts'
import { C, card } from '../theme'

export default function LeadSourceCard({ rows }) {
  const total = rows.reduce((a, r) => a + r.value, 0)
  const sorted = [...rows].sort((a, b) => b.value - a.value)
  const data = sorted.map((r) => ({
    ...r,
    display: `${r.value.toLocaleString()} (${total > 0 ? ((r.value / total) * 100).toFixed(1) : '0.0'}%)`,
  }))

  return (
    <div style={{ ...card, padding: 16, height: '100%' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 12 }}>Lead Source Performance</h3>
      <ResponsiveContainer width="100%" height={230}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eef0f3" />
          <XAxis type="number" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="source"
            tick={{ fontSize: 12, fill: '#374151' }}
            axisLine={false}
            tickLine={false}
            width={100}
          />
          <Tooltip
            formatter={(_v, _n, item) => [item?.payload?.display ?? '', 'Leads']}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
          />
          <Bar dataKey="value" fill="#22c55e" radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false}>
            <LabelList dataKey="display" position="right" style={{ fontSize: 11, fill: '#6b7280' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
