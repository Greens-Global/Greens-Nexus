import { ANCHOR_DATE } from '../shared/utils'
import { FACILITIES } from '../shared/facilities'

export function hoursSince(dateISO) {
  const hours = (new Date(ANCHOR_DATE + 'T18:00:00Z').getTime() - new Date(dateISO).getTime()) / 3_600_000
  return Math.max(0.2, Math.round(hours * 10) / 10)
}

export function filterByRange(reviews, range) {
  return reviews.filter((r) => {
    const day = r.date.slice(0, 10)
    return day >= range.start && day <= range.end
  })
}

export function asOf(reviews, cutoffISODate) {
  return reviews.filter((r) => r.date.slice(0, 10) <= cutoffISODate)
}

export function computePeriodStats(reviewsInRange) {
  const posted = reviewsInRange.filter((r) => r.status === 'Posted')
  return {
    newReviews: reviewsInRange.length,
    pending: reviewsInRange.filter((r) => r.status !== 'Posted').length,
    autoReplied: posted.length,
    avgResponseHours: posted.length > 0 ? posted.reduce((a, r) => a + (r.responseHours ?? 0), 0) / posted.length : 0,
  }
}

export function computeLifetimeStats(reviewsAsOf) {
  const totalReviews = reviewsAsOf.length
  const overallRating = totalReviews > 0 ? reviewsAsOf.reduce((a, r) => a + r.rating, 0) / totalReviews : 0
  return { overallRating, totalReviews }
}

export function computeSentimentBreakdown(reviewsAsOf) {
  return {
    positive: reviewsAsOf.filter((r) => r.sentiment === 'Positive').length,
    neutral: reviewsAsOf.filter((r) => r.sentiment === 'Neutral').length,
    negative: reviewsAsOf.filter((r) => r.sentiment === 'Negative').length,
    total: reviewsAsOf.length,
  }
}

const ALL_PLATFORMS = ['Google', 'Facebook', 'Storage Facility Finder', 'Other']

export function computeSourceSummary(currentAsOf, previousAsOf) {
  return ALL_PLATFORMS.map((platform) => {
    const rows = currentAsOf.filter((r) => r.platform === platform)
    const prevRows = previousAsOf.filter((r) => r.platform === platform)
    const avgRating = rows.length > 0 ? rows.reduce((a, r) => a + r.rating, 0) / rows.length : 0
    const prevAvg = prevRows.length > 0 ? prevRows.reduce((a, r) => a + r.rating, 0) / prevRows.length : avgRating
    return { platform, reviews: rows.length, avgRating, trend: avgRating - prevAvg }
  })
}

export function propertyBreakdownInRange(allReviews, range) {
  return FACILITIES.map((name) => {
    const scoped = allReviews.filter((r) => r.facility === name)
    const lifetime = computeLifetimeStats(asOf(scoped, range.end))
    const period = computePeriodStats(filterByRange(scoped, range))
    return { name, rating: lifetime.overallRating, totalReviews: lifetime.totalReviews, newReviews: period.newReviews, pending: period.pending }
  })
}
