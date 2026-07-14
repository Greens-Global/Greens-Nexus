import { thisMonth } from './utils'
import { filterRange as gaFilterRange, sumTotals as gaSumTotals } from '../googleAds/aggregate'
import { dailyMetrics } from '../googleAds/data'
import { yelpDailyMetrics } from '../googleAds/yelpData'
import { allReviews } from '../reputation/data'
import { hoursSince } from '../reputation/aggregate'
import { initialQuestions, initialPhotos } from '../reputation/gbpContentData'
import { initialYelpQuestions, initialYelpPhotos } from '../reputation/yelpContentData'
import { unansweredCount, stalePhotoProperties } from '../reputation/gbpContentAggregate'
import { ALL_PROPERTIES } from './facilities'
import { dailyLeadMetrics } from '../insights/data'
import { filterByRange as insFilterByRange, sumLeadTotals } from '../insights/aggregate'

// Alerts are always computed account-wide (all properties) for the current
// calendar month, independent of whatever date range/property filter the
// user currently has selected — a notification backlog should be stable,
// not change every time you tweak a report filter.
export function computeAlerts({ monthlyBudget, yelpMonthlyBudget, leadGoal }) {
  const alerts = []
  const month = thisMonth()

  const gaTotals = gaSumTotals(gaFilterRange(dailyMetrics, month))
  const budgetPct = monthlyBudget > 0 ? (gaTotals.spend / monthlyBudget) * 100 : 0
  if (budgetPct >= 100) {
    alerts.push({
      id: 'budget-over',
      severity: 'critical',
      title: 'Monthly budget exceeded',
      message: `Google Ads spend is $${Math.round(gaTotals.spend).toLocaleString()}, ${Math.round(budgetPct - 100)}% over your $${monthlyBudget.toLocaleString()} budget.`,
      tab: 'google-ads',
    })
  } else if (budgetPct >= 90) {
    alerts.push({
      id: 'budget-warning',
      severity: 'warning',
      title: 'Budget nearly exhausted',
      message: `You've used ${Math.round(budgetPct)}% of this month's $${monthlyBudget.toLocaleString()} Google Ads budget.`,
      tab: 'google-ads',
    })
  }

  const yelpTotals = gaSumTotals(gaFilterRange(yelpDailyMetrics, month))
  const yelpBudgetPct = yelpMonthlyBudget > 0 ? (yelpTotals.spend / yelpMonthlyBudget) * 100 : 0
  if (yelpBudgetPct >= 100) {
    alerts.push({
      id: 'yelp-budget-over',
      severity: 'critical',
      title: 'Monthly Yelp budget exceeded',
      message: `Yelp Ads spend is $${Math.round(yelpTotals.spend).toLocaleString()}, ${Math.round(yelpBudgetPct - 100)}% over your $${yelpMonthlyBudget.toLocaleString()} budget.`,
      tab: 'google-ads',
    })
  } else if (yelpBudgetPct >= 90) {
    alerts.push({
      id: 'yelp-budget-warning',
      severity: 'warning',
      title: 'Yelp budget nearly exhausted',
      message: `You've used ${Math.round(yelpBudgetPct)}% of this month's $${yelpMonthlyBudget.toLocaleString()} Yelp Ads budget.`,
      tab: 'google-ads',
    })
  }

  const pendingReviews = allReviews.filter((r) => r.status !== 'Posted')
  const agingPending = pendingReviews.filter((r) => hoursSince(r.date) > 48)
  const lowRatingPending = pendingReviews.filter((r) => r.rating <= 2)

  if (lowRatingPending.length > 0) {
    alerts.push({
      id: 'low-rating-pending',
      severity: 'critical',
      title: 'Low-rating review awaiting reply',
      message: `${lowRatingPending.length} review${lowRatingPending.length === 1 ? '' : 's'} at 2★ or below ${
        lowRatingPending.length === 1 ? 'is' : 'are'
      } still unanswered.`,
      tab: 'reputation',
    })
  }
  if (agingPending.length > 0) {
    alerts.push({
      id: 'pending-aging',
      severity: 'warning',
      title: 'Replies overdue',
      message: `${agingPending.length} review${agingPending.length === 1 ? '' : 's'} ${
        agingPending.length === 1 ? 'has' : 'have'
      } been waiting over 48 hours for a reply.`,
      tab: 'reputation',
    })
  } else if (pendingReviews.length > 0) {
    alerts.push({
      id: 'pending-open',
      severity: 'info',
      title: 'Reviews awaiting reply',
      message: `${pendingReviews.length} review${pendingReviews.length === 1 ? '' : 's'} ${
        pendingReviews.length === 1 ? 'is' : 'are'
      } awaiting a response.`,
      tab: 'reputation',
    })
  }

  const unansweredQuestions = unansweredCount(initialQuestions, ALL_PROPERTIES)
  if (unansweredQuestions > 0) {
    alerts.push({
      id: 'qna-unanswered',
      severity: 'warning',
      title: 'Q&A questions awaiting an answer',
      message: `${unansweredQuestions} question${unansweredQuestions === 1 ? '' : 's'} on your Business Profile listings ${
        unansweredQuestions === 1 ? 'has' : 'have'
      } no answer yet.`,
      tab: 'listings',
    })
  }

  const staleProperties = stalePhotoProperties(initialPhotos)
  if (staleProperties.length > 0) {
    alerts.push({
      id: 'photos-stale',
      severity: 'info',
      title: 'Listing photos need refreshing',
      message: `${staleProperties.length} propert${staleProperties.length === 1 ? 'y hasn\'t' : 'ies haven\'t'} added a new Business Profile photo in 60+ days.`,
      tab: 'listings',
    })
  }

  const unansweredYelpQuestions = unansweredCount(initialYelpQuestions, ALL_PROPERTIES)
  if (unansweredYelpQuestions > 0) {
    alerts.push({
      id: 'yelp-qna-unanswered',
      severity: 'warning',
      title: 'Yelp Q&A questions awaiting an answer',
      message: `${unansweredYelpQuestions} question${unansweredYelpQuestions === 1 ? '' : 's'} on your Yelp Business Page ${
        unansweredYelpQuestions === 1 ? 'has' : 'have'
      } no answer yet.`,
      tab: 'listings',
    })
  }

  const staleYelpProperties = stalePhotoProperties(initialYelpPhotos)
  if (staleYelpProperties.length > 0) {
    alerts.push({
      id: 'yelp-photos-stale',
      severity: 'info',
      title: 'Yelp listing photos need refreshing',
      message: `${staleYelpProperties.length} propert${staleYelpProperties.length === 1 ? 'y hasn\'t' : 'ies haven\'t'} added a new Yelp photo in 60+ days.`,
      tab: 'listings',
    })
  }

  const monthRows = insFilterByRange(dailyLeadMetrics, month)
  const monthTotals = sumLeadTotals(monthRows)
  const goalPct = leadGoal > 0 ? (monthTotals.leads / leadGoal) * 100 : 0
  if (goalPct < 90) {
    alerts.push({
      id: 'goal-miss',
      severity: 'warning',
      title: 'Lead goal at risk',
      message: `${Math.round(monthTotals.leads)} of ${leadGoal.toLocaleString()} monthly leads reached (${Math.round(goalPct)}%).`,
      tab: 'insights',
    })
  } else if (goalPct >= 100) {
    alerts.push({
      id: 'goal-hit',
      severity: 'info',
      title: 'Lead goal reached',
      message: `${Math.round(monthTotals.leads)} leads this month, ${Math.round(goalPct - 100)}% above your ${leadGoal.toLocaleString()} goal.`,
      tab: 'insights',
    })
  }

  return alerts
}
