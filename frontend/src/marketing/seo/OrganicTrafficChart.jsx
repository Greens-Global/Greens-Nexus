import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { formatNumber } from '../shared/utils'
import { C } from '../theme'

export default function OrganicTrafficChart({ data }) {
  return (
    <div style={{ borderRadius: 12, border: `1px solid ${C.gray200}`, background: C.white, padding: 16, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' }}>
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 8 }}>Organic Traffic Over Time</h3>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} formatter={(v) => [formatNumber(Number(v)), 'Organic Sessions']} />
          <Line type="monotone" dataKey="sessions" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
