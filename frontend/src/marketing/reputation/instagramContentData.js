import { FACILITIES } from '../shared/facilities'
import { ANCHOR_DATE, addDays } from '../shared/utils'

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

function slug(facility) {
  return facility.toLowerCase().replace(/[^a-z]+/g, '-')
}

// Instagram has no "Business Profile Performance" API equivalent in this
// mock universe (no view/click/call analytics) - only organic feed posts.
const POST_TEMPLATES = [
  {
    type: 'STANDARD',
    summary: (city) => `Behind the scenes at ${city} ✨ Bright, clean units ready for move-in. #selfstorage #${city.replace(/\s+/g, '')}`,
    ctaLabel: 'Learn more',
    ctaUrl: 'https://instagram.com/greensstorage',
    lifespanDays: 30,
  },
  {
    type: 'OFFER',
    summary: () => 'Swipe up for 50% off your first month 📦 Link in bio. #movingday #storagegoals',
    ctaLabel: 'Redeem',
    ctaUrl: 'https://instagram.com/greensstorage/offers',
    lifespanDays: 21,
  },
  {
    type: 'EVENT',
    summary: (city) => `We're hosting a free packing workshop at ${city} this weekend 🎉 See you there!`,
    ctaLabel: 'Sign up',
    ctaUrl: 'https://instagram.com/greensstorage/events',
    lifespanDays: 14,
  },
]

function buildPostsForFacility(facility, rng) {
  const city = facility.replace('Greens ', '')
  const count = 2 + Math.floor(rng() * 2)
  const posts = []
  for (let i = 0; i < count; i++) {
    const template = POST_TEMPLATES[Math.floor(rng() * POST_TEMPLATES.length)]
    const createdOffset = Math.floor(rng() * 45) + 1
    const createdDate = addDays(ANCHOR_DATE, -createdOffset)
    const expiresDate = addDays(createdDate, template.lifespanDays)
    posts.push({
      id: `instagram/${slug(facility)}/posts/${i + 1}`,
      facility,
      type: template.type,
      text: template.summary(city),
      imageUrl: `https://picsum.photos/seed/${slug(facility)}-ig-post-${i}/480/480`,
      ctaLabel: template.ctaLabel,
      ctaUrl: template.ctaUrl,
      createdDate,
      expiresDate,
      status: expiresDate < ANCHOR_DATE ? 'EXPIRED' : 'LIVE',
    })
  }
  return posts
}

export const initialInstagramPosts = FACILITIES.flatMap((f) =>
  buildPostsForFacility(f, mulberry32(seedFromString(`instagram-posts-${f}`))),
)
