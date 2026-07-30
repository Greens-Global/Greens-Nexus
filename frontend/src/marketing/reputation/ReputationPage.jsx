import { useMemo, useRef, useState } from 'react'
import ReputationHeader from './ReputationHeader'
import StatCards from './StatCards'
import ReviewsFeedCard from './ReviewsFeedCard'
import SentimentDonut from './SentimentDonut'
import RatingTrendCard from './RatingTrendCard'
import StatDetailModal from './StatDetailModal'
import WordCloudCard from './WordCloudCard'
import { allReviews, FACILITIES } from './data'
import { generateAiReply, replyVariationCount } from './aiReplyEngine'
import {
  asOf,
  computeLifetimeStats,
  computePeriodStats,
  computeSentimentBreakdown,
  computeSourceSummary,
  computeWordFrequency,
  filterByRange,
  filterReviews,
  hoursSince,
  propertyBreakdownInRange,
} from './aggregate'
import { ALL_PROPERTIES } from '../shared/facilities'
import PropertyComparisonModal from '../shared/PropertyComparisonModal'
import {
  downloadCSV,
  formatDateLabel,
  formatMonthLabel,
  formatRangeLabel,
  monthRange,
  parseISO,
} from '../shared/utils'

const COMPARISON_COLUMNS = [
  { key: 'rating', label: 'Rating', value: (r) => r.rating, format: (r) => `${r.rating.toFixed(1)} ★`, highlight: true },
  { key: 'totalReviews', label: 'Total Reviews', value: (r) => r.totalReviews, format: (r) => String(r.totalReviews) },
  { key: 'newReviews', label: 'New Reviews', value: (r) => r.newReviews, format: (r) => String(r.newReviews) },
  { key: 'pending', label: 'Pending Replies', value: (r) => r.pending, format: (r) => String(r.pending) },
]

