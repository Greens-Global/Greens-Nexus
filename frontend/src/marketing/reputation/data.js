import { ANCHOR_DATE } from '../shared/utils'
import { FACILITIES } from '../shared/facilities'
import { generateAiReply } from './aiReplyEngine'

export { FACILITIES }

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

const rng = mulberry32(4242)

const FACILITY_WEIGHTS = [0.36, 0.24, 0.17, 0.13, 0.1]

const PLATFORMS = ['Google', 'Yelp', 'Facebook', 'Storage Facility Finder', 'Other']
const PLATFORM_WEIGHTS = [0.506, 0.207, 0.128, 0.085, 0.073]

const FIRST_NAMES = [
  'Jennifer', 'Mark', 'Sarah', 'David', 'Emily', 'Chris', 'Amanda', 'Brian', 'Nicole', 'Kevin',
  'Rachel', 'Tom', 'Laura', 'Justin', 'Megan', 'Steve', 'Christina', 'Ryan', 'Alicia', 'Derek',
  'Monica', 'Paul', 'Kimberly', 'Eric', 'Danielle', 'Greg', 'Vanessa', 'Tyler', 'Michelle', 'Jason',
]
const LAST_INITIALS = 'ABCDEFGHJKLMNPRSTW'.split('')

function weightedPick(items, weights) {
  const r = rng()
  let acc = 0
  for (let i = 0; i < items.length; i++) {
    acc += weights[i]
    if (r <= acc) return items[i]
  }
  return items[items.length - 1]
}

function pick(items) {
  return items[Math.floor(rng() * items.length)]
}

