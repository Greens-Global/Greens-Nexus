import { useEffect, useMemo, useRef, useState } from 'react'
import InsightsHeader from './InsightsHeader'
import KpiCards, { KPI_CARD_DEFS } from './KpiCards'
import LeadSourceCard from './LeadSourceCard'
import ConversionFunnelCard from './ConversionFunnelCard'
import LeadsTrendChart from './LeadsTrendChart'
import TopPropertiesCard from './TopPropertiesCard'
import InsightDetailModal from './InsightDetailModal'
import SetGoalsModal from './SetGoalsModal'
import InsightsPanel from './InsightsPanel'
import { generateInsights } from './insightEngine'
import RatingTrendCard from '../reputation/RatingTrendCard'
import { filterByRange, dailyRowsForProperty, sumLeadTotals, leadsByChannelInRange, propertyBreakdownInRange } from './aggregate'
import { filterRange as gaFilterRange, sumTotals as gaSumTotals } from '../googleAds/aggregate'
import { geoRows, dailyMetrics, initialCampaigns } from '../googleAds/data'
import { yelpGeoRows, yelpDailyMetrics, yelpInitialCampaigns } from '../googleAds/yelpData'
import { allReviews } from '../reputation/data'
import { asOf, computeLifetimeStats, computeSentimentBreakdown, computeSourceSummary, hoursSince, filterByRange as repFilterByRange } from '../reputation/aggregate'
import { initialQuestions, initialPhotos } from '../reputation/gbpContentData'
import { unansweredCount, stalePhotoProperties } from '../reputation/gbpContentAggregate'
import { trackedKeywords, keywordDatabase } from '../seo/data'
import { computeTrackedStats, positionDelta } from '../seo/aggregate'
import { initialLeads } from '../leads/data'
import { computeLeadStats, daysInStage } from '../leads/aggregate'
import { ALL_PROPERTIES, FACILITIES } from '../shared/facilities'
import PropertyComparisonModal from '../shared/PropertyComparisonModal'
import {
  ANCHOR_DATE,
  downloadCSV,
  formatCurrency,
  formatDateFromDate,
  formatNumber,
  formatPercent,
  formatRangeLabel,
  getPreviousPeriod,
  monthCoverageFraction,
  parseISO,
  thisMonth,
} from '../shared/utils'

function propertyConvRate(r) {
  return r.leads > 0 ? (r.moveIns / r.leads) * 100 : 0
}

const COMPARISON_COLUMNS = [
  { key: 'leads', label: 'Leads', value: (r) => r.leads, format: (r) => formatNumber(r.leads) },
  { key: 'moveIns', label: 'Move-Ins', value: (r) => r.moveIns, format: (r) => formatNumber(r.moveIns), highlight: true },
  { key: 'rate', label: 'Conversion Rate', value: (r) => propertyConvRate(r), format: (r) => formatPercent(propertyConvRate(r), 1) },
]

function shortLabel(iso) {
  return formatDateFromDate(parseISO(iso))
}

