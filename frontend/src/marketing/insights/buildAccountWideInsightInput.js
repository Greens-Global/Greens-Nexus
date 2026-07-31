import { dailyRowsForProperty, filterByRange, sumLeadTotals, propertyBreakdownInRange } from './aggregate'
import { filterRange as gaFilterRange, sumTotals as gaSumTotals } from '../googleAds/aggregate'
import { dailyMetrics, initialCampaigns } from '../googleAds/data'
import { allReviews } from '../reputation/data'
import { asOf, computeLifetimeStats, computeSentimentBreakdown, computeSourceSummary, hoursSince, filterByRange as repFilterByRange } from '../reputation/aggregate'
import { initialQuestions, initialPhotos } from '../reputation/gbpContentData'
import { unansweredCount, stalePhotoProperties } from '../reputation/gbpContentAggregate'
import { trackedKeywords, keywordDatabase } from '../seo/data'
import { computeTrackedStats, positionDelta } from '../seo/aggregate'
import { initialLeads } from '../leads/data'
import { computeLeadStats, daysInStage } from '../leads/aggregate'
import { ALL_PROPERTIES } from '../shared/facilities'
import { ANCHOR_DATE, monthCoverageFraction, thisMonth, lastMonth } from '../shared/utils'

// A self-contained, account-wide "this month vs. last month" snapshot -
// mirrors shared/alerts.ts's pattern exactly (always the current calendar
// month, always all properties) so the AI Analyst button in the tab bar can
// show something meaningful from anywhere in the app, independent of
// whatever range/property filter the interactive Insights page happens to
// have selected. Feeds the same generateInsights() rules used there.
export function buildAccountWideInsightInput(params) {
  const range = thisMonth()
  const previousRange = lastMonth()
  const monthCoverage = monthCoverageFraction(range)

  const rows = filterByRange(dailyRowsForProperty(null), range)
  const prevRows = filterByRange(dailyRowsForProperty(null), previousRange)
  const totals = sumLeadTotals(rows)
  const prevTotals = sumLeadTotals(prevRows)

  const gaRows = gaFilterRange(dailyMetrics, range)
  const gaPrevRows = gaFilterRange(dailyMetrics, previousRange)

  const gaSpend = gaSumTotals(gaRows).spend
  const gaPrevSpend = gaSumTotals(gaPrevRows).spend

  const costPerLead = totals.leads > 0 ? gaSpend / totals.leads : 0
  const prevCostPerLead = prevTotals.leads > 0 ? gaPrevSpend / prevTotals.leads : 0

  const reviewsAsOfEnd = asOf(allReviews, range.end)
  const reviewsAsOfPrevEnd = asOf(allReviews, previousRange.end)
  const reviewRating = computeLifetimeStats(reviewsAsOfEnd).overallRating
  const prevReviewRating = computeLifetimeStats(reviewsAsOfPrevEnd).overallRating

  const sentimentCurrent = computeSentimentBreakdown(reviewsAsOfEnd)
  const sentimentPrev = computeSentimentBreakdown(reviewsAsOfPrevEnd)
  const positivePctCurrent = sentimentCurrent.total > 0 ? (sentimentCurrent.positive / sentimentCurrent.total) * 100 : 0
  const positivePctPrev = sentimentPrev.total > 0 ? (sentimentPrev.positive / sentimentPrev.total) * 100 : 0

  const reviewsInRange = repFilterByRange(allReviews, range)

  const trackedStats = computeTrackedStats(trackedKeywords)
  const worstDecliners = [...trackedKeywords]
    .map((tk) => ({ keyword: tk.keyword, delta: positionDelta(tk) }))
    .filter((d) => d.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 2)
    .map((d) => ({ keyword: d.keyword, delta: Math.abs(d.delta) }))

  const leadStats = computeLeadStats(initialLeads)

  const totalMonthlyBudget = Object.values(params.monthlyBudgetByProperty).reduce((a, b) => a + b, 0)
  const totalLeadGoal = Object.values(params.leadGoalByProperty).reduce((a, b) => a + b, 0)

  const seoOpportunityCandidate = (() => {
    const trackedNames = new Set(trackedKeywords.map((t) => t.keyword))
    const candidate = [...keywordDatabase].filter((k) => !trackedNames.has(k.keyword) && k.difficulty <= 40).sort((a, b) => b.volume - a.volume)[0]
    return candidate ? { keyword: candidate.keyword, volume: candidate.volume, difficulty: candidate.difficulty } : null
  })()

  const staleLeads = (() => {
    const stale = initialLeads.filter((l) => l.stage === 'New' && daysInStage(l, ANCHOR_DATE) >= 3)
    return { count: stale.length, oldestDays: stale.length > 0 ? Math.max(...stale.map((l) => daysInStage(l, ANCHOR_DATE))) : 0 }
  })()

  const reviewBacklog = (() => {
    const pending = allReviews.filter((r) => r.status !== 'Posted')
    return { agingCount: pending.filter((r) => hoursSince(r.date) > 48).length }
  })()

  const platformRatings = computeSourceSummary(reviewsAsOfEnd, reviewsAsOfEnd).map((s) => ({ platform: s.platform, rating: s.avgRating, reviews: s.reviews }))

  const campaigns = initialCampaigns.map((c) => ({ name: c.name, facility: c.facility, platform: 'Google Ads', spend: c.spend, conversions: c.conversions, status: c.status }))

  return {
    sessions: { current: totals.sessions, previous: prevTotals.sessions },
    organicSessions: { current: totals.organicSessions, previous: prevTotals.organicSessions },
    leads: { current: totals.leads, previous: prevTotals.leads },
    leadToMoveInRate: { current: totals.leadToMoveInRate, previous: prevTotals.leadToMoveInRate },
    costPerLead: { current: costPerLead, previous: prevCostPerLead },
    gaSpend: { current: gaSpend, previous: gaPrevSpend },
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
    budgetPacing: {
      google: { budget: totalMonthlyBudget, spendMonthToDate: gaSpend },
      monthCoverage,
    },
    goalPacing: { goal: totalLeadGoal, leadsMonthToDate: totals.leads, monthCoverage },
    propertyRows: propertyBreakdownInRange(range),
    campaigns,
    seoOpportunity: seoOpportunityCandidate,
    staleLeads,
    reviewBacklog,
    platformRatings,
  }
}
