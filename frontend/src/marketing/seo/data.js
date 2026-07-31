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

// Real-world self-storage search demand peaks during moving season
// (roughly May-September) and dips over the winter holidays.
const SEASONALITY = [0.74, 0.78, 0.86, 0.97, 1.12, 1.27, 1.32, 1.22, 1.06, 0.9, 0.79, 0.74]

function buildTrend(baseVolume, keyword) {
  const rng = mulberry32(seedFromString(keyword))
  return SEASONALITY.map((s) => Math.round(baseVolume * s * (0.94 + rng() * 0.12)))
}

const SAN_DIEGO = 'San Diego Area'
const SACRAMENTO_BAY = 'Sacramento / Bay Area'

const KEYWORD_SEED = [
  // Generic - not tied to any single region, so these stay visible under every region filter.
  { keyword: 'storage units near me', volume: 40_500, difficulty: 62, cpc: 4.85, intent: 'Transactional' },
  { keyword: 'self storage', volume: 33_100, difficulty: 68, cpc: 5.2, intent: 'Commercial' },
  { keyword: 'extra space storage', volume: 22_200, difficulty: 71, cpc: 4.1, intent: 'Navigational' },
  { keyword: 'storage facility near me', volume: 14_800, difficulty: 58, cpc: 4.75, intent: 'Transactional' },
  { keyword: 'climate controlled storage', volume: 8_100, difficulty: 45, cpc: 6.1, intent: 'Commercial' },
  { keyword: 'how big is a 10x10 storage unit', volume: 8_100, difficulty: 22, cpc: 1.2, intent: 'Informational' },
  { keyword: 'storage unit auction', volume: 9_900, difficulty: 34, cpc: 1.8, intent: 'Informational' },
  { keyword: 'rv storage near me', volume: 9_900, difficulty: 39, cpc: 4.2, intent: 'Transactional' },
  { keyword: 'portable storage containers', volume: 6_600, difficulty: 47, cpc: 5.9, intent: 'Commercial' },
  { keyword: 'cheap storage units', volume: 6_600, difficulty: 41, cpc: 3.95, intent: 'Transactional' },
  { keyword: 'storage unit prices', volume: 5_400, difficulty: 38, cpc: 3.4, intent: 'Informational' },
  { keyword: 'best storage units near me', volume: 5_400, difficulty: 52, cpc: 4.65, intent: 'Commercial' },
  { keyword: 'indoor storage units', volume: 3_600, difficulty: 42, cpc: 4.45, intent: 'Commercial' },
  { keyword: 'moving and storage companies', volume: 3_300, difficulty: 44, cpc: 5.5, intent: 'Commercial' },
  { keyword: 'storage near me cheap', volume: 2_900, difficulty: 40, cpc: 3.7, intent: 'Transactional' },
  { keyword: 'business storage units', volume: 2_900, difficulty: 33, cpc: 5.8, intent: 'Commercial' },
  { keyword: 'vehicle storage facility', volume: 2_400, difficulty: 36, cpc: 4.9, intent: 'Commercial' },
  { keyword: 'small storage unit sizes', volume: 2_400, difficulty: 26, cpc: 2.1, intent: 'Informational' },
  { keyword: '24 hour storage access', volume: 1_900, difficulty: 28, cpc: 3.1, intent: 'Informational' },
  { keyword: 'storage unit near me 24 hour', volume: 1_600, difficulty: 30, cpc: 3.6, intent: 'Transactional' },
  { keyword: 'wine storage units', volume: 1_300, difficulty: 31, cpc: 3.8, intent: 'Commercial' },
  { keyword: 'diy storage tips', volume: 1_000, difficulty: 15, cpc: 0.9, intent: 'Informational' },

  // San Diego Area - region-level head terms + facility-specific long-tail (Valley Center, Escondido, Temecula).
  { keyword: 'storage units san diego', volume: 9_900, difficulty: 56, cpc: 4.6, intent: 'Transactional', region: SAN_DIEGO },
  { keyword: 'self storage san diego', volume: 6_600, difficulty: 60, cpc: 4.9, intent: 'Commercial', region: SAN_DIEGO },
  { keyword: 'boat storage near me', volume: 4_400, difficulty: 35, cpc: 4.6, intent: 'Transactional', region: SAN_DIEGO },
  {
    keyword: 'storage units valley center',
    volume: 260,
    difficulty: 18,
    cpc: 3.75,
    intent: 'Navigational',
    region: SAN_DIEGO,
    facility: 'Greens Valley Center',
  },
  {
    keyword: 'self storage escondido',
    volume: 720,
    difficulty: 25,
    cpc: 4.2,
    intent: 'Navigational',
    region: SAN_DIEGO,
    facility: 'Greens Escondido',
  },
  {
    keyword: 'storage units temecula',
    volume: 880,
    difficulty: 27,
    cpc: 4.35,
    intent: 'Navigational',
    region: SAN_DIEGO,
    facility: 'Greens Temecula',
  },

  // Sacramento / Bay Area - region-level head terms + facility-specific long-tail (Fairfield, Georgetown).
  { keyword: 'storage units sacramento', volume: 4_400, difficulty: 48, cpc: 4.55, intent: 'Commercial', region: SACRAMENTO_BAY },
  { keyword: 'public storage sacramento', volume: 3_600, difficulty: 55, cpc: 4.4, intent: 'Navigational', region: SACRAMENTO_BAY },
  { keyword: 'self storage sacramento', volume: 2_900, difficulty: 50, cpc: 4.3, intent: 'Commercial', region: SACRAMENTO_BAY },
  {
    keyword: 'storage units fairfield ca',
    volume: 590,
    difficulty: 24,
    cpc: 4.1,
    intent: 'Navigational',
    region: SACRAMENTO_BAY,
    facility: 'Greens Fairfield',
  },
  {
    keyword: 'storage units georgetown',
    volume: 320,
    difficulty: 20,
    cpc: 3.9,
    intent: 'Navigational',
    region: SACRAMENTO_BAY,
    facility: 'Greens Georgetown',
  },
]

