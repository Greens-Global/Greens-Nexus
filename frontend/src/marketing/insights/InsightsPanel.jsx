import { Sparkles } from 'lucide-react'
import InsightCard from './InsightCard'
import { C, card } from '../theme'

const CHIP_STYLE = {
  High: { color: C.red700, background: C.red50, border: '1px solid ' + C.red100 },
  Medium: { color: C.amber700, background: C.amber50, border: '1px solid ' + C.amber100 },
  Low: { color: C.blue700, background: C.blue50, border: '1px solid ' + C.blue100 },
}

export default function InsightsPanel({ insights, onNavigate, onViewMetric }) {
  const counts = insights.reduce(
    (acc, i) => {
      acc[i.severity]++
      return acc
    },
    { High: 0, Medium: 0, Low: 0 },
  )
  const [hero, ...rest] = insights

  return (
    <div style={{ ...card, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={15} style={{ color: C.purple500 }} />
          <h2 style={{ fontSize: 14, fontWeight: 600, color: C.gray900 }}>AI Marketing Analyst</h2>
        </div>
        {insights.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {(['High', 'Medium', 'Low']).map(
              (s) =>
                counts[s] > 0 && (
                  <span key={s} style={{ padding: '2px 8px', borderRadius: 9999, fontSize: 10.5, fontWeight: 600, ...CHIP_STYLE[s] }}>
                    {counts[s]} {s}
                  </span>
                ),
            )}
            <span style={{ fontSize: 11, color: C.gray400, marginLeft: 2 }}>{insights.length} total</span>
          </div>
        )}
      </div>

      {insights.length === 0 ? (
        <div style={{ textAlign: 'center', color: C.gray400, fontSize: 12.5, padding: '32px 0' }}>
          No notable changes this period - performance is holding steady across all monitored channels.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <InsightCard insight={hero} onNavigate={onNavigate} onViewMetric={onViewMetric} hero />
          {rest.map((insight) => (
            <InsightCard key={insight.id} insight={insight} onNavigate={onNavigate} onViewMetric={onViewMetric} />
          ))}
        </div>
      )}
    </div>
  )
}
