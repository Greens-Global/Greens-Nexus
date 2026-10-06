import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Link2 } from 'lucide-react'
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
import CampaignFacilitiesModal from './CampaignFacilitiesModal'
import { filterRange, sumTotals, propertyBreakdownInRange } from './aggregate'
import { geoRows, initialCampaigns, keywordRows, dailyMetrics } from './data'
import { downloadCSV, formatCurrency, formatDateLabel, formatNumber, formatPercent, getPreviousPeriod, thisMonth } from './utils'
import { useAdsReport, useAdsStatus, ADS_BAR, announceAdsChange } from './useAds'
import { ALL_PROPERTIES, FACILITIES } from '../shared/facilities'
import PropertyComparisonModal from '../shared/PropertyComparisonModal'
import MarketingTabBar from '../shared/MarketingTabBar'
import GbpConnectionBar, { Notice } from '../gbp/GbpConnectionBar'
import { useGbpPermissions } from '../gbp/useGbp'
import { SkeletonBlocks } from '../../components/AsyncState'
import { formatDate, formatDateTime } from '../../lib/datetime'
import { C } from '../theme'

const STATUS_COLORS = {
  Active: '#10b981',
  Paused: '#f59e0b',
  Completed: '#9ca3af',
}

const GOOGLE_ADS_URL = 'https://ads.google.com/aw/campaigns'

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

const linkBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
  border: '1px solid ' + C.gray200, fontSize: 12.5, fontWeight: 500, color: C.gray700, background: C.white, textDecoration: 'none',
}

// Google Ads tab. Connected to Google Ads -> the real figures (read-only:
// campaigns are created and changed in Google Ads). Not connected (or no
// Marketing grant) -> the sample page, with the connection bar saying so.
export default function GoogleAdsPage(props) {
  const ads = useAdsStatus()
  const [reloadKey, setReloadKey] = useState(0)
  const reload = () => setReloadKey((k) => k + 1)
  const bar = <GbpConnectionBar gbp={ads} config={ADS_BAR} onSynced={reload} />

  if (ads.loading) {
    return (
      <div>
        <div style={{ marginBottom: 20 }}>
          <MarketingTabBar active="google-ads" onNavigate={props.onNavigate} alerts={props.alerts} insights={props.insights} onClearAlert={props.onClearAlert} />
        </div>
        <SkeletonBlocks count={3} height={120} />
      </div>
    )
  }
  if (ads.status?.connected) {
    return <LiveGoogleAds {...props} bar={bar} status={ads.status} reloadKey={reloadKey} onMapped={() => { reload(); ads.refresh(); announceAdsChange() }} />
  }
  return <SampleGoogleAds {...props} bar={bar} />
}

function SampleGoogleAds(props) {
  const { range, property, monthlyBudgetByProperty } = props
  const [campaigns, setCampaigns] = useState(initialCampaigns)

  const activeDailyMetrics = dailyMetrics
  const activeGeoRows = geoRows

  const comparisonRows = useMemo(
    () => propertyBreakdownInRange(activeDailyMetrics, activeGeoRows, range),
    [activeDailyMetrics, activeGeoRows, range],
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
  const monthSpend = useMemo(
    () => sumTotals(scaleRows(filterRange(activeDailyMetrics, thisMonth()), facilityShare)).spend,
    [activeDailyMetrics, facilityShare],
  )

  function toggleStatus(id) {
    setCampaigns((prev) =>
      prev.map((c) =>
        c.id === id
          ? { ...c, status: c.status === 'Active' ? 'Paused' : c.status === 'Paused' ? 'Active' : c.status }
          : c,
      ),
    )
  }

  return (
    <AdsView
      {...props}
      rows={rows}
      prevRows={prevRows}
      previousRange={previousRange}
      monthSpend={monthSpend}
      campaigns={scopedCampaigns}
      geoRows={scopedGeoRows}
      keywordRows={keywordRows}
      comparisonRows={comparisonRows}
      budgets={monthlyBudgetByProperty}
      onToggleStatus={toggleStatus}
      onCreateCampaign={(c) => setCampaigns((prev) => [c, ...prev])}
      onUpdateCampaign={(id, updates) => setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)))}
    />
  )
}

