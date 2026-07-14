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

// Same smooth random-walk approach as data.ts's Google Ads generator, so the
// Yelp trend line wanders gently day to day instead of jumping around.
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

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

function generateMonth(year, monthIndex, targets, seedBase) {
  const dim = daysInMonth(year, monthIndex)
  const impressions = distribute(dim, targets.impressions, seedBase + 1)
  const clicks = distribute(dim, targets.clicks, seedBase + 2)
  const conversions = distribute(dim, targets.conversions, seedBase + 3)
  const spend = distribute(dim, targets.spend, seedBase + 4)

  const rows = []
  let impRunning = 0
  let clickRunning = 0
  let convRunning = 0
  let spendRunning = 0
  for (let day = 0; day < dim; day++) {
    const isLast = day === dim - 1
    const imp = isLast ? Math.round(targets.impressions - impRunning) : Math.round(impressions[day])
    const clk = isLast ? Math.round(targets.clicks - clickRunning) : Math.round(clicks[day])
    const conv = isLast ? Math.round(targets.conversions - convRunning) : Math.round(conversions[day])
    const spd = isLast ? Math.round((targets.spend - spendRunning) * 100) / 100 : Math.round(spend[day] * 100) / 100
    impRunning += imp
    clickRunning += clk
    convRunning += conv
    spendRunning += spd
    const date = new Date(Date.UTC(year, monthIndex, day + 1)).toISOString().slice(0, 10)
    rows.push({ date, impressions: imp, clicks: clk, conversions: conv, spend: spd })
  }
  return rows
}

// Yelp Ads spend is a fraction of the Google Ads account — roughly a
// quarter, consistent with how most storage operators split paid budget.
const JUNE = { impressions: 58_400, clicks: 1_940, conversions: 104, spend: 3_120.5 }
const MAY = { impressions: 49_850, clicks: 1_610, conversions: 84, spend: 2_680.2 }
const APRIL = { impressions: 45_700, clicks: 1_460, conversions: 75, spend: 2_420.8 }
const MARCH = { impressions: 41_200, clicks: 1_320, conversions: 68, spend: 2_180.3 }
const FEBRUARY = { impressions: 36_900, clicks: 1_180, conversions: 60, spend: 1_940.1 }
const JANUARY = { impressions: 33_100, clicks: 1_050, conversions: 53, spend: 1_720.4 }

export const yelpDailyMetrics = [
  ...generateMonth(2025, 0, JANUARY, 1100),
  ...generateMonth(2025, 1, FEBRUARY, 1200),
  ...generateMonth(2025, 2, MARCH, 1300),
  ...generateMonth(2025, 3, APRIL, 1400),
  ...generateMonth(2025, 4, MAY, 1500),
  ...generateMonth(2025, 5, JUNE, 1600),
]

export const yelpInitialCampaigns = [
  { id: 'y1', name: 'Yelp - Enhanced Profile Valley Center', platform: 'Yelp Enhanced Profile', facility: 'Greens Valley Center', spend: 820.4, clicks: 512, conversions: 28, impressions: 14_820, status: 'Active' },
  { id: 'y2', name: 'Yelp - Sponsored Search Escondido', platform: 'Yelp Sponsored Search', facility: 'Greens Escondido', spend: 645.2, clicks: 398, conversions: 21, impressions: 11_640, status: 'Active' },
  { id: 'y3', name: 'Yelp - Ads Temecula', platform: 'Yelp Ads', facility: 'Greens Temecula', spend: 512.8, clicks: 312, conversions: 17, impressions: 9_280, status: 'Active' },
  { id: 'y4', name: 'Yelp - Enhanced Profile Fairfield', platform: 'Yelp Enhanced Profile', facility: 'Greens Fairfield', spend: 398.6, clicks: 246, conversions: 13, impressions: 7_410, status: 'Active' },
  { id: 'y5', name: 'Yelp - Sponsored Search Georgetown', platform: 'Yelp Sponsored Search', facility: 'Greens Georgetown', spend: 264.3, clicks: 165, conversions: 9, impressions: 5_120, status: 'Active' },
  { id: 'y6', name: 'Yelp - Ads Valley Center Brand', platform: 'Yelp Ads', facility: 'Greens Valley Center', spend: 218.5, clicks: 134, conversions: 7, impressions: 4_280, status: 'Active' },
  { id: 'y7', name: 'Yelp - Move-In Special', platform: 'Yelp Sponsored Search', facility: 'Greens Escondido', spend: 156.4, clicks: 98, conversions: 5, impressions: 3_120, status: 'Paused' },
  { id: 'y8', name: 'Yelp - Spring Promo 2025', platform: 'Yelp Ads', facility: 'Greens Temecula', spend: 124.9, clicks: 76, conversions: 4, impressions: 2_640, status: 'Completed' },
]

export const yelpGeoRows = [
  { location: 'Greens Valley Center', impressions: 20_640, clicks: 646, conversions: 35, spend: 1_038.9 },
  { location: 'Greens Escondido', impressions: 13_260, clicks: 496, conversions: 26, spend: 801.6 },
  { location: 'Greens Temecula', impressions: 10_180, clicks: 388, conversions: 21, spend: 637.7 },
  { location: 'Greens Fairfield', impressions: 8_940, clicks: 302, conversions: 15, spend: 458.6 },
  { location: 'Greens Georgetown', impressions: 5_380, clicks: 108, conversions: 7, spend: 183.7 },
]

export const yelpKeywordRows = [
  { keyword: 'storage units near me', clicks: 312, impressions: 8_920, conversions: 22, spend: 612.4 },
  { keyword: 'self storage reviews', clicks: 268, impressions: 7_640, conversions: 18, spend: 528.9 },
  { keyword: 'climate controlled storage', clicks: 198, impressions: 6_120, conversions: 14, spend: 412.5 },
  { keyword: 'best storage facility', clicks: 165, impressions: 5_240, conversions: 11, spend: 348.2 },
  { keyword: 'cheap storage near me', clicks: 132, impressions: 4_380, conversions: 8, spend: 276.8 },
  { keyword: 'storage unit prices', clicks: 108, impressions: 3_620, conversions: 6, spend: 224.4 },
  { keyword: 'rv storage near me', clicks: 86, impressions: 2_940, conversions: 5, spend: 178.6 },
  { keyword: 'storage facility reviews', clicks: 68, impressions: 2_360, conversions: 3, spend: 142.3 },
]

export const yelpMonthlyBudgetByPropertyDefault = {
  'Greens Valley Center': 1_400,
  'Greens Escondido': 1_100,
  'Greens Temecula': 850,
  'Greens Fairfield': 650,
  'Greens Georgetown': 400,
}