function customerName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_INITIALS)}.`
}

function ratingFor() {
  const r = rng()
  if (r < 0.72) return 5
  if (r < 0.9) return 4
  if (r < 0.95) return 3
  if (r < 0.98) return 2
  return 1
}

function sentimentFor(rating) {
  const r = rng()
  if (rating === 5) return r < 0.92 ? 'Positive' : 'Neutral'
  if (rating === 4) return r < 0.55 ? 'Positive' : r < 0.95 ? 'Neutral' : 'Negative'
  if (rating === 3) return r < 0.1 ? 'Positive' : r < 0.85 ? 'Neutral' : 'Negative'
  if (rating === 2) return r < 0.15 ? 'Neutral' : 'Negative'
  return 'Negative'
}

const POSITIVE_TEMPLATES = (facility) => [
  `Great location, very clean and easy process. Staff at the ${facility} facility was super helpful.`,
  `Excellent experience from start to finish. The team at ${facility} made move-in quick and painless.`,
  `Really happy with this unit. Access hours are convenient and the ${facility} site always feels secure.`,
]
const NEUTRAL_TEMPLATES = (facility) => [
  `Units are decent. Prices went up a bit this year at the ${facility} location.`,
  `Storage is fine overall, nothing special. The ${facility} facility could use a few more carts.`,
  `Average experience. Staff at ${facility} were polite but the checkout process took a while.`,
]
const NEGATIVE_TEMPLATES = (facility) => [
  `Had an issue with gate access not working after hours at the ${facility} facility. Took a while to get help.`,
  `Disappointed with the rate increase with no notice. Wish ${facility} communicated better.`,
  `Unit had a musty smell when we moved in at ${facility}. Still waiting on a resolution.`,
]

function reviewTextFor(sentiment, facility) {
  if (sentiment === 'Positive') return pick(POSITIVE_TEMPLATES(facility))
  if (sentiment === 'Neutral') return pick(NEUTRAL_TEMPLATES(facility))
  return pick(NEGATIVE_TEMPLATES(facility))
}

// New reviews received per month, Jan-Jun 2025 (sums to the account's lifetime review count).
const MONTHLY_NEW = [42, 48, 54, 59, 61, 64]

function randomDateInMonth(year, monthIndex, dayBias) {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  const day = Math.max(1, Math.min(daysInMonth, Math.floor(dayBias() * daysInMonth) + 1))
  const hour = Math.floor(rng() * 14) + 7 // 7am - 9pm
  const minute = Math.floor(rng() * 60)
  const d = new Date(Date.UTC(year, monthIndex, day, hour, minute))
  return d.toISOString()
}

function hoursBetween(a, b) {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 3_600_000
}

function generateReview(id, dateISO) {
  const facility = weightedPick(FACILITIES, FACILITY_WEIGHTS)
  const platform = weightedPick(PLATFORMS, PLATFORM_WEIGHTS)
  const rating = ratingFor()
  const sentiment = sentimentFor(rating)
  const customer = customerName()
  const text = reviewTextFor(sentiment, facility)

  const hoursAgo = hoursBetween(dateISO, ANCHOR_DATE + 'T23:59:59Z')
  const isRecent = hoursAgo < 72

  let status
  let responseHours
  if (isRecent) {
    status = sentiment === 'Negative' && rng() < 0.6 ? 'Awaiting Reply' : 'AI Drafted'
    responseHours = null
  } else {
    status = 'Posted'
    let h = 1 + rng() * 10
    if (rng() < 0.08) h += rng() * 15
    responseHours = Math.round(h * 10) / 10
  }

  return {
    id,
    platform,
    customer,
    rating,
    text,
    facility,
    date: dateISO,
    sentiment,
    status,
    aiReply: generateAiReply({ sentiment, facility, name: customer.split(' ')[0], reviewText: text, variantIndex: 0 }),
    draftIndex: 0,
    responseHours,
    wasEdited: false,
  }
}

function generateAll() {
  const reviews = []
  let counter = 1

  MONTHLY_NEW.forEach((count, monthIndex) => {
    for (let i = 0; i < count; i++) {
      const dateISO = randomDateInMonth(2025, monthIndex, rng)
      reviews.push(generateReview(`r${counter++}`, dateISO))
    }
  })

  return reviews
}

const generated = generateAll()

// Pin the three exact reference reviews from the product screenshot, replacing
// the closest-matching generated placeholders so headline totals stay stable.
const pinned = [
  {
    id: 'r-pin-1',
    platform: 'Google',
    customer: 'Jennifer M.',
    rating: 5,
    text: 'Great location, very clean and easy process. Staff was super helpful.',
    facility: 'Greens Valley Center',
    date: '2025-06-30T10:24:00Z',
    sentiment: 'Positive',
    status: 'AI Drafted',
    aiReply: "Thank you so much, Jennifer! We're thrilled to hear you had a smooth experience and that our team was able to help. We truly appreciate your 5-star review!",
    draftIndex: 0,
    responseHours: null,
    wasEdited: false,
  },
  {
    id: 'r-pin-2',
    platform: 'Yelp',
    customer: 'Mark T.',
    rating: 3,
    text: 'Units are decent. Prices went up a bit this year.',
    facility: 'Greens Escondido',
    date: '2025-06-30T09:02:00Z',
    sentiment: 'Neutral',
    status: 'AI Drafted',
    aiReply: "Thanks for your feedback, Mark. We strive to keep our rates competitive while continuing to improve our facilities and service. Please let us know if there's anything we can do for you.",
    draftIndex: 0,
    responseHours: null,
    wasEdited: false,
  },
  {
    id: 'r-pin-3',
    platform: 'Facebook',
    customer: 'Sarah L.',
    rating: 1,
    text: 'Had an issue with gate access not working after hours. Took a while to get help.',
    facility: 'Greens Temecula',
    date: '2025-06-29T18:48:00Z',
    sentiment: 'Negative',
    status: 'Awaiting Reply',
    aiReply: "We're sorry for the trouble with gate access, Sarah. That's not the experience we want for our customers. Please reach out to us at (916) 555-1234 so we can make this right.",
    draftIndex: 0,
    responseHours: null,
    wasEdited: false,
  },
]

// Drop the 3 generated reviews on the same day as the pinned ones so the
// pinned reviews replace rather than pad the daily totals.
const pinnedDays = new Set(pinned.map((p) => p.date.slice(0, 10)))
const withoutPinnedDays = generated.filter((r) => !pinnedDays.has(r.date.slice(0, 10)))

export const allReviews = [...pinned, ...withoutPinnedDays].sort((a, b) => (a.date < b.date ? 1 : -1))
