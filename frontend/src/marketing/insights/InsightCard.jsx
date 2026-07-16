import { useState } from 'react'
import { AlertTriangle, AlertCircle, Info, ChevronRight, Sparkles } from 'lucide-react'
import InsightAnalysisModal from './InsightAnalysisModal'
import { C, alpha } from '../theme'

const SEVERITY_STYLE = {
  High: { stripe: C.red500, badge: { color: C.red700, background: C.red50 }, icon: AlertTriangle },
  Medium: { stripe: C.amber500, badge: { color: C.amber700, background: C.amber50 }, icon: AlertCircle },
  Low: { stripe: C.blue500, badge: { color: C.blue700, background: C.blue50 }, icon: Info },
}

const CATEGORY_STYLE = {
  Risk: { color: C.red600, background: C.red50 },
  Opportunity: { color: C.emerald600, background: C.emerald50 },
  Efficiency: { color: C.blue600, background: C.blue50 },
  Reputation: { color: C.purple600, background: C.purple50 },
}

export default function InsightCard({ insight, onNavigate, onViewMetric, hero }) {
  const style = SEVERITY_STYLE[insight.severity]
  const Icon = style.icon
  const clickable = (!!insight.tab && !!onNavigate) || (!!insight.metricKey && !!onViewMetric)
  const [showDetails, setShowDetails] = useState(false)

  function handleView() {
    if (insight.metricKey && onViewMetric) onViewMetric(insight.metricKey)
    else if (insight.tab && onNavigate) onNavigate(insight.tab)
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid ' + (hero ? C.purple200 : C.gray200),
        background: hero ? alpha(C.purple50, 0.4) : C.white,
        boxShadow: hero ? '0 1px 2px 0 rgba(0,0,0,0.05), 0 0 0 1px ' + C.purple100 : '0 1px 2px 0 rgba(0,0,0,0.05)',
      }}
    >
      <div style={{ width: 4, flexShrink: 0, background: style.stripe }} />
      <div style={{ flex: 1, padding: 16 }}>
        {hero && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 10.5, fontWeight: 600, color: C.purple600, textTransform: 'uppercase', letterSpacing: '0.025em' }}>
            <Sparkles size={11} />
            Top Priority
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 9999, fontSize: 10.5, fontWeight: 600, ...style.badge }}>
              <Icon size={11} />
              {insight.severity}
            </span>
            <span style={{ padding: '2px 8px', borderRadius: 9999, fontSize: 10.5, fontWeight: 600, ...CATEGORY_STYLE[insight.category] }}>
              {insight.category}
            </span>
            <h3 style={{ fontWeight: 600, color: C.gray900, fontSize: hero ? 15 : 14 }}>{insight.title}</h3>
          </div>
          {clickable && (
            <button
              onClick={handleView}
              style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11.5, color: C.gray400, flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = C.gray700)}
              onMouseLeave={(e) => (e.currentTarget.style.color = C.gray400)}
            >
              View
              <ChevronRight size={13} />
            </button>
          )}
        </div>

        <p style={{ fontSize: 12.5, color: C.gray700, lineHeight: 1.375, marginBottom: 8 }}>{insight.summary}</p>

        <button
          onClick={() => setShowDetails(true)}
          style={{ fontSize: 12, fontWeight: 500, color: C.purple600, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = C.purple700)}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.purple600)}
        >
          Read More
        </button>
      </div>

      {showDetails && <InsightAnalysisModal insight={insight} onClose={() => setShowDetails(false)} />}
    </div>
  )
}
