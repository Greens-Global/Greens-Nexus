import { adaptGoogleAdsReport } from './googleAdsApi'

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

// Smooth random-walk weights so the trend line wanders gently day to day
// instead of jumping between independent values.
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

// Builds rows already shaped like a real Google Ads API GoogleAdsRow, so the
// only thing a real integration needs to change is where these rows come
// from - the shape downstream code consumes is identical either way.
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
    const spd = isLast
      ? Math.round((targets.spend - spendRunning) * 100) / 100
      : Math.round(spend[day] * 100) / 100
    impRunning += imp
    clickRunning += clk
    convRunning += conv
    spendRunning += spd
    const date = new Date(Date.UTC(year, monthIndex, day + 1)).toISOString().slice(0, 10)
    rows.push({
      segments: { date },
      metrics: {
        impressions: String(imp),
        clicks: String(clk),
        conversions: String(conv),
        costMicros: String(Math.round(spd * 1_000_000)),
      },
    })
  }
  return rows
}

// June 2025 totals match the reference dashboard exactly.
const JUNE = { impressions: 245_146, clicks: 7_892, conversions: 456, spend: 12_450.75 }
// May 2025 derived from June's stated period-over-period growth.
const MAY = { impressions: 207_223, clicks: 6_490, conversions: 365, spend: 10_864.72 }
// Earlier months ramp up toward May so the trend line looks organic.
const APRIL = { impressions: 190_645, clicks: 5_890, conversions: 328, spend: 9_845.1 }
const MARCH = { impressions: 172_180, clicks: 5_320, conversions: 296, spend: 8_890.4 }
const FEBRUARY = { impressions: 154_400, clicks: 4_780, conversions: 262, spend: 7_910.6 }
const JANUARY = { impressions: 138_960, clicks: 4_260, conversions: 231, spend: 7_015.9 }

// This is exactly what `customers.googleAds.search` would return for the
// GAQL query in googleAdsApi.ts. `fetchGoogleAdsReport` stands in for the
// real API call; swap its body for an actual fetch and nothing else here
// needs to change.
function fetchGoogleAdsReport() {
  return {
    fieldMask: 'segments.date,metrics.impressions,metrics.clicks,metrics.conversions,metrics.costMicros',
    results: [
      ...generateMonth(2025, 0, JANUARY, 100),
      ...generateMonth(2025, 1, FEBRUARY, 200),
      ...generateMonth(2025, 2, MARCH, 300),
      ...generateMonth(2025, 3, APRIL, 400),
      ...generateMonth(2025, 4, MAY, 500),
      ...generateMonth(2025, 5, JUNE, 600),
    ],
  }
}

export const dailyMetrics = adaptGoogleAdsReport(fetchGoogleAdsReport())

export const initialCampaigns = [
  { id: 'c1', name: 'Storage - Branded', platform: 'Google Search', facility: 'Greens Valley Center', spend: 3240.28, clicks: 1812, conversions: 102, impressions: 42_020, status: 'Active' },
  { id: 'c2', name: 'Storage - Near me/locale', platform: 'Google Search', facility: 'Greens Escondido', spend: 3015.55, clicks: 1245, conversions: 86, impressions: 32_940, status: 'Active' },
  { id: 'c3', name: 'Storage - Competitors', platform: 'Google Search', facility: 'Greens Valley Center', spend: 2101.44, clicks: 945, conversions: 68, impressions: 26_180, status: 'Active' },
  { id: 'c4', name: 'Storage - Discount 50% Off', platform: 'Google Display', facility: 'Greens Temecula', spend: 1613.2, clicks: 922, conversions: 58, impressions: 28_720, status: 'Active' },
  { id: 'c5', name: 'Storage - Local', platform: 'Google Local', facility: 'Greens Fairfield', spend: 790.28, clicks: 637, conversions: 59, impressions: 22_040, status: 'Active' },
  { id: 'c6', name: 'Storage - Valley Center Brand', platform: 'Google Search', facility: 'Greens Valley Center', spend: 612.4, clicks: 410, conversions: 31, impressions: 15_320, status: 'Active' },
  { id: 'c7', name: 'Storage - Escondido Local', platform: 'Google Local', facility: 'Greens Escondido', spend: 540.1, clicks: 355, conversions: 24, impressions: 12_890, status: 'Active' },
  { id: 'c8', name: 'Storage - Temecula Local', platform: 'Google Local', facility: 'Greens Temecula', spend: 498.75, clicks: 322, conversions: 21, impressions: 11_760, status: 'Active' },
  { id: 'c9', name: 'Storage - Fairfield Local', platform: 'Google Local', facility: 'Greens Fairfield', spend: 431.9, clicks: 288, conversions: 19, impressions: 10_540, status: 'Active' },
  { id: 'c10', name: 'Storage - Georgetown Local', platform: 'Google Local', facility: 'Greens Georgetown', spend: 372.6, clicks: 241, conversions: 15, impressions: 9_180, status: 'Active' },
  { id: 'c11', name: 'Storage - Climate Controlled', platform: 'Google Display', facility: 'Greens Valley Center', spend: 705.3, clicks: 398, conversions: 26, impressions: 19_450, status: 'Active' },
  { id: 'c12', name: 'Storage - Moving Supplies', platform: 'YouTube Ads', facility: 'Greens Escondido', spend: 358.2, clicks: 512, conversions: 12, impressions: 34_600, status: 'Active' },
  { id: 'c13', name: 'Storage - Holiday Promo', platform: 'Google Display', facility: 'Greens Valley Center', spend: 289.4, clicks: 176, conversions: 9, impressions: 8_920, status: 'Paused' },
  { id: 'c14', name: 'Storage - Student Special', platform: 'Google Search', facility: 'Greens Escondido', spend: 214.6, clicks: 143, conversions: 8, impressions: 6_310, status: 'Paused' },
  { id: 'c15', name: 'Storage - Business Units', platform: 'Google Search', facility: 'Greens Temecula', spend: 176.85, clicks: 98, conversions: 6, impressions: 5_120, status: 'Paused' },
  { id: 'c16', name: 'Storage - RV & Boat', platform: 'Google Display', facility: 'Greens Fairfield', spend: 152.3, clicks: 87, conversions: 4, impressions: 4_640, status: 'Paused' },
  { id: 'c17', name: 'Storage - Spring Sale 2025', platform: 'Google Search', facility: 'Greens Valley Center', spend: 620.75, clicks: 340, conversions: 22, impressions: 13_280, status: 'Completed' },
  { id: 'c18', name: 'Storage - New Year Promo', platform: 'Google Search', facility: 'Greens Georgetown', spend: 480.15, clicks: 265, conversions: 17, impressions: 10_960, status: 'Completed' },
]

