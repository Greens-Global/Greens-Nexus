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

// Yelp Business Page traffic is a fraction of the Google Business Profile
// volume — roughly a third, consistent with the Ads module's Google/Yelp split.
const FACILITY_PROMINENCE = {
  'Greens Valley Center': 980,
  'Greens Escondido': 620,
  'Greens Temecula': 520,
  'Greens Fairfield': 380,
  'Greens Georgetown': 310,
}

function buildSeries(monthlyBase, seed) {
  const points = []
  SEASONALITY.forEach((factor, monthIndex) => {
    const dim = daysInMonth(2025, monthIndex)
    const monthTotal = monthlyBase * factor
    const daily = distribute(dim, monthTotal, seed + monthIndex)
    for (let day = 0; day < dim; day++) {
      const date = new Date(Date.UTC(2025, monthIndex, day + 1)).toISOString().slice(0, 10)
      points.push({ date, value: Math.round(daily[day]) })
    }
  })
  return points
}

function buildProfileMetrics(facility) {
  const totalViews = FACILITY_PROMINENCE[facility] ?? 400
  const seed = seedFromString(facility)

  // Yelp doesn't distinguish "Maps" vs "Search" the way Google does — its
  // two view sources are search results and direct profile visits.
  const searchMonthly = totalViews * 0.6
  const directMonthly = totalViews * 0.4

  const search = buildSeries(searchMonthly, seed + 1)
  const direct = buildSeries(directMonthly, seed + 2)
  const websiteClicks = buildSeries(totalViews * 0.09, seed + 3)
  const callClicks = buildSeries(totalViews * 0.06, seed + 4)
  const directionRequests = buildSeries(totalViews * 0.07, seed + 5)

  return search.map((s, i) => ({
    date: s.date,
    mapsViews: direct[i]?.value ?? 0,
    searchViews: s.value,
    websiteClicks: websiteClicks[i]?.value ?? 0,
    callClicks: callClicks[i]?.value ?? 0,
    directionRequests: directionRequests[i]?.value ?? 0,
  }))
}

const CITY_BY_FACILITY = {
  'Greens Valley Center': 'valley center',
  'Greens Escondido': 'escondido',
  'Greens Temecula': 'temecula',
  'Greens Fairfield': 'fairfield',
  'Greens Georgetown': 'georgetown',
}

function buildDiscoveryKeywords(facility) {
  const rng = mulberry32(seedFromString(`yelp-kw-${facility}`))
  const city = CITY_BY_FACILITY[facility]
  const base = (FACILITY_PROMINENCE[facility] ?? 400) / 6

  const rows = [
    { keyword: 'greens storage', type: 'Direct', share: 0.16 },
    { keyword: `greens storage ${city}`, type: 'Direct', share: 0.1 },
    { keyword: 'storage units', type: 'Discovery', share: 0.2 },
    { keyword: 'self storage near me', type: 'Discovery', share: 0.17 },
    { keyword: `storage ${city}`, type: 'Discovery', share: 0.14 },
    { keyword: 'climate controlled storage', type: 'Discovery', share: 0.12 },
    { keyword: `best storage facility ${city}`, type: 'Discovery', share: 0.11 },
  ]

  return rows.map((r) => ({
    keyword: r.keyword,
    type: r.type,
    impressions: Math.round(base * r.share * (0.85 + rng() * 0.3)),
  }))
}

export const yelpProfileMetricsByFacility = Object.fromEntries(
  FACILITIES.map((f) => [f, buildProfileMetrics(f)]),
)

export const yelpDiscoveryKeywordsByFacility = Object.fromEntries(
  FACILITIES.map((f) => [f, buildDiscoveryKeywords(f)]),
)
