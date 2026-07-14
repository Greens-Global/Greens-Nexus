import DonutCard from '../shared/DonutCard'

const INTENT_COLOR = {
  Informational: '#3b82f6',
  Commercial: '#a855f7',
  Transactional: '#10b981',
  Navigational: '#6b7280',
}

const KD_TIER_COLOR = {
  Easy: '#10b981',
  Medium: '#f59e0b',
  Hard: '#f97316',
  'Very Hard': '#ef4444',
}

function kdTier(kd) {
  if (kd < 30) return 'Easy'
  if (kd < 50) return 'Medium'
  if (kd < 70) return 'Hard'
  return 'Very Hard'
}

export default function SeoDistributionCharts({ keywords }) {
  const total = keywords.length
  if (total === 0) return null

  const intentData = Object.keys(INTENT_COLOR)
    .map((intent) => ({ name: intent, value: keywords.filter((k) => k.intent === intent).length, color: INTENT_COLOR[intent] }))
    .filter((d) => d.value > 0)

  const kdData = Object.keys(KD_TIER_COLOR)
    .map((tier) => ({ name: tier, value: keywords.filter((k) => kdTier(k.difficulty) === tier).length, color: KD_TIER_COLOR[tier] }))
    .filter((d) => d.value > 0)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, marginBottom: 16, alignItems: 'stretch' }}>
      <div style={{ gridColumn: 'span 6' }}>
        <DonutCard title="Search Intent Mix" data={intentData} centerValue={String(total)} centerLabel="Keywords" />
      </div>
      <div style={{ gridColumn: 'span 6' }}>
        <DonutCard title="Keyword Difficulty Mix" data={kdData} centerValue={String(total)} centerLabel="Keywords" />
      </div>
    </div>
  )
}