export const geoRows = [
  { location: 'Greens Valley Center', impressions: 86_245, clicks: 1_342, conversions: 118, spend: 3239.1 },
  { location: 'Greens Escondido', impressions: 54_231, clicks: 1_028, conversions: 91, spend: 2649.92 },
  { location: 'Greens Temecula', impressions: 39_178, clicks: 768, conversions: 71, spend: 1924.81 },
  { location: 'Greens Fairfield', impressions: 32_445, clicks: 642, conversions: 57, spend: 1631.91 },
  { location: 'Greens Georgetown', impressions: 18_932, clicks: 356, conversions: 35, spend: 944.3 },
]

export const keywordRows = [
  { keyword: 'storage units near me', clicks: 1_296, impressions: 31_080, conversions: 102, spend: 2479.62 },
  { keyword: 'self storage', clicks: 943, impressions: 25_620, conversions: 84, spend: 2110.92 },
  { keyword: 'climate controlled storage', clicks: 787, impressions: 23_920, conversions: 66, spend: 1860.54 },
  { keyword: 'storage units sacramento', clicks: 642, impressions: 18_770, conversions: 53, spend: 1450.61 },
  { keyword: 'cheap storage near me', clicks: 518, impressions: 17_800, conversions: 39, spend: 1090.05 },
  { keyword: 'storage near me', clicks: 402, impressions: 14_260, conversions: 28, spend: 784.6 },
  { keyword: 'public storage sacramento', clicks: 366, impressions: 12_940, conversions: 25, spend: 702.5 },
  { keyword: 'cheap storage units', clicks: 318, impressions: 11_680, conversions: 21, spend: 588.7 },
  { keyword: 'storage facility near me', clicks: 289, impressions: 10_540, conversions: 19, spend: 531.9 },
  { keyword: '24 hour storage access', clicks: 251, impressions: 9_210, conversions: 16, spend: 448.2 },
  { keyword: 'boat storage sacramento', clicks: 214, impressions: 8_320, conversions: 13, spend: 364.7 },
  { keyword: 'rv storage near me', clicks: 198, impressions: 7_640, conversions: 12, spend: 336.5 },
  { keyword: 'business storage units', clicks: 176, impressions: 6_980, conversions: 10, spend: 280.2 },
  { keyword: 'storage unit prices', clicks: 152, impressions: 6_120, conversions: 9, spend: 252.4 },
  { keyword: 'extra space storage', clicks: 138, impressions: 5_460, conversions: 8, spend: 224.6 },
]

export const deviceSplit = [
  { device: 'Mobile', share: 0.6688 },
  { device: 'Desktop', share: 0.2404 },
  { device: 'Tablet', share: 0.0908 },
]

// Split proportional to each property's existing click share (from
// geoRows), rounded to clean numbers that still sum to the original $18,000
// account-wide default.
export const monthlyBudgetByPropertyDefault = {
  'Greens Valley Center': 5_800,
  'Greens Escondido': 4_500,
  'Greens Temecula': 3_300,
  'Greens Fairfield': 2_800,
  'Greens Georgetown': 1_600,
}