export default function ReputationPage({ range, onRangeChange, property, onPropertyChange, onNavigate, alerts, insights, onClearAlert }) {
  const [reviews, setReviews] = useState(allReviews)
  const [selectedStat, setSelectedStat] = useState(null)
  const [compareSelection, setCompareSelection] = useState(null)
  const [reviewStatusFilter, setReviewStatusFilter] = useState('Pending')
  const [reviewPlatformFilter, setReviewPlatformFilter] = useState('All')
  const [reviewRatingFilter, setReviewRatingFilter] = useState('All')
  const [reviewQuery, setReviewQuery] = useState('')
  const feedRef = useRef(null)

  // Clicking a cloud word only means something if the matching review is
  // actually visible afterward - forcing the status filter to "All" (the feed
  // defaults to "Pending Replies" only) and scrolling the feed into view is
  // what makes this feel like "take me to that comment" instead of quietly
  // filtering a list the user has to go find on their own.
  function selectCloudWord(word) {
    setReviewQuery(word || '')
    if (word) {
      setReviewStatusFilter('All')
      feedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const comparisonRows = useMemo(() => propertyBreakdownInRange(allReviews, range), [range])

  const scopedReviews = useMemo(
    () => (property === ALL_PROPERTIES ? reviews : reviews.filter((r) => r.facility === property)),
    [reviews, property],
  )

  const reviewsInRange = useMemo(() => filterByRange(scopedReviews, range), [scopedReviews, range])

  const periodStats = useMemo(() => computePeriodStats(reviewsInRange), [reviewsInRange])

  const currentMonthRange = useMemo(() => {
    const d = parseISO(range.end)
    return monthRange(d.getUTCFullYear(), d.getUTCMonth())
  }, [range.end])
  const prevMonthRange = useMemo(() => {
    const d = parseISO(range.end)
    return monthRange(d.getUTCFullYear(), d.getUTCMonth() - 1)
  }, [range.end])
  const previousMonthLabel = useMemo(() => formatMonthLabel(prevMonthRange.start), [prevMonthRange])

  // Stat cards always compare the current calendar month against the
  // previous one, independent of whatever range is selected in the date
  // picker (which only scopes the reviews feed / CSV export below).
  const reviewsInCurrentMonth = useMemo(() => filterByRange(scopedReviews, currentMonthRange), [scopedReviews, currentMonthRange])
  const monthStats = useMemo(() => computePeriodStats(reviewsInCurrentMonth), [reviewsInCurrentMonth])
  const prevMonthStats = useMemo(
    () => computePeriodStats(filterByRange(scopedReviews, prevMonthRange)),
    [scopedReviews, prevMonthRange],
  )

  const reviewsAsOfEnd = useMemo(() => asOf(scopedReviews, range.end), [scopedReviews, range.end])
  const lifetimeCurrent = useMemo(() => computeLifetimeStats(reviewsAsOfEnd), [reviewsAsOfEnd])
  const lifetimePrevious = useMemo(() => computeLifetimeStats(asOf(scopedReviews, prevMonthRange.end)), [scopedReviews, prevMonthRange.end])

  const sentiment = useMemo(() => computeSentimentBreakdown(reviewsAsOfEnd), [reviewsAsOfEnd])

  const feedFilteredReviews = useMemo(
    () => filterReviews(reviewsInRange, { status: reviewStatusFilter, platform: reviewPlatformFilter, rating: reviewRatingFilter, query: reviewQuery }),
    [reviewsInRange, reviewStatusFilter, reviewPlatformFilter, reviewRatingFilter, reviewQuery],
  )
  // Deliberately built from the whole date+property range, not the feed's
  // active filters - a cloud that shrinks every time you filter the feed (and
  // that includes the just-clicked word in its own query) collapses on
  // itself. One stable overview; clicking a word only drills into the feed.
  const wordFrequency = useMemo(() => computeWordFrequency(reviewsInRange), [reviewsInRange])
  const sourceSummary = useMemo(
    () => computeSourceSummary(asOf(scopedReviews, range.end), asOf(scopedReviews, prevMonthRange.end)),
    [scopedReviews, range.end, prevMonthRange.end],
  )

  function handleApprove(id, finalText) {
    setReviews((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              status: 'Posted',
              aiReply: finalText,
              wasEdited: finalText.trim() !== r.aiReply.trim(),
              responseHours: hoursSince(r.date),
            }
          : r,
      ),
    )
  }

  function handleRegenerate(id) {
    setReviews((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r
        const nextIndex = (r.draftIndex + 1) % replyVariationCount()
        const firstName = r.customer.split(' ')[0]
        const aiReply = generateAiReply({
          sentiment: r.sentiment,
          facility: r.facility,
          name: firstName,
          reviewText: r.text,
          variantIndex: nextIndex,
        })
        return { ...r, draftIndex: nextIndex, aiReply }
      }),
    )
  }

  function downloadReport() {
    const rows = [
      ['Reputation Management Report'],
      [`Range: ${formatRangeLabel(range)}`],
      [`Property: ${property}`],
      [],
      ['Metric', 'Value'],
      ['Overall Rating', lifetimeCurrent.overallRating.toFixed(1)],
      ['Total Reviews', lifetimeCurrent.totalReviews],
      ['New Reviews', periodStats.newReviews],
      ['Pending Replies', periodStats.pending],
      ['Auto-Replied by AI', periodStats.autoReplied],
      ['Average Response Time (hrs)', periodStats.avgResponseHours.toFixed(1)],
      [],
      ['Platform', 'Reviews', 'Avg Rating', 'Trend'],
      ...sourceSummary.map((s) => [s.platform, s.reviews, s.avgRating.toFixed(1), s.trend.toFixed(1)]),
      [],
      ['Customer', 'Platform', 'Rating', 'Facility', 'Date', 'Sentiment', 'Status'],
      ...reviewsInRange.map((r) => [r.customer, r.platform, r.rating, r.facility, formatDateLabel(r.date.slice(0, 10)), r.sentiment, r.status]),
    ]
    downloadCSV(`reputation-report_${range.start}_${range.end}.csv`, rows)
  }

  return (
    <div>
      <ReputationHeader
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: 16, alignItems: 'start' }}>
        <div style={{ gridColumn: 'span 10' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 16 }}>
            <StatCards
              overallRating={lifetimeCurrent.overallRating}
              prevOverallRating={lifetimePrevious.overallRating}
              totalReviews={lifetimeCurrent.totalReviews}
              prevTotalReviews={lifetimePrevious.totalReviews}
              newReviews={monthStats.newReviews}
              prevNewReviews={prevMonthStats.newReviews}
              pending={monthStats.pending}
              prevPending={prevMonthStats.pending}
              previousMonthLabel={previousMonthLabel}
              onSelectStat={(key, label) => setSelectedStat({ key, label })}
            />
          </div>

          <WordCloudCard
            words={wordFrequency}
            activeWord={reviewQuery || null}
            onSelectWord={selectCloudWord}
          />

          <div ref={feedRef}>
            <ReviewsFeedCard
              reviews={reviewsInRange}
              onApprove={handleApprove}
              onRegenerate={handleRegenerate}
              statusFilter={reviewStatusFilter}
              onStatusFilterChange={setReviewStatusFilter}
              platformFilter={reviewPlatformFilter}
              onPlatformFilterChange={setReviewPlatformFilter}
              ratingFilter={reviewRatingFilter}
              onRatingFilterChange={setReviewRatingFilter}
              query={reviewQuery}
              onQueryChange={setReviewQuery}
            />
          </div>
        </div>

        <div style={{ gridColumn: 'span 2', display: 'grid', gridTemplateColumns: 'repeat(1,minmax(0,1fr))', gap: 16, alignContent: 'start' }}>
          <SentimentDonut breakdown={sentiment} />
          <RatingTrendCard reviews={reviewsAsOfEnd} />
        </div>
      </div>

      {selectedStat && (
        <StatDetailModal
          statKey={selectedStat.key}
          label={selectedStat.label}
          reviewsAsOfEnd={reviewsAsOfEnd}
          reviewsInMonth={reviewsInCurrentMonth}
          sourceSummary={sourceSummary}
          onClose={() => setSelectedStat(null)}
        />
      )}

      {compareSelection && (
        <PropertyComparisonModal
          title="Compare Properties - Reputation"
          rows={comparisonRows.filter((r) => compareSelection.includes(r.name))}
          columns={COMPARISON_COLUMNS}
          onClose={() => setCompareSelection(null)}
        />
      )}
    </div>
  )
}
