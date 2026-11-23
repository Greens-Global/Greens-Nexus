import { useMemo, useState } from 'react'
import StatCards from '../reputation/StatCards'
import StatDetailModal from '../reputation/StatDetailModal'
import WordCloudCard from '../reputation/WordCloudCard'
import SentimentDonut from '../reputation/SentimentDonut'
import RatingTrendCard from '../reputation/RatingTrendCard'
import {
  asOf,
  computeLifetimeStats,
  computePeriodStats,
  computeSentimentBreakdown,
  computeSourceSummary,
  computeWordFrequency,
  filterByRange,
} from '../reputation/aggregate'
import { formatMonthLabel } from '../shared/utils'
import { lastDaysFrom, realMonths, trailingMonths } from './reviewFeed'

const CLOUD_DAYS = 90

// The charts the sample Reputation page has, drawn from the real Google
// reviews once Google is connected (gbp/reviewFeed.js) and dated by the real
// calendar: this month against last month, the last 12 months of ratings,
// and what customers wrote in the last 90 days. A cloud word searches the
// review list below (GbpTab holds that search).
export default function ReputationOverview({ reviews, locationNames = [], activeWord, onSelectWord }) {
  const [selectedStat, setSelectedStat] = useState(null)
  const months = useMemo(() => realMonths(), [])

  const asOfToday = useMemo(() => asOf(reviews, months.today), [reviews, months])
  const lifetime = useMemo(() => computeLifetimeStats(asOfToday), [asOfToday])
  const lifetimePrev = useMemo(() => computeLifetimeStats(asOf(reviews, months.previous.end)), [reviews, months])
  const inMonth = useMemo(() => filterByRange(reviews, months.current), [reviews, months])
  const monthStats = useMemo(() => computePeriodStats(inMonth), [inMonth])
  const prevMonthStats = useMemo(() => computePeriodStats(filterByRange(reviews, months.previous)), [reviews, months])
  const sentiment = useMemo(() => computeSentimentBreakdown(asOfToday), [asOfToday])
  const trend = useMemo(() => filterByRange(reviews, trailingMonths(months.today, 12)), [reviews, months])
  const words = useMemo(
    () => computeWordFrequency(filterByRange(reviews, lastDaysFrom(months.today, CLOUD_DAYS)), { exclude: locationNames }),
    [reviews, months, locationNames],
  )
  // Google is the only source connected - the other platforms would read as zero.
  const sources = useMemo(
    () => computeSourceSummary(asOfToday, asOf(reviews, months.previous.end)).filter((s) => s.reviews > 0),
    [asOfToday, reviews, months],
  )

  return (
    <div className="mktg-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, alignItems: 'start', marginBottom: 16 }}>
      <div style={{ gridColumn: 'span 9', minWidth: 0 }}>
        <div className="mktg-cols-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
          <StatCards
            overallRating={lifetime.overallRating}
            prevOverallRating={lifetimePrev.overallRating || lifetime.overallRating}
            totalReviews={lifetime.totalReviews}
            prevTotalReviews={lifetimePrev.totalReviews}
            newReviews={monthStats.newReviews}
            prevNewReviews={prevMonthStats.newReviews}
            pending={monthStats.pending}
            prevPending={prevMonthStats.pending}
            previousMonthLabel={formatMonthLabel(months.previous.start)}
            onSelectStat={(key, label) => setSelectedStat({ key, label })}
          />
        </div>
        <WordCloudCard
          words={words}
          activeWord={activeWord || null}
          onSelectWord={onSelectWord}
          description={`What customers wrote most in the last ${CLOUD_DAYS} days, across every location. Size = frequency; red leans negative, green leans positive. Click a word to search the reviews below.`}
        />
      </div>
      <div style={{ gridColumn: 'span 3', display: 'grid', gap: 16, alignContent: 'start', minWidth: 0 }}>
        <SentimentDonut breakdown={sentiment} />
        <RatingTrendCard reviews={trend} />
      </div>

      {selectedStat && (
        <StatDetailModal
          statKey={selectedStat.key}
          label={selectedStat.label}
          reviewsAsOfEnd={asOfToday}
          reviewsInMonth={inMonth}
          sourceSummary={sources}
          onClose={() => setSelectedStat(null)}
        />
      )}
    </div>
  )
}
