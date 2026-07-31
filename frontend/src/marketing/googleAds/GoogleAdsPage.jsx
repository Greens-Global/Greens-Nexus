import { useEffect, useMemo, useState } from 'react'
import GoogleAdsHeader from './GoogleAdsHeader'
import KpiCards from './KpiCards'
import PerformanceChart from './PerformanceChart'
import TopCampaignsCard from './TopCampaignsCard'
import DonutCard from './DonutCard'
import GeoPerformanceCard from './GeoPerformanceCard'
import KeywordPerformanceCard from './KeywordPerformanceCard'
import NewCampaignModal from './NewCampaignModal'
import EditCampaignModal from './EditCampaignModal'
import SetBudgetModal from './SetBudgetModal'
import MetricDetailModal from './MetricDetailModal'
import { filterRange, sumTotals, propertyBreakdownInRange } from './aggregate'
import { geoRows, initialCampaigns, keywordRows, dailyMetrics } from './data'
import { downloadCSV, formatCurrency, formatDateLabel, formatNumber, formatPercent, getPreviousPeriod, thisMonth } from './utils'
import { ALL_PROPERTIES, FACILITIES } from '../shared/facilities'
import PropertyComparisonModal from '../shared/PropertyComparisonModal'

const STATUS_COLORS = {
  Active: '#10b981',
  Paused: '#f59e0b',
  Completed: '#9ca3af',
}

function scaleRows(rows, share) {
  if (share === 1) return rows
  return rows.map((r) => ({
    date: r.date,
    impressions: r.impressions * share,
    clicks: r.clicks * share,
    conversions: r.conversions * share,
    spend: r.spend * share,
  }))
}

const COMPARISON_COLUMNS = [
  { key: 'spend', label: 'Spend', value: (r) => r.spend, format: (r) => formatCurrency(r.spend) },
  { key: 'budget', label: 'Monthly Budget', value: (r) => r.budget, format: (r) => formatCurrency(r.budget) },
  { key: 'clicks', label: 'Clicks', value: (r) => r.clicks, format: (r) => formatNumber(r.clicks) },
  { key: 'conversions', label: 'Conversions', value: (r) => r.conversions, format: (r) => formatNumber(r.conversions), highlight: true },
  { key: 'ctr', label: 'CTR', value: (r) => r.ctr, format: (r) => formatPercent(r.ctr) },
  { key: 'costPerConv', label: 'Cost/Conv', value: (r) => r.costPerConv, format: (r) => formatCurrency(r.costPerConv) },
]

const PLATFORM_LABEL = 'Google Ads'

