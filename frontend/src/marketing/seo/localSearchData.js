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

// The two "map pack" queries every Google Business Profile competes on
// locally - distinct from the head/long-tail terms in the main keyword
// database, which are organic-only.
const LOCAL_QUERIES = [
  { keyword: 'storage units near me', baseVolume: 1_800 },
  { keyword: 'self storage near me', baseVolume: 1_100 },
]

function buildRow(facility, keyword, baseVolume) {
  const rng = mulberry32(seedFromString(`local-${facility}-${keyword}`))
  const inPack = rng() < 0.55
  const mapPackPosition = inPack ? Math.ceil(rng() * 3) : null
  const organicPosition = Math.max(1, Math.round((inPack ? 3 : 8) + rng() * 10))
  const delta = Math.round((rng() - 0.4) * 4)
  const volume = Math.round(baseVolume * (0.7 + rng() * 0.6))
  return { facility, keyword, mapPackPosition, organicPosition, volume, delta }
}

export const localSearchRows = FACILITIES.flatMap((facility) => LOCAL_QUERIES.map((q) => buildRow(facility, q.keyword, q.baseVolume)))
