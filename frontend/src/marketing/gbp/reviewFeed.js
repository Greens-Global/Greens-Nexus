import { addDays, monthRange, toISO } from '../shared/utils'

// The real Google reviews (GET /marketing/gbp/reviews/feed), in the shape the
// sample reviews have (reputation/data.js), so the same math in
// reputation/aggregate.js and the same cards chart them. Sentiment comes from
// the stars - Google gives no sentiment, and a rule this simple is one anyone
// can check. The sample module runs on a frozen 2025 clock (shared/utils
// ANCHOR_DATE); real reviews are dated by the real calendar, see realMonths.

export function sentimentOf(rating) {
  return rating >= 4 ? 'Positive' : rating === 3 ? 'Neutral' : 'Negative'
}

export function toReputationReviews(rows) {
  return (rows || [])
    .filter((r) => r.rating >= 1 && r.rating <= 5 && r.createdAt)
    .map((r) => {
      const hours = r.replied && r.repliedAt
        ? (new Date(r.repliedAt).getTime() - new Date(r.createdAt).getTime()) / 3_600_000
        : null
      return {
        id: r.id,
        platform: 'Google',
        customer: r.reviewer || 'Google User',
        rating: r.rating,
        text: r.text || '',
        facility: r.facility || '',
        date: r.createdAt,
        sentiment: sentimentOf(r.rating),
        status: r.replied ? 'Posted' : 'Awaiting Reply',
        // A reply edited later in Google moves its time; never below zero.
        responseHours: hours === null || Number.isNaN(hours) ? null : Math.max(0, Math.round(hours * 10) / 10),
      }
    })
}

// This calendar month and the one before, from a real day (default today).
export function realMonths(today = new Date()) {
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()
  return { current: monthRange(y, m), previous: monthRange(y, m - 1), today: toISO(today) }
}

// The last `months` calendar months up to `todayISO`, for the rating trend.
export function trailingMonths(todayISO, months = 12) {
  const [y, m] = todayISO.split('-').map(Number)
  return { start: monthRange(y, m - 1 - (months - 1)).start, end: todayISO }
}

// Days back from a real day, for the word cloud's window.
export function lastDaysFrom(todayISO, days) {
  return { start: addDays(todayISO, -(days - 1)), end: todayISO }
}