function breakdownRow(g) {
  return {
    name: g.location,
    impressions: g.impressions,
    clicks: g.clicks,
    conversions: g.conversions,
    spend: g.spend,
    ctr: g.impressions > 0 ? (g.clicks / g.impressions) * 100 : 0,
    costPerConv: g.conversions > 0 ? g.spend / g.conversions : 0,
    avgCpc: g.clicks > 0 ? g.spend / g.clicks : 0,
  }
}

function LiveGoogleAds(props) {
  const { range, property, reloadKey, status, onMapped, monthlyBudgetByProperty } = props
  const { data, error, loading, reload } = useAdsReport(range, property, reloadKey)
  const { canEditListing: canMap } = useGbpPermissions()
  const [mapping, setMapping] = useState(false)
  const previousRange = useMemo(() => getPreviousPeriod(range), [range])

  const allGeo = useMemo(() => data?.geoRows || [], [data])
  const scopedGeo = useMemo(
    () => (property === ALL_PROPERTIES ? allGeo : allGeo.filter((g) => g.location === property)),
    [allGeo, property],
  )
  const comparisonRows = useMemo(() => allGeo.map(breakdownRow), [allGeo])

  const liveBar = (
    <>
      {data?.error && <Notice kind="warn">The last sync did not finish for every account: {data.error}</Notice>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 16, fontSize: 12.5, color: C.gray500 }}>
        <span>
          Figures from Google Ads{data?.firstDate ? ` since ${formatDate(data.firstDate)}` : ''}, last synced {formatDateTime(data?.syncedAt || status.lastSyncAt, 'never')}.
          {status.unmappedCount > 0 && (
            <> {status.unmappedCount} campaign{status.unmappedCount === 1 ? ' is' : 's are'} not mapped to a property yet and count as Unassigned.</>
          )}
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          {canMap && (
            <button onClick={() => setMapping(true)} style={linkBtn}><Link2 size={13} />Map Campaigns</button>
          )}
          <a href={GOOGLE_ADS_URL} target="_blank" rel="noreferrer" style={linkBtn}><ExternalLink size={13} />Open Google Ads</a>
        </span>
      </div>
      {mapping && <CampaignFacilitiesModal onClose={() => setMapping(false)} onSaved={() => { setMapping(false); onMapped() }} />}
    </>
  )

  let body = null
  if (loading && !data) body = <SkeletonBlocks count={3} height={120} />
  else if (error && !data) {
    body = <Notice kind="error">{error} <button onClick={reload} style={{ ...linkBtn, padding: '2px 8px', marginLeft: 6 }}>Retry</button></Notice>
  } else if (!data?.firstDate) {
    body = <Notice kind="info">No figures have synced from Google Ads yet. They appear after the first sync finishes.</Notice>
  }

  return (
    <AdsView
      {...props}
      live
      liveBar={liveBar}
      body={body}
      rows={data?.rows || []}
      prevRows={data?.prevRows || []}
      previousRange={previousRange}
      monthSpend={data?.monthSpend || 0}
      campaigns={data?.campaigns || []}
      geoRows={scopedGeo}
      keywordRows={data?.keywordRows || []}
      comparisonRows={comparisonRows}
      budgets={monthlyBudgetByProperty}
    />
  )
}