export const keywordDatabase = KEYWORD_SEED.map((row) => ({
  ...row,
  trend: buildTrend(row.volume, row.keyword),
}))


const COMPETITOR_DOMAINS = [
  { domain: 'publicstorage.com', domainRating: 82 },
  { domain: 'uhaul.com', domainRating: 85 },
  { domain: 'extraspace.com', domainRating: 78 },
  { domain: 'cubesmart.com', domainRating: 74 },
  { domain: 'lifestorage.com', domainRating: 71 },
  { domain: 'storagemart.com', domainRating: 60 },
  { domain: 'sparefoot.com', domainRating: 65 },
  { domain: 'neighbor.com', domainRating: 58 },
  { domain: 'yellowpages.com', domainRating: 90 },
  { domain: 'storagearea.com', domainRating: 42 },
]

const OWN_DOMAIN = 'greensstorage.com'

export function buildSerpResults(keyword) {
  const rng = mulberry32(seedFromString(`serp-${keyword.keyword}`))
  const shuffled = [...COMPETITOR_DOMAINS].sort(() => rng() - 0.5).slice(0, 9)
  // Harder keywords push our own listing further down the page.
  const ownPosition = Math.min(10, Math.max(1, Math.round(2 + keyword.difficulty / 11 + (rng() - 0.5) * 2)))

  const rows = []
  let ci = 0
  for (let i = 0; i < 10; i++) {
    if (i === ownPosition - 1) {
      rows.push({
        domain: OWN_DOMAIN,
        title: `Greens Storage - ${keyword.keyword}`,
        domainRating: 38,
        backlinks: Math.round(180 + rng() * 220),
        estTraffic: Math.round(keyword.volume * 0.12 * (1 - (ownPosition - 1) * 0.07)),
        isOwnDomain: true,
      })
    } else {
      const comp = shuffled[ci % shuffled.length]
      ci++
      const posFactor = 1 - i * 0.09
      rows.push({
        domain: comp.domain,
        title: `${comp.domain.split('.')[0][0].toUpperCase()}${comp.domain.split('.')[0].slice(1)} - ${keyword.keyword}`,
        domainRating: comp.domainRating,
        backlinks: Math.round((comp.domainRating * 40 + rng() * 2000) * posFactor),
        estTraffic: Math.round(keyword.volume * 0.28 * posFactor * (0.8 + rng() * 0.4)),
      })
    }
  }
  return rows.map((r, i) => ({ ...r, position: i + 1 }))
}

