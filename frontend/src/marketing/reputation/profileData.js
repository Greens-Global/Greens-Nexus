import { adaptGbpTimeSeries, adaptGbpSearchKeywords } from './gbpApi'
import { FACILITIES } from '../shared/facilities'

function mulberry32(seed) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedFromString(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h >>> 0
}

// Same moving-season curve used across the module (Jan-Jun slice).
const SEASONALITY = [0.74, 0.78, 0.86, 0.97, 1.12, 1.27]

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

function toGbpDate(year, monthIndex, day) {
  return { year, month: monthIndex + 1, day }
}

function distribute(days, total, seed) {
  const rng = mulberry32(seed)
  const weights = []
  let level = 1
  for (let i = 0; i < days; i++) {
    level += (rng() - 0.5) * 0.12
    level = Math.max(0.55, Math.min(1.6, level))
    weights.push(level)
  }
  const sumW = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => (total * w) / sumW)
}

// Monthly view volume scaled by each facility's prominence (proxied by its
// lifetime review count, since a more-reviewed listing also gets more Maps
// traffic in the real world).
const FACILITY_PROMINENCE = {
  'Valley Center': 2800,
  'Escondido': 1800,
  'Temecula': 1500,
  'Fairfield': 1100,
  'Georgetown': 900,
}

function buildMetricSeries(metric, monthlyBase, seed) {
  const datedValues = []
  SEASONALITY.forEach((factor, monthIndex) => {
    const dim = daysInMonth(2025, monthIndex)
    const monthTotal = monthlyBase * factor
    const daily = distribute(dim, monthTotal, seed + monthIndex)
    for (let day = 0; day < dim; day++) {
      datedValues.push({ date: toGbpDate(2025, monthIndex, day + 1), value: String(Math.round(daily[day])) })
    }
  })
  return { dailyMetric: metric, timeSeries: { datedValues } }
}

function fetchGbpTimeSeriesReport(facility) {
  const totalViews = FACILITY_PROMINENCE[facility] ?? 1200
  const seed = seedFromString(facility)

  const mapsMonthly = totalViews * 0.55
  const searchMonthly = totalViews * 0.45

  return {
    multiDailyMetricTimeSeries: [
      {
        dailyMetricTimeSeries: [
          buildMetricSeries('BUSINESS_IMPRESSIONS_MOBILE_MAPS', mapsMonthly * 0.72, seed + 1),
          buildMetricSeries('BUSINESS_IMPRESSIONS_DESKTOP_MAPS', mapsMonthly * 0.28, seed + 2),
          buildMetricSeries('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', searchMonthly * 0.65, seed + 3),
          buildMetricSeries('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', searchMonthly * 0.35, seed + 4),
          buildMetricSeries('WEBSITE_CLICKS', totalViews * 0.08, seed + 5),
          buildMetricSeries('CALL_CLICKS', totalViews * 0.05, seed + 6),
          buildMetricSeries('BUSINESS_DIRECTION_REQUESTS', totalViews * 0.1, seed + 7),
        ],
      },
    ],
  }
}

const CITY_BY_FACILITY = {
  'Valley Center': 'valley center',
  'Escondido': 'escondido',
  'Temecula': 'temecula',
  'Fairfield': 'fairfield',
  'Georgetown': 'georgetown',
}

function fetchGbpSearchKeywordsReport(facility) {
  const rng = mulberry32(seedFromString(`kw-${facility}`))
  const city = CITY_BY_FACILITY[facility]
  const base = (FACILITY_PROMINENCE[facility] ?? 1200) / 6 // rough monthly-average scale

  const rows = [
    { searchKeyword: 'greens storage', type: 'Direct', share: 0.14 },
    { searchKeyword: `greens storage ${city}`, type: 'Direct', share: 0.09 },
    { searchKeyword: 'storage units near me', type: 'Discovery', share: 0.22 },
    { searchKeyword: 'self storage', type: 'Discovery', share: 0.16 },
    { searchKeyword: `storage units ${city}`, type: 'Discovery', share: 0.13 },
    { searchKeyword: 'climate controlled storage near me', type: 'Discovery', share: 0.1 },
    { searchKeyword: 'cheap storage units', type: 'Discovery', share: 0.09 },
    { searchKeyword: `storage facility near ${city}`, type: 'Discovery', share: 0.07 },
  ]

  return {
    searchKeywordsCounts: rows.map((r) => ({
      searchKeyword: r.searchKeyword,
      type: r.type,
      insightsValue: { value: String(Math.round(base * r.share * (0.85 + rng() * 0.3))) },
    })),
  }
}

export const profileMetricsByFacility = Object.fromEntries(
  FACILITIES.map((f) => [f, adaptGbpTimeSeries(fetchGbpTimeSeriesReport(f))]),
)

export const discoveryKeywordsByFacility = Object.fromEntries(
  FACILITIES.map((f) => [f, adaptGbpSearchKeywords(fetchGbpSearchKeywordsReport(f))]),
)
