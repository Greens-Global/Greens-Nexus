import { AlertTriangle, AlertCircle, Info } from 'lucide-react'
import Modal from '../shared/Modal'
import { formatDateLabel } from '../shared/utils'
import { C } from '../theme'

const SEVERITY_STYLE = {
  High: { badge: { color: C.red700, background: C.red50 }, icon: AlertTriangle },
  Medium: { badge: { color: C.amber700, background: C.amber50 }, icon: AlertCircle },
  Low: { badge: { color: C.blue700, background: C.blue50 }, icon: Info },
}

const CATEGORY_STYLE = {
  Risk: { color: C.red600, background: C.red50 },
  Opportunity: { color: C.emerald600, background: C.emerald50 },
  Efficiency: { color: C.blue600, background: C.blue50 },
  Reputation: { color: C.purple600, background: C.purple50 },
}

export default function InsightAnalysisModal({ insight, onClose }) {
  const style = SEVERITY_STYLE[insight.severity]
  const Icon = style.icon

  return (
    <Modal title={insight.title} onClose={onClose} width="max-w-lg">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 9999, fontSize: 10.5, fontWeight: 600, ...style.badge }}>
          <Icon size={11} />
          {insight.severity}
        </span>
        <span style={{ padding: '2px 8px', borderRadius: 9999, fontSize: 10.5, fontWeight: 600, ...CATEGORY_STYLE[insight.category] }}>
          {insight.category}
        </span>
      </div>

      <p style={{ fontSize: 13, color: C.gray700, lineHeight: 1.375, marginBottom: 12 }}>{insight.whatHappened}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        <p style={{ fontSize: 12.5, color: C.gray600, lineHeight: 1.375 }}>
          <span style={{ fontWeight: 500, color: C.gray700 }}>Why: </span>
          {insight.why}
        </p>
        <p style={{ fontSize: 12.5, color: C.gray600, lineHeight: 1.375 }}>
          <span style={{ fontWeight: 500, color: C.gray700 }}>Impact: </span>
          {insight.impact}
        </p>
      </div>

      <div style={{ marginBottom: 12 }}>
        <p style={{ fontSize: 11, fontWeight: 600, color: C.gray500, textTransform: 'uppercase', letterSpacing: '0.025em', marginBottom: 4 }}>Recommended actions</p>
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 2, listStyle: 'none', margin: 0, padding: 0 }}>
          {insight.actions.map((action, i) => (
            <li key={i} style={{ fontSize: 12.5, color: C.gray700, lineHeight: 1.375, display: 'flex', gap: 6 }}>
              <span style={{ color: C.gray300 }}>•</span>
              {action}
            </li>
          ))}
        </ul>
      </div>

      {insight.metrics.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {insight.metrics.map((m) => (
            <span key={m.label} style={{ padding: '4px 8px', borderRadius: 6, background: C.gray50, border: '1px solid ' + C.gray100, fontSize: 11, color: C.gray600 }}>
              <span style={{ color: C.gray400 }}>{m.label}: </span>
              <span style={{ fontWeight: 500, color: C.gray700 }}>{m.value}</span>
            </span>
          ))}
        </div>
      )}

      <p style={{ fontSize: 10.5, color: C.gray400 }}>Generated {formatDateLabel(insight.generatedAt.slice(0, 10))}</p>
    </Modal>
  )
}