export default function GoogleAdsPage({
  range,
  onRangeChange,
  property,
  onPropertyChange,
  onNavigate,
  alerts,
  insights,
  onClearAlert,
  monthlyBudgetByProperty,
  onChangeMonthlyBudget,
  action,
  onClearAction,
}) {
  const [campaigns, setCampaigns] = useState(initialCampaigns)
  const [showNewCampaign, setShowNewCampaign] = useState(false)
  const [showEditCampaign, setShowEditCampaign] = useState(false)
  const [showSetBudget, setShowSetBudget] = useState(false)
  const [compareSelection, setCompareSelection] = useState(null)
  const [selectedMetric, setSelectedMetric] = useState(null)

  useEffect(() => {
    if (action === 'create-campaign') {
      setShowNewCampaign(true)
      onClearAction?.()
    } else if (action === 'edit-campaign') {
      setShowEditCampaign(true)
      onClearAction?.()
    } else if (action === 'set-budget') {
      setShowSetBudget(true)
      onClearAction?.()
    }
  }, [action, onClearAction])

  const activeDailyMetrics = dailyMetrics
  const activeGeoRows = geoRows
  const activeKeywordRows = keywordRows
  const activeBudgetByProperty = monthlyBudgetByProperty

  const comparisonRows = useMemo(
    () => propertyBreakdownInRange(activeDailyMetrics, activeGeoRows, range),
    [activeDailyMetrics, activeGeoRows, range],
  )
  const comparisonRowsWithBudget = useMemo(
    () => comparisonRows.map((r) => ({ ...r, budget: activeBudgetByProperty[r.name] ?? 0 })),
    [comparisonRows, activeBudgetByProperty],
  )

  const previousRange = useMemo(() => getPreviousPeriod(range), [range])

  // Neither platform has a true per-facility daily time series, so a specific
  // property scales the account-wide series by that location's share of
  // clicks (derived from Geographic Performance). Growth trends therefore
  // mirror the account-wide trend; only the absolute numbers change.
  const facilityShare = useMemo(() => {
    if (property === ALL_PROPERTIES) return 1
    const totalClicks = activeGeoRows.reduce((a, g) => a + g.clicks, 0)
    const row = activeGeoRows.find((g) => g.location === property)
    return row && totalClicks > 0 ? row.clicks / totalClicks : 1
  }, [property, activeGeoRows])

  const scopedCampaigns = useMemo(
    () => (property === ALL_PROPERTIES ? campaigns : campaigns.filter((c) => c.facility === property)),
    [campaigns, property],
  )
  const scopedGeoRows = useMemo(
    () => (property === ALL_PROPERTIES ? activeGeoRows : activeGeoRows.filter((g) => g.location === property)),
    [property, activeGeoRows],
  )

  const rows = useMemo(
    () => scaleRows(filterRange(activeDailyMetrics, range), facilityShare),
    [activeDailyMetrics, range, facilityShare],
  )
  const prevRows = useMemo(
    () => scaleRows(filterRange(activeDailyMetrics, previousRange), facilityShare),
    [activeDailyMetrics, previousRange, facilityShare],
  )

  const totals = useMemo(() => sumTotals(rows), [rows])
  const prevTotals = useMemo(() => sumTotals(prevRows), [prevRows])

  // Monthly budget usage is always measured against the current calendar
  // month to date, independent of whatever range the user has selected -
  // same convention as the account-wide budget alert in shared/alerts.
  const monthlyBudget =
    property === ALL_PROPERTIES
      ? Object.values(activeBudgetByProperty).reduce((a, b) => a + b, 0)
      : activeBudgetByProperty[property] ?? 0
  const monthSpend = useMemo(
    () => sumTotals(scaleRows(filterRange(activeDailyMetrics, thisMonth()), facilityShare)).spend,
    [activeDailyMetrics, facilityShare],
  )

  const statusCounts = useMemo(() => {
    const counts = { Active: 0, Paused: 0, Completed: 0 }
    for (const c of scopedCampaigns) counts[c.status] = (counts[c.status] ?? 0) + 1
    return counts
  }, [scopedCampaigns])

  const statusData = ['Active', 'Paused', 'Completed'].map((s) => ({
    name: s,
    value: statusCounts[s] ?? 0,
    color: STATUS_COLORS[s],
  }))

  function toggleStatus(id) {
    setCampaigns((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, status: c.status === 'Active' ? 'Paused' : c.status === 'Paused' ? 'Active' : c.status }
          : c,
      ),
    )
  }

  function createCampaign(campaign) {
    setCampaigns((prev) => [campaign, ...prev])
  }

  function updateCampaignFields(id, updates) {
    setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)))
  }

  function downloadReport() {
    const rowsCsv = [
      [`${PLATFORM_LABEL} Performance Report`],
      [`Range: ${formatDateLabel(range.start)} - ${formatDateLabel(range.end)}`],
      [`Property: ${property}`],
      [],
      ['Metric', 'Value'],
      ['Total Spend', formatCurrency(totals.spend)],
      ['Impressions', formatNumber(totals.impressions)],
      ['Clicks', formatNumber(totals.clicks)],
      ['Conversions', formatNumber(totals.conversions)],
      ['CTR', formatPercent(totals.ctr)],
      ['Cost / Conversion', formatCurrency(totals.costPerConv)],
      ['Avg. CPC', formatCurrency(totals.avgCpc)],
      [],
      ['Campaign', 'Platform', 'Facility', 'Spend', 'Clicks', 'Conversions', 'Status'],
      ...scopedCampaigns.map((c) => [c.name, c.platform, c.facility, c.spend.toFixed(2), c.clicks, c.conversions, c.status]),
    ]
    downloadCSV(`google-ads-report_${range.start}_${range.end}.csv`, rowsCsv)
  }

  return (
    <div>
      <GoogleAdsHeader
        range={range}
        onRangeChange={onRangeChange}
        property={property}
        properties={FACILITIES}
        onPropertyChange={onPropertyChange}
        onDownload={downloadReport}
        onCompare={setCompareSelection}
        onNavigate={onNavigate}
        alerts={alerts}
        insights={insights}
        onClearAlert={onClearAlert}
        monthlyBudget={monthlyBudget}
        monthSpend={monthSpend}
      />

      <KpiCards
        current={totals}
        previous={prevTotals}
        previousRange={previousRange}
        onSelectMetric={(key, label, format) => setSelectedMetric({ key, label, format })}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, marginBottom: 16, alignItems: 'stretch' }}>
        <div style={{ gridColumn: 'span 4' }}>
          <PerformanceChart rows={rows} prevRows={prevRows} />
        </div>
        <div style={{ gridColumn: 'span 5' }}>
          <TopCampaignsCard campaigns={scopedCampaigns} onToggleStatus={toggleStatus} />
        </div>
        <div style={{ gridColumn: 'span 3' }}>
          <DonutCard
            title="Campaign Status"
            data={statusData}
            centerValue={String(scopedCampaigns.length)}
            centerLabel="Total Campaigns"
          />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, alignItems: 'stretch' }}>
        <div style={{ gridColumn: 'span 6' }}>
          <GeoPerformanceCard rows={scopedGeoRows} />
        </div>
        <div style={{ gridColumn: 'span 6' }}>
          <KeywordPerformanceCard rows={activeKeywordRows} />
        </div>
      </div>

      {showNewCampaign && (
        <NewCampaignModal
          onClose={() => setShowNewCampaign(false)}
          onCreate={createCampaign}
          defaultFacility={property === ALL_PROPERTIES ? undefined : property}
        />
      )}

      {showEditCampaign && (
        <EditCampaignModal
          campaigns={scopedCampaigns}
          onClose={() => setShowEditCampaign(false)}
          onSave={updateCampaignFields}
        />
      )}

      {showSetBudget && (
        <SetBudgetModal
          facilities={FACILITIES}
          googleBudgetByProperty={monthlyBudgetByProperty}
          onChangeGoogleBudget={onChangeMonthlyBudget}
          onClose={() => setShowSetBudget(false)}
        />
      )}

      {compareSelection && (
        <PropertyComparisonModal
          title={`Compare Properties - ${PLATFORM_LABEL}`}
          rows={comparisonRowsWithBudget.filter((r) => compareSelection.includes(r.name))}
          columns={COMPARISON_COLUMNS}
          onClose={() => setCompareSelection(null)}
        />
      )}

      {selectedMetric && (
        <MetricDetailModal
          metricKey={selectedMetric.key}
          label={selectedMetric.label}
          format={selectedMetric.format}
          rows={rows}
          campaigns={scopedCampaigns}
          onClose={() => setSelectedMetric(null)}
        />
      )}
    </div>
  )
}
