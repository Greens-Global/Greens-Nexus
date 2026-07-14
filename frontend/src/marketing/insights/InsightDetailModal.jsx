import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import Modal from '../shared/Modal'
import { C } from '../theme'

function BarRows({ data, format }) {
  const max = data.length > 0 ? Math.max(...data.map((d) => d.value)) : 0
  if (data.length === 0) return <div style={{ color: C.gray400, fontSize: 13, padding: '24px 0', textAlign: 'center' }}>No data in this view.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {data.map((d) => (
        <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: C.gray700, width: 144, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
          <div style={{ flex: 1, height: 8, borderRadius: 9999, background: C.gray100, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 9999, background: C.blue500, width: max > 0 ? `${(d.value / max) * 100}%` : '0%' }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 500, color: C.gray900, width: 80, textAlign: 'right', flexShrink: 0 }}>{format(d.value)}</span>
        </div>
      ))}
    </div>
  )
}

export default function InsightDetailModal({ label, kind, sectionTitle, data, format, onClose }) {
  return (
    <Modal title={label} onClose={onClose} width="max-w-2xl">
      <h3 style={{ fontSize: 12, fontWeight: 600, color: C.gray400, textTransform: 'uppercase', letterSpacing: '0.025em', marginBottom: 12 }}>{sectionTitle}</h3>
      {kind === 'line' ? (
        data.length === 0 ? (
          <div style={{ color: C.gray400, fontSize: 13, padding: '32px 0', textAlign: 'center' }}>No data in this view.</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data} margin={{ top: 5, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef0f3" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <Tooltip
                formatter={(v) => format(Number(v) || 0)}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )
      ) : (
        <BarRows data={data} format={format} />
      )}
    </Modal>
  )
}