function AdsView({
  range,
  onRangeChange,
  property,
  onPropertyChange,
  onNavigate,
  alerts,
  insights,
  onClearAlert,
  onChangeMonthlyBudget,
  onSaveBudgets,
  action,
  onClearAction,
  bar,
  live = false,
  liveBar = null,
  body = null,
  rows,
  prevRows,
  previousRange,
  monthSpend,
  campaigns,
  geoRows: scopedGeoRows,
  keywordRows: activeKeywordRows,
  comparisonRows,
  budgets: activeBudgetByProperty,
  onToggleStatus,
  onCreateCampaign,
  onUpdateCampaign,
}) {
  const [showNewCampaign, setShowNewCampaign] = useState(false)
  const [showEditCampaign, setShowEditCampaign] = useState(false)
  const [showSetBudget, setShowSetBudget] = useState(false)
  const [compareSelection, setCompareSelection] = useState(null)
  const [selectedMetric, setSelectedMetric] = useState(null)
  const [readOnlyNotice, setReadOnlyNotice] = useState(false)

  useEffect(() => {
    if (action === 'create-campaign' || action === 'edit-campaign') {
      // Nexus only reads Google Ads - campaigns change in Google Ads itself.
      if (live) setReadOnlyNotice(true)
      else if (action === 'create-campaign') setShowNewCampaign(true)
      else setShowEditCampaign(true)
      onClearAction?.()
    } else if (action === 'set-budget') {
      setShowSetBudget(true)
      onClearAction?.()
    }
  }, [action, onClearAction, live])

  const comparisonRowsWithBudget = useMemo(
    () => comparisonRows.map((r) => ({ ...r, budget: activeBudgetByProperty[r.name] ?? 0 })),
    [comparisonRows, activeBudgetByProperty],
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

  const statusCounts = useMemo(() => {
    const counts = { Active: 0, Paused: 0, Completed: 0 }
    for (const c of campaigns) counts[c.status] = (counts[c.status] ?? 0) + 1
    return counts
  }, [campaigns])

  const statusData = ['Active', 'Paused', 'Completed'].map((s) => ({
    name: s,
    value: statusCounts[s] ?? 0,
    color: STATUS_COLORS[s],
  }))

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
      ...campaigns.map((c) => [c.name, c.platform, c.facility, c.spend.toFixed(2), c.clicks, c.conversions, c.status]),
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

      {bar}
      {liveBar}
      {readOnlyNotice && (
        <Notice kind="info" onClose={() => setReadOnlyNotice(false)}>
          Campaigns are created, edited and paused in Google Ads - Nexus reads the figures from it.{' '}
          <a href={GOOGLE_ADS_URL} target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 600 }}>Open Google Ads</a>
        </Notice>
      )}

      {body || (
        <>
          <KpiCards
            current={totals}
            previous={prevTotals}
            previousRange={previousRange}
            onSelectMetric={(key, label, format) => setSelectedMetric({ key, label, format })}
          />

          <div className="mktg-grid12" style={{ marginBottom: 16 }}>
            <div className="mktg-span-4">
              <PerformanceChart rows={rows} prevRows={prevRows} />
            </div>
            <div className="mktg-span-5">
              <TopCampaignsCard campaigns={campaigns} onToggleStatus={onToggleStatus} />
            </div>
            <div className="mktg-span-3">
              <DonutCard
                title="Campaign Status"
                data={statusData}
                centerValue={String(campaigns.length)}
                centerLabel="Total Campaigns"
              />
            </div>
          </div>

          <div className="mktg-grid12">
            <div className="mktg-span-6">
              <GeoPerformanceCard rows={scopedGeoRows} />
            </div>
            <div className="mktg-span-6">
              <KeywordPerformanceCard rows={activeKeywordRows} />
            </div>
          </div>
        </>
      )}

      {showNewCampaign && (
        <NewCampaignModal
          onClose={() => setShowNewCampaign(false)}
          onCreate={onCreateCampaign}
          defaultFacility={property === ALL_PROPERTIES ? undefined : property}
        />
      )}

      {showEditCampaign && (
        <EditCampaignModal
          campaigns={campaigns}
          onClose={() => setShowEditCampaign(false)}
          onSave={onUpdateCampaign}
        />
      )}

      {showSetBudget && (
        <SetBudgetModal
          facilities={FACILITIES}
          googleBudgetByProperty={activeBudgetByProperty}
          onChangeGoogleBudget={onChangeMonthlyBudget}
          onSaveAll={onSaveBudgets}
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
          campaigns={campaigns}
          onClose={() => setSelectedMetric(null)}
        />
      )}
    </div>
  )
}
