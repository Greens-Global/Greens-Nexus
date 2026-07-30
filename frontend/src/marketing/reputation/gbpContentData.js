import { adaptPosts, adaptPhotos, adaptQuestions } from './gbpContentApi'
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

// --- Posts ---------------------------------------------------------------

const POST_TEMPLATES = [
  { type: 'OFFER', summary: () => 'Move in this month and get 50% off your first month - limited units available.', ctaLabel: 'Redeem', ctaUrl: 'https://greensstorage.com/offers', lifespanDays: 14 },
  { type: 'STANDARD', summary: (city) => `Now offering climate-controlled units at our ${city} facility. Book a tour today.`, ctaLabel: 'Learn more', ctaUrl: 'https://greensstorage.com', lifespanDays: 7 },
  { type: 'EVENT', summary: () => 'Free moving truck with any 3-month lease, this weekend only.', ctaLabel: 'Sign up', ctaUrl: 'https://greensstorage.com/promo', lifespanDays: 10 },
]

function buildPostsForFacility(facility, rng) {
  const city = facility.replace('Greens ', '')
  const count = 2 + Math.floor(rng() * 2)
  const posts = []
  for (let i = 0; i < count; i++) {
    const template = POST_TEMPLATES[Math.floor(rng() * POST_TEMPLATES.length)]
    const createdOffset = Math.floor(rng() * 45) + 1
    const createTime = addDays(ANCHOR_DATE, -createdOffset)
    const updateTime = addDays(createTime, template.lifespanDays)
    const state = updateTime < ANCHOR_DATE ? 'EXPIRED' : 'LIVE'
    posts.push({
      name: `accounts/greens/locations/${slug(facility)}/localPosts/${i + 1}`,
      languageCode: 'en',
      summary: template.summary(city),
      callToAction: { actionType: template.ctaLabel, url: template.ctaUrl },
      media: [{ sourceUrl: `https://picsum.photos/seed/${slug(facility)}-post-${i}/480/320` }],
      topicType: template.type,
      state,
      createTime: `${createTime}T09:00:00Z`,
      updateTime: `${updateTime}T09:00:00Z`,
      locationId: facility,
    })
  }
  return posts
}

// --- Photos ----------------------------------------------------------------

const CATEGORIES = ['EXTERIOR', 'INTERIOR', 'TEAM']

// Fairfield and Georgetown are our smallest, least-staffed properties - a
// realistic candidate for a stale, unmaintained photo gallery.
const STALE_FACILITIES = new Set(['Greens Fairfield', 'Greens Georgetown'])

function buildPhotosForFacility(facility, rng) {
  const count = 8 + Math.floor(rng() * 5)
  const isStale = STALE_FACILITIES.has(facility)
  const photos = []
  for (let i = 0; i < count; i++) {
    const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)]
    const minOffset = isStale ? 70 : 3
    const maxOffset = isStale ? 150 : 120
    const offset = minOffset + Math.floor(rng() * (maxOffset - minOffset))
    const createTime = addDays(ANCHOR_DATE, -offset)
    photos.push({
      name: `accounts/greens/locations/${slug(facility)}/media/${i + 1}`,
      mediaFormat: 'PHOTO',
      sourceUrl: `https://picsum.photos/seed/${slug(facility)}-photo-${i}/400/300`,
      createTime: `${createTime}T12:00:00Z`,
      locationAssociation: { category },
      locationId: facility,
    })
  }
  return photos
}

// --- Q&A ---------------------------------------------------------------

const QUESTION_TEMPLATES = [
  { question: 'Do you have 24-hour access?', answer: 'Yes - 24/7 gate access is included with every unit at this location.' },
  { question: 'Is climate control available for all unit sizes?', answer: "We offer climate-controlled units in 5x5, 10x10, and 10x15 sizes. Give us a call and we'll find the right fit." },
  { question: 'What size unit fits a 1-bedroom apartment?', answer: 'Most 1-bedroom apartments fit comfortably in a 10x10 unit.' },
  { question: 'Do you require a long-term lease?', answer: 'No long-term commitment required - we offer flexible month-to-month leases.' },
  { question: 'Is there a discount for military or students?', answer: null },
  { question: 'Can I access my unit on holidays?', answer: null },
]

const ASKERS = ['Jordan M.', 'Casey L.', 'Taylor R.', 'Morgan B.', 'Alex P.', 'Sam K.']

function buildQuestionsForFacility(facility, rng) {
  const count = 4 + Math.floor(rng() * 3)
  const questions = []
  const shuffled = [...QUESTION_TEMPLATES].sort(() => rng() - 0.5)
  for (let i = 0; i < count && i < shuffled.length; i++) {
    const template = shuffled[i]
    const askedOffset = Math.floor(rng() * 60) + 1
    const askedDate = addDays(ANCHOR_DATE, -askedOffset)
    const answered = template.answer !== null && rng() > 0.15
    questions.push({
      name: `accounts/greens/locations/${slug(facility)}/questions/${i + 1}`,
      text: template.question,
      author: ASKERS[Math.floor(rng() * ASKERS.length)],
      createTime: `${askedDate}T15:00:00Z`,
      topAnswers: answered && template.answer
        ? [{ text: template.answer, author: 'Greens Storage', createTime: `${addDays(askedDate, 1 + Math.floor(rng() * 2))}T10:00:00Z` }]
        : undefined,
      locationId: facility,
    })
  }
  return questions
}

function fetchPostsReport() {
  return FACILITIES.flatMap((f) => buildPostsForFacility(f, mulberry32(seedFromString(`posts-${f}`))))
}
function fetchMediaReport() {
  return FACILITIES.flatMap((f) => buildPhotosForFacility(f, mulberry32(seedFromString(`media-${f}`))))
}
function fetchQuestionsReport() {
  return FACILITIES.flatMap((f) => buildQuestionsForFacility(f, mulberry32(seedFromString(`qna-${f}`))))
}

export const initialPosts = adaptPosts(fetchPostsReport())
export const initialPhotos = adaptPhotos(fetchMediaReport())
export const initialQuestions = adaptQuestions(fetchQuestionsReport())