const MONTH_CHECKPOINTS = ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30', '2025-05-31', '2025-06-30']

const TRACKED_SEED = [
  { keyword: 'storage units near me', facility: 'Greens Valley Center', priority: 'High', startPosition: 9, drift: -3 },
  { keyword: 'self storage', facility: 'Greens Valley Center', priority: 'High', startPosition: 14, drift: -2 },
  { keyword: 'storage units sacramento', facility: 'Greens Valley Center', priority: 'High', startPosition: 6, drift: -4 },
  { keyword: 'storage facility near me', facility: 'Greens Escondido', priority: 'High', startPosition: 8, drift: -2 },
  { keyword: 'self storage escondido', facility: 'Greens Escondido', priority: 'Medium', startPosition: 5, drift: -3 },
  { keyword: 'climate controlled storage', facility: 'Greens Escondido', priority: 'Medium', startPosition: 11, drift: 1 },
  { keyword: 'storage units temecula', facility: 'Greens Temecula', priority: 'Medium', startPosition: 4, drift: -2 },
  { keyword: 'rv storage near me', facility: 'Greens Temecula', priority: 'Medium', startPosition: 10, drift: -1 },
  { keyword: 'storage units fairfield ca', facility: 'Greens Fairfield', priority: 'Medium', startPosition: 6, drift: -3 },
  { keyword: 'boat storage near me', facility: 'Greens Fairfield', priority: 'Low', startPosition: 12, drift: 2 },
  { keyword: 'storage units georgetown', facility: 'Greens Georgetown', priority: 'Low', startPosition: 7, drift: -2 },
  { keyword: 'best storage units near me', facility: 'Greens Georgetown', priority: 'Low', startPosition: 15, drift: 3 },
  { keyword: 'cheap storage units', facility: 'Greens Valley Center', priority: 'Medium', startPosition: 13, drift: -1 },
  { keyword: 'business storage units', facility: 'Greens Escondido', priority: 'Low', startPosition: 16, drift: 0 },
]

function findKeyword(name) {
  const k = keywordDatabase.find((k) => k.keyword === name)
  if (!k) throw new Error(`Unknown tracked keyword: ${name}`)
  return k
}

export const trackedKeywords = TRACKED_SEED.map((seed, i) => {
  const kw = findKeyword(seed.keyword)
  const rng = mulberry32(seedFromString(`rank-${seed.keyword}-${seed.facility}`))
  const steps = MONTH_CHECKPOINTS.length
  const history = MONTH_CHECKPOINTS.map((date, m) => {
    const progress = m / (steps - 1)
    const noise = Math.round((rng() - 0.5) * 2)
    const position = Math.max(1, Math.round(seed.startPosition + seed.drift * progress + noise))
    return { date, position }
  })
  const slug = seed.facility.toLowerCase().replace(/[^a-z]+/g, '-')
  return {
    id: `tk-${i + 1}`,
    keyword: seed.keyword,
    facility: seed.facility,
    priority: seed.priority,
    url: `https://greensstorage.com/${slug}/`,
    volume: kw.volume,
    difficulty: kw.difficulty,
    history,
  }
})

export { FACILITIES }