export default function InsightsPage({
  range,
  onRangeChange,
  property,
  onPropertyChange,
  onNavigate,
  alerts,
  onClearAlert,
  leadGoalByProperty,
  onChangeLeadGoal,
  monthlyBudgetByProperty,
  yelpMonthlyBudgetByProperty,
  action,
  onClearAction,
}) {
  const [selectedMetric, setSelectedMetric] = useState(null)
  const [compareSelection, setCompareSelection] = useState(null)
  const [showSetGoals, setShowSetGoals] = useState(false)
  const [highlightAnalyst, setHighlightAnalyst] = useState(false)
  const analystRef = useRef(null)

  useEffect(() => {
    if (action === 'set-goals') {
      setShowSetGoals(true)
      onClearAction?.()
    } else if (action === 'view-ai-analysis') {
      analystRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setHighlightAnalyst(true)
      setTimeout(() => setHighlightAnalyst(false), 2000)
      onClearAction?.()
    }
  }, [action, onClearAction])

  const previousRange = useMemo(() => getPreviousPeriod(range), [range])
  const propertyKey = property === ALL_PROPERTIES ? null : property

  // Exact per-property daily rows, derived from the parsed GA4 report rows
  // (not an approximate percentage split).
  const dailyRows = useMemo(() => dailyRowsForProperty(propertyKey), [propertyKey])
  const rows = useMemo(() => filterByRange(dailyRows, range), [dailyRows, range])
  const prevRows = useMemo(() => filterByRange(dailyRows, previousRange), [dailyRows, previousRange])

  const totals = useMemo(() => sumLeadTotals(rows), [rows])
  const prevTotals = useMemo(() => sumLeadTotals(prevRows), [prevRows])

  // Cost per Lead is genuinely derived from the combined Google Ads + Yelp
  // Ads spend series, each scoped the same way their own page scopes a
  // selected property.
  const gaFacilityShare = useMemo(() => {
    if (property === ALL_PROPERTIES) return 1
    const totalClicks = geoRows.reduce((a, g) => a + g.clicks, 0)
    const row = geoRows.find((g) => g.location === property)
    return row && totalClicks > 0 ? row.clicks / totalClicks : 1
  }, [property])
  const yelpFacilityShare = useMemo(() => {
    if (property === ALL_PROPERTIES) return 1
    const totalClicks = yelpGeoRows.reduce((a, g) => a + g.clicks, 0)
    const row = yelpGeoRows.find((g) => g.location === property)
    return row && totalClicks > 0 ? row.clicks / totalClicks : 1
  }, [property])

  const gaRows = useMemo(() => gaFilterRange(dailyMetrics, range), [range])
  const gaPrevRows = useMemo(() => gaFilterRange(dailyMetrics, previousRange), [previousRange])
  const yelpRows = useMemo(() => gaFilterRange(yelpDailyMetrics, range), [range])
  const yelpPrevRows = useMemo(() => gaFilterRange(yelpDailyMetrics, previousRange), [previousRange])

  const gaSpend = useMemo(() => gaSumTotals(gaRows).spend * gaFacilityShare, [gaRows, gaFacilityShare])
  const gaPrevSpend = useMemo(() => gaSumTotals(gaPrevRows).spend * gaFacilityShare, [gaPrevRows, gaFacilityShare])
  const yelpSpend = useMemo(() => gaSumTotals(yelpRows).spend * yelpFacilityShare, [yelpRows, yelpFacilityShare])
  const yelpPrevSpend = useMemo(() => gaSumTotals(yelpPrevRows).spend * yelpFacilityShare, [yelpPrevRows, yelpFacilityShare])

  const costPerLead = totals.leads > 0 ? (gaSpend + yelpSpend) / totals.leads : 0
  const prevCostPerLead = prevTotals.leads > 0 ? (gaPrevSpend + yelpPrevSpend) / prevTotals.leads : 0

  // Review Rating is genuinely derived from the Reputation reviews dataset.
  const scopedReviews = useMemo(
    () => (property === ALL_PROPERTIES ? allReviews : allReviews.filter((r) => r.facility === property)),
    [property],
  )
  const reviewsAsOfEnd = useMemo(() => asOf(scopedReviews, range.end), [scopedReviews, range.end])
  const reviewsAsOfPrevEnd = useMemo(() => asOf(scopedReviews, previousRange.end), [scopedReviews, previousRange.end])
  const reviewRating = useMemo(() => computeLifetimeStats(reviewsAsOfEnd).overallRating, [reviewsAsOfEnd])
  const prevReviewRating = useMemo(() => computeLifetimeStats(reviewsAsOfPrevEnd).overallRating, [reviewsAsOfPrevEnd])

  const current = {
    totalLeads: totals.leads,
    sessions: totals.sessions,
    leadToMoveInRate: totals.leadToMoveInRate,
    costPerLead,
    organicTraffic: totals.organicSessions,
    reviewRating,
    nps: totals.npsAvg,
  }
  const previous = {
    totalLeads: prevTotals.leads,
    sessions: prevTotals.sessions,
    leadToMoveInRate: prevTotals.leadToMoveInRate,
    costPerLead: prevCostPerLead,
    organicTraffic: prevTotals.organicSessions,
    reviewRating: prevReviewRating,
    nps: prevTotals.npsAvg,
  }

  // Genuinely date-range- and property-scoped, pulled from the parsed GA4
  // event rows rather than a fixed percentage snapshot.
  const leadSourceData = useMemo(() => leadsByChannelInRange(range, propertyKey), [range, propertyKey])
  const propertyRowsAll = useMemo(() => propertyBreakdownInRange(range), [range])
  const propertyRowsCompact = useMemo(
    () => (property === ALL_PROPERTIES ? propertyRowsAll : [{ name: property, leads: Math.round(totals.leads), moveIns: Math.round(totals.moveIns) }]),
    [property, propertyRowsAll, totals],
  )

  const sentimentCurrent = useMemo(() => computeSentimentBreakdown(reviewsAsOfEnd), [reviewsAsOfEnd])
  const sentimentPrev = useMemo(() => computeSentimentBreakdown(reviewsAsOfPrevEnd), [reviewsAsOfPrevEnd])
  const positivePctCurrent = sentimentCurrent.total > 0 ? (sentimentCurrent.positive / sentimentCurrent.total) * 100 : 0
  const positivePctPrev = sentimentPrev.total > 0 ? (sentimentPrev.positive / sentimentPrev.total) * 100 : 0

  // Reviews captured within the selected period, split by sentiment, feed
  // the AI analyst's topic detection so a rating change can say *why*.
  const reviewsInRange = useMemo(() => repFilterByRange(scopedReviews, range), [scopedReviews, range])

  // Budget/goal pacing, property/campaign standouts, SEO opportunities, lead
  // response time, and cross-platform reputation gaps — always computed
  // account-wide for the current calendar month, independent of this page's
  // own range/property filter, mirroring how shared/alerts.ts stays stable
  // regardless of whatever the user has selected.
  const monthRange = useMemo(() => thisMonth(), [])
  const monthCoverage = useMemo(() => monthCoverageFraction(monthRange), [monthRange])
  const gaMonthSpend = useMemo(() => gaSumTotals(gaFilterRange(dailyMetrics, monthRange)).spend, [monthRange])
  const yelpMonthSpend = useMemo(() => gaSumTotals(gaFilterRange(yelpDailyMetrics, monthRange)).spend, [monthRange])
  const totalMonthlyBudget = useMemo(() => Object.values(monthlyBudgetByProperty).reduce((a, b) => a + b, 0), [monthlyBudgetByProperty])
  const totalYelpMonthlyBudget = useMemo(() => Object.values(yelpMonthlyBudgetByProperty).reduce((a, b) => a + b, 0), [yelpMonthlyBudgetByProperty])
  const totalLeadGoal = useMemo(() => Object.values(leadGoalByProperty).reduce((a, b) => a + b, 0), [leadGoalByProperty])
  const monthLeadsTotal = useMemo(
    () => sumLeadTotals(filterByRange(dailyRowsForProperty(null), monthRange)).leads,
    [monthRange],
  )
  const campaignSummaries = useMemo(
    () => [
      ...initialCampaigns.map((c) => ({ name: c.name, facility: c.facility, platform: 'Google Ads', spend: c.spend, conversions: c.conversions, status: c.status })),
      ...yelpInitialCampaigns.map((c) => ({ name: c.name, facility: c.facility, platform: 'Yelp Ads', spend: c.spend, conversions: c.conversions, status: c.status })),
    ],
    [],
  )
  const seoOpportunity = useMemo(() => {
    const trackedNames = new Set(trackedKeywords.map((t) => t.keyword))
    const candidate = [...keywordDatabase].filter((k) => !trackedNames.has(k.keyword) && k.difficulty <= 40).sort((a, b) => b.volume - a.volume)[0]
    return candidate ? { keyword: candidate.keyword, volume: candidate.volume, difficulty: candidate.difficulty } : null
  }, [])
  const staleLeadsInfo = useMemo(() => {
    const stale = initialLeads.filter((l) => l.stage === 'New' && daysInStage(l, ANCHOR_DATE) >= 3)
    return { count: stale.length, oldestDays: stale.length > 0 ? Math.max(...stale.map((l) => daysInStage(l, ANCHOR_DATE))) : 0 }
  }, [])
  const reviewBacklogInfo = useMemo(() => {
    const pending = allReviews.filter((r) => r.status !== 'Posted')
    return { agingCount: pending.filter((r) => hoursSince(r.date) > 48).length }
  }, [])
  const platformRatingsInfo = useMemo(() => {
    const asOfAll = asOf(allReviews, range.end)
    return computeSourceSummary(asOfAll, asOfAll).map((s) => ({ platform: s.platform, rating: s.avgRating, reviews: s.reviews }))
  }, [range.end])

  // AI Marketing Analyst — synthesizes signals already computed above plus
  // SEO/Leads/GBP-content signals (account-wide, current snapshot) into
  // structured, explained insights. See insightEngine.ts.
  const insights = useMemo(() => {
    const trackedStats = computeTrackedStats(trackedKeywords)
    const worstDecliners = [...trackedKeywords]
      .map((tk) => ({ keyword: tk.keyword, delta: positionDelta(tk) }))
      .filter((d) => d.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 2)
      .map((d) => ({ keyword: d.keyword, delta: Math.abs(d.delta) }))

    const leadStats = computeLeadStats(initialLeads)

    const input = {
      sessions: { current: totals.sessions, previous: prevTotals.sessions },
      organicSessions: { current: totals.organicSessions, previous: prevTotals.organicSessions },
      leads: { current: totals.leads, previous: prevTotals.leads },
      leadToMoveInRate: { current: totals.leadToMoveInRate, previous: prevTotals.leadToMoveInRate },
      costPerLead: { current: costPerLead, previous: prevCostPerLead },
      gaSpend: { current: gaSpend, previous: gaPrevSpend },
      yelpSpend: { current: yelpSpend, previous: yelpPrevSpend },
      reviewRating: { current: reviewRating, previous: prevReviewRating },
      sentimentPositivePct: { current: positivePctCurrent, previous: positivePctPrev },
      nps: { current: totals.npsAvg, previous: prevTotals.npsAvg },
      recentPositiveReviewTexts: reviewsInRange.filter((r) => r.sentiment === 'Positive').map((r) => r.text),
      recentNegativeReviewTexts: reviewsInRange.filter((r) => r.sentiment === 'Negative').map((r) => r.text),
      seo: {
        trackedCount: trackedStats.count,
        avgPosition: trackedStats.avgPosition,
        improved: trackedStats.improved,
        declined: trackedStats.declined,
        worstDecliners,
      },
      gbp: {
        unansweredQuestions: unansweredCount(initialQuestions, ALL_PROPERTIES),
        stalePhotoProperties: stalePhotoProperties(initialPhotos),
      },
      leadsPipeline: { total: leadStats.total, unassigned: leadStats.unassigned },
      adPlatforms: {
        google: { costPerConv: gaSumTotals(gaRows).costPerConv },
        yelp: { costPerConv: gaSumTotals(yelpRows).costPerConv },
      },
      budgetPacing: {
        google: { budget: totalMonthlyBudget, spendMonthToDate: gaMonthSpend },
        yelp: { budget: totalYelpMonthlyBudget, spendMonthToDate: yelpMonthSpend },
        monthCoverage,
      },
      goalPacing: { goal: totalLeadGoal, leadsMonthToDate: monthLeadsTotal, monthCoverage },
      propertyRows: propertyRowsAll,
      campaigns: campaignSummaries,
      seoOpportunity,
      staleLeads: staleLeadsInfo,
      reviewBacklog: reviewBacklogInfo,
      platformRatings: platformRatingsInfo,
    }

    return generateInsights(input)
  }, [
    totals, prevTotals, costPerLead, prevCostPerLead, gaSpend, gaPrevSpend, yelpSpend, yelpPrevSpend,
    reviewRating, prevReviewRating, positivePctCurrent, positivePctPrev, reviewsInRange, gaRows, yelpRows,
    totalMonthlyBudget, totalYelpMonthlyBudget, gaMonthSpend, yelpMonthSpend, monthCoverage, totalLeadGoal,
    monthLeadsTotal, propertyRowsAll, campaignSummaries, seoOpportunity, staleLeadsInfo, reviewBacklogInfo, platformRatingsInfo,
  ])

  function buildDetail(key) {
    switch (key) {
      case 'totalLeads':
        return {
          kind: 'line',
          sectionTitle: 'Daily leads over selected range',
          data: rows.map((r) => ({ label: shortLabel(r.date), value: r.leads })),
        }
      case 'sessions':
        return {
          kind: 'line',
          sectionTitle: 'Daily sessions over selected range',
          data: rows.map((r) => ({ label: shortLabel(r.date), value: r.sessions })),
        }
      case 'leadToMoveInRate':
        return {
          kind: 'line',
          sectionTitle: 'Daily lead-to-move-in rate',
          data: rows.map((r) => ({ label: shortLabel(r.date), value: r.leads > 0 ? (r.moveIns / r.leads) * 100 : 0 })),
        }
      case 'costPerLead':
        return {
          kind: 'line',
          sectionTitle: 'Daily cost per lead (Google Ads spend ÷ leads)',
          data: rows.map((r) => {
            const gaRow = gaRows.find((g) => g.date === r.date)
            const spend = (gaRow?.spend ?? 0) * gaFacilityShare
            return { label: shortLabel(r.date), value: r.leads > 0 ? spend / r.leads : 0 }
          }),
        }
      case 'organicTraffic':
        return {
          kind: 'line',
          sectionTitle: 'Daily organic traffic',
          data: rows.map((r) => ({ label: shortLabel(r.date), value: r.organicSessions })),
        }
      case 'reviewRating': {
        const counts = [0, 0, 0, 0, 0]
        for (const r of reviewsAsOfEnd) counts[r.rating - 1]++
        return {
          kind: 'bar',
          sectionTitle: 'Rating distribution (all-time)',
          data: [5, 4, 3, 2, 1].map((star) => ({ label: `${star} star`, value: counts[star - 1] })),
          format: formatNumber,
        }
      }
      case 'nps': {
        const promoters = totals.promoterPctAvg
        const detractors = totals.detractorPctAvg
        const passives = Math.max(0, 100 - promoters - detractors)
        return {
          kind: 'bar',
          sectionTitle: `Respondent breakdown — NPS = promoters − detractors = ${Math.round(totals.npsAvg)}`,
          data: [
            { label: 'Promoters', value: promoters },
            { label: 'Passives', value: passives },
            { label: 'Detractors', value: detractors },
          ],
          format: (n) => formatPercent(n, 1),
        }
      }
    }
  }

  function downloadReport() {
    const rowsCsv = [
      ['Insights Report'],
      [`Range: ${formatRangeLabel(range)}`],
      [`Property: ${property}`],
      [],
      ['Metric', 'Value'],
      ['Total Leads', formatNumber(current.totalLeads)],
      ['Website Sessions', formatNumber(current.sessions)],
      ['Lead to Move-In Rate', formatPercent(current.leadToMoveInRate)],
      ['Cost per Lead', formatCurrency(current.costPerLead)],
      ['Organic Traffic', formatNumber(current.organicTraffic)],
      ['Review Rating (Avg.)', current.reviewRating.toFixed(1)],
      ['Net Promoter Score', Math.round(current.nps)],
      [],
      ['Lead Source', 'Leads'],
      ...leadSourceData.map((d) => [d.source, d.value]),
      [],
      ['Property', 'Leads', 'Move-Ins', 'Conversion Rate'],
      ...propertyRowsAll.map((p) => [p.name, p.leads, p.moveIns, p.leads > 0 ? `${((p.moveIns / p.leads) * 100).toFixed(1)}%` : '0.0%']),
    ]
    downloadCSV(`insights-report_${range.start}_${range.end}.csv`, rowsCsv)
  }

  const detail = selectedMetric ? buildDetail(selectedMetric.key) : null

  // "View" on an AI-analyst insight whose subject is already a KPI on this
  // page (traffic, NPS) opens that metric's own detail modal instead of
  // navigating nowhere — every "View" click always shows something.
  function handleViewMetric(key) {
    const def = KPI_CARD_DEFS.find((c) => c.key === key)
    if (def) setSelectedMetric({ key: def.key, label: def.label, format: def.format })
  }

  return (
    <div>
      <InsightsHeader
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
      />

      <KpiCards
        current={current}
        previous={previous}
        previousRange={previousRange}
        onSelectMetric={(key, label, format) => setSelectedMetric({ key, label, format })}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, marginBottom: 16, alignItems: 'stretch' }}>
        <div style={{ gridColumn: 'span 6' }}>
          <LeadsTrendChart rows={rows} prevRows={prevRows} />
        </div>
        <div style={{ gridColumn: 'span 4' }}>
          <ConversionFunnelCard sessions={totals.sessions} leads={totals.leads} moveIns={totals.moveIns} />
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <RatingTrendCard reviews={reviewsAsOfEnd} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, marginBottom: 16, alignItems: 'stretch' }}>
        <div style={{ gridColumn: 'span 6' }}>
          <LeadSourceCard rows={leadSourceData} />
        </div>
        <div style={{ gridColumn: 'span 6' }}>
          <TopPropertiesCard rows={propertyRowsCompact} allRows={propertyRowsAll} onSelectProperty={onPropertyChange} />
        </div>
      </div>

      <div style={{ borderRadius: 12, transition: 'box-shadow .15s', boxShadow: highlightAnalyst ? '0 0 0 2px #c084fc' : 'none' }} ref={analystRef}>
        <InsightsPanel insights={insights} onNavigate={onNavigate} onViewMetric={handleViewMetric} />
      </div>

      {showSetGoals && (
        <SetGoalsModal
          facilities={FACILITIES}
          leadGoalByProperty={leadGoalByProperty}
          onChangeLeadGoal={onChangeLeadGoal}
          onClose={() => setShowSetGoals(false)}
        />
      )}

      {selectedMetric && detail && (
        <InsightDetailModal
          label={selectedMetric.label}
          kind={detail.kind}
          sectionTitle={detail.sectionTitle}
          data={detail.data}
          format={detail.format ?? selectedMetric.format}
          onClose={() => setSelectedMetric(null)}
        />
      )}

      {compareSelection && (
        <PropertyComparisonModal
          title="Compare Properties — Insights"
          rows={propertyRowsAll.filter((r) => compareSelection.includes(r.name))}
          columns={COMPARISON_COLUMNS}
          onClose={() => setCompareSelection(null)}
        />
      )}
    </div>
  )
}
