import { describe, expect, it } from 'vitest'
import { lastDaysFrom, realMonths, sentimentOf, toReputationReviews, trailingMonths } from './reviewFeed'
import { computeLifetimeStats, computePeriodStats, filterByRange } from '../reputation/aggregate'

const row = (over) => ({
  id: 'a', facility: 'Greens Fresno', reviewer: 'Ana B', rating: 5, text: 'Clean and safe',
  createdAt: '2026-11-02T10:00:00Z', replied: false, repliedAt: '', ...over,
})

describe('toReputationReviews', () => {
  it('maps a Google review into the sample review shape', () => {
    const [r] = toReputationReviews([row({ replied: true, repliedAt: '2026-11-03T16:00:00Z' })])
    expect(r).toEqual({
      id: 'a', platform: 'Google', customer: 'Ana B', rating: 5, text: 'Clean and safe', facility: 'Greens Fresno',
      date: '2026-11-02T10:00:00Z', sentiment: 'Positive', status: 'Posted', responseHours: 30,
    })
  })

  it('keeps unreplied reviews pending, names the anonymous and drops unrated rows', () => {
    const out = toReputationReviews([row({ reviewer: '', rating: 2 }), row({ id: 'b', rating: 0 }), row({ id: 'c', createdAt: '' })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ customer: 'Google User', sentiment: 'Negative', status: 'Awaiting Reply', responseHours: null })
  })

  it('never reports a negative response time', () => {
    const [r] = toReputationReviews([row({ replied: true, repliedAt: '2026-11-01T00:00:00Z' })])
    expect(r.responseHours).toBe(0)
  })

  it('feeds the existing reputation math', () => {
    const reviews = toReputationReviews([row(), row({ id: 'b', rating: 3, replied: true, repliedAt: '2026-11-02T12:00:00Z' })])
    expect(computeLifetimeStats(reviews).overallRating).toBe(4)
    expect(computePeriodStats(filterByRange(reviews, { start: '2026-11-01', end: '2026-11-30' }))).toMatchObject({ newReviews: 2, pending: 1 })
  })
})

describe('real calendar helpers', () => {
  it('sentiment follows the stars', () => {
    expect([5, 4, 3, 2, 1].map(sentimentOf)).toEqual(['Positive', 'Positive', 'Neutral', 'Negative', 'Negative'])
  })

  it('this month and last, across a year end', () => {
    expect(realMonths(new Date(Date.UTC(2026, 0, 15)))).toEqual({
      current: { start: '2026-01-01', end: '2026-01-31' },
      previous: { start: '2025-12-01', end: '2025-12-31' },
      today: '2026-01-15',
    })
  })

  it('trailing months and days', () => {
    expect(trailingMonths('2026-11-18', 12)).toEqual({ start: '2025-12-01', end: '2026-11-18' })
    expect(lastDaysFrom('2026-11-18', 90)).toEqual({ start: '2026-08-21', end: '2026-11-18' })
  })
})
