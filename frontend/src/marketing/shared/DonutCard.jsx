import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import { C, FONT } from '../theme'

export default function DonutCard({ title, data, centerValue, centerLabel }) {
  const total = data.reduce((a, d) => a + d.value, 0)

  return (
    <div
      className="mktg-card"
      style={{
        borderRadius: 12,
        border: '1px solid ' + C.gray200,
        background: C.white,
        padding: 16,
        boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)',
        height: '100%',
        fontFamily: FONT,
      }}
    >
      <h3 style={{ fontSize: 13.5, fontWeight: 600, color: C.gray900, marginBottom: 8, marginTop: 0 }}>{title}</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ position: 'relative', width: 96, height: 96, flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius={30}
                outerRadius={46}
                paddingAngle={2}
                stroke="none"
                isAnimationActive
                animationDuration={650}
              >
                {data.map((d) => (
                  <Cell key={d.name} fill={d.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 700, color: C.gray900, lineHeight: 1.25 }}>{centerValue}</span>
            <span style={{ fontSize: 8.5, color: C.gray500, textAlign: 'center', lineHeight: 1.25, maxWidth: 52 }}>
              {centerLabel}
            </span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.map((d) => (
            <div key={d.name} style={{ fontSize: 12.5, lineHeight: 1.25 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.gray700, fontWeight: 500 }}>
                <span style={{ width: 10, height: 10, borderRadius: 9999, flexShrink: 0, background: d.color }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
              </span>
              <span style={{ color: C.gray700, fontWeight: 600, paddingLeft: 16 }}>
                {d.value.toLocaleString()}{' '}
                <span style={{ color: C.gray500, fontWeight: 400 }}>({((d.value / total) * 100).toFixed(1)}%)</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
