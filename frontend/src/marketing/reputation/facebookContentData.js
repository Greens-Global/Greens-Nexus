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

// Facebook has no "Business Profile Performance" API equivalent in this
// mock universe (no view/click/call analytics) - only organic Page posts.
const POST_TEMPLATES = [
  {
    type: 'STANDARD',
    summary: (city) => `Come see what's new at our ${city} location! Clean, secure, and ready when you are.`,
    ctaLabel: 'Learn more',
    ctaUrl: 'https://facebook.com/greensstorage',
    lifespanDays: 30,
  },
  {
    type: 'OFFER',
    summary: () => "This month only: 50% off your first month's rent. Tag a friend who's moving!",
    ctaLabel: 'Redeem',
    ctaUrl: 'https://facebook.com/greensstorage/offers',
    lifespanDays: 21,
  },
  {
    type: 'EVENT',
    summary: (city) => `Join us for our community open house at ${city} this Saturday - free coffee & donuts!`,
    ctaLabel: 'Sign up',
    ctaUrl: 'https://facebook.com/events/greensstorage',
    lifespanDays: 14,
  },
]

function buildPostsForFacility(facility, rng) {
  const city = facility
  const count = 2 + Math.floor(rng() * 2)
  const posts = []
  for (let i = 0; i < count; i++) {
    const template = POST_TEMPLATES[Math.floor(rng() * POST_TEMPLATES.length)]
    const createdOffset = Math.floor(rng() * 45) + 1
    const createdDate = addDays(ANCHOR_DATE, -createdOffset)
    const expiresDate = addDays(createdDate, template.lifespanDays)
    posts.push({
      id: `facebook/${slug(facility)}/posts/${i + 1}`,
      facility,
      type: template.type,
      text: template.summary(city),
      imageUrl: `https://picsum.photos/seed/${slug(facility)}-fb-post-${i}/480/320`,
      ctaLabel: template.ctaLabel,
      ctaUrl: template.ctaUrl,
      createdDate,
      expiresDate,
      status: expiresDate < ANCHOR_DATE ? 'EXPIRED' : 'LIVE',
    })
  }
  return posts
}

export const initialFacebookPosts = FACILITIES.flatMap((f) =>
  buildPostsForFacility(f, mulberry32(seedFromString(`facebook-posts-${f}`))),
)
