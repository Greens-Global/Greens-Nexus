import DonutCard from '../shared/DonutCard'
import { STAGE_ORDER } from './aggregate'

const SOURCE_COLOR = {
  'Google Ads': '#3b82f6',
  Direct: '#6b7280',
  'Organic Search': '#10b981',
  Referral: '#f59e0b',
  'Social Media': '#a855f7',
  'Google Business Profile': '#14b8a6',
}

const STAGE_COLOR_HEX = {
  New: '#2563eb',
  Contacted: '#d97706',
  Toured: '#9333ea',
  'Move-In': '#059669',
  Lost: '#dc2626',
}

export default function LeadsOverviewCharts({ leads }) {
  const total = leads.length

  const sourceData = Object.keys(SOURCE_COLOR)
    .map((source) => ({ name: source, value: leads.filter((l) => l.source === source).length, color: SOURCE_COLOR[source] }))
    .filter((d) => d.value > 0)

  const stageData = STAGE_ORDER.map((stage) => ({
    name: stage,
    value: leads.filter((l) => l.stage === stage).length,
    color: STAGE_COLOR_HEX[stage],
  })).filter((d) => d.value > 0)

  if (total === 0) return null

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, marginBottom: 16, alignItems: 'stretch' }}>
      <div style={{ gridColumn: 'span 6' }}>
        <DonutCard title="Lead Source Mix" data={sourceData} centerValue={String(total)} centerLabel="Total Leads" />
      </div>
      <div style={{ gridColumn: 'span 6' }}>
        <DonutCard title="Pipeline by Stage" data={stageData} centerValue={String(total)} centerLabel="Total Leads" />
      </div>
    </div>
  )
}
