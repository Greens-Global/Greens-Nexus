import DonutCard from '../shared/DonutCard'

export default function SentimentDonut({ breakdown }) {
  const data = [
    { name: 'Positive', value: breakdown.positive, color: '#10b981' },
    { name: 'Neutral', value: breakdown.neutral, color: '#f59e0b' },
    { name: 'Negative', value: breakdown.negative, color: '#ef4444' },
  ]
  return (
    <DonutCard
      title="Sentiment Breakdown"
      data={data}
      centerValue={String(breakdown.total)}
      centerLabel="Total Reviews"
    />
  )
}
