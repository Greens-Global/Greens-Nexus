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

// Shared by ReviewsFeedCard (the visible list) and the word cloud (what it's
// built from) so "generate the cloud from what's on screen" is literally true
// - filtering to 1-star there and the cloud updates to the same rows, instead
// of two independently-filtered views that can silently disagree.
export function filterReviews(reviews, { status = 'Pending', platform = 'All', rating = 'All', query = '' } = {}) {
  let rows = reviews
  if (status === 'Pending') rows = rows.filter((r) => r.status !== 'Posted')
  if (status === 'Posted') rows = rows.filter((r) => r.status === 'Posted')
  if (platform !== 'All') rows = rows.filter((r) => r.platform === platform)
  if (rating !== 'All') rows = rows.filter((r) => r.rating === rating)
  if (query.trim()) {
    const q = query.trim().toLowerCase()
    rows = rows.filter((r) => r.customer.toLowerCase().includes(q) || r.text.toLowerCase().includes(q) || r.facility.toLowerCase().includes(q))
  }
  return rows
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'was', 'were', 'are', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'as', 'by', 'from', 'up', 'about', 'into',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'they', 'he', 'she', 'you',
  'my', 'our', 'their', 'his', 'her', 'your', 'me', 'us', 'them',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can',
  'so', 'if', 'not', 'no', 'just', 'very', 'too', 'also', 'there', 'here', 'when', 'then',
  'all', 'some', 'more', 'most', 'been', 'am', 'im', 'a', 'out', 'get', 'got',
  // Sentence-connector filler, not review topics - without these, generic
  // grammar ("took a while", "went up") crowds out the actual words customers
  // are talking about (clean, staff, gate, pricing...).
  'took', 'while', 'went', 'much', 'still', 'let', 'know', 'wish', 'us',
]);

// Review text embeds the property name inline ("...at the ${facility}
// facility..."), so its words (temecula, escondido, valley, center, greens...)
// are address fragments, not customer sentiment - without excluding them they
// dominate the cloud purely because every single review contains one.
const FACILITY_WORDS = new Set(
  FACILITIES.flatMap((name) => name.toLowerCase().split(/\s+/)),
);

// Word frequency across review text, split by whether each occurrence came from
// a Positive or Negative review - lets the cloud color a word by sentiment skew
// (e.g. "gate" trending red because it mostly shows up in 1-2 star reviews)
// instead of an arbitrary color, which is what makes the cloud a diagnostic
// tool rather than decoration.
// No default limit - a top-N cutoff silently drops rare words, and in any
// mixed-sentiment set the negative vocabulary IS the rare vocabulary (most
// facilities get far more 5-star than 1-star reviews). Truncating erased
// every negative word before the cloud ever got to color one red. Callers
// that genuinely have thousands of unique words can still pass `limit`.
export function computeWordFrequency(reviews, { limit = Infinity, minLength = 3 } = {}) {
  const counts = new Map();

  for (const r of reviews) {
    const words = (r.text || '')
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= minLength && !STOPWORDS.has(w) && !FACILITY_WORDS.has(w));

    for (const word of words) {
      const entry = counts.get(word) || { word, count: 0, positive: 0, negative: 0 };
      entry.count += 1;
      if (r.sentiment === 'Positive') entry.positive += 1;
      else if (r.sentiment === 'Negative') entry.negative += 1;
      counts.set(word, entry);
    }
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function propertyBreakdownInRange(allReviews, range) {
  return FACILITIES.map((name) => {
    const scoped = allReviews.filter((r) => r.facility === name)
    const lifetime = computeLifetimeStats(asOf(scoped, range.end))
    const period = computePeriodStats(filterByRange(scoped, range))
    return { name, rating: lifetime.overallRating, totalReviews: lifetime.totalReviews, newReviews: period.newReviews, pending: period.pending }
  })
}
