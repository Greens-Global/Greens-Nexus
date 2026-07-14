import { adaptPhotos, adaptQuestions } from './gbpContentApi'
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

// Yelp has no "Posts" feature (no time-limited offer/event posts like
// Google) — only photos and Q&A carry over.

// --- Photos ----------------------------------------------------------------

const CATEGORIES = ['EXTERIOR', 'INTERIOR', 'TEAM']

// Escondido and Georgetown get less attention on Yelp specifically (a
// different pair than Google's stale set, for realism).
const STALE_FACILITIES = new Set(['Greens Escondido', 'Greens Georgetown'])

function buildPhotosForFacility(facility, rng) {
  const count = 5 + Math.floor(rng() * 4)
  const isStale = STALE_FACILITIES.has(facility)
  const photos = []
  for (let i = 0; i < count; i++) {
    const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)]
    const minOffset = isStale ? 70 : 3
    const maxOffset = isStale ? 150 : 120
    const offset = minOffset + Math.floor(rng() * (maxOffset - minOffset))
    const createTime = addDays(ANCHOR_DATE, -offset)
    photos.push({
      name: `yelp-biz/${slug(facility)}/photos/${i + 1}`,
      mediaFormat: 'PHOTO',
      sourceUrl: `https://picsum.photos/seed/${slug(facility)}-yelp-photo-${i}/400/300`,
      createTime: `${createTime}T12:00:00Z`,
      locationAssociation: { category },
      locationId: facility,
    })
  }
  return photos
}

// --- Q&A ---------------------------------------------------------------

const QUESTION_TEMPLATES = [
  { question: 'Do you sell moving boxes and supplies on-site?', answer: 'Yes — boxes, tape, and locks are available for purchase at the front office.' },
  { question: 'Is there a senior or first-responder discount?', answer: 'We offer 10% off for seniors and first responders — just ask our staff when you sign up.' },
  { question: 'Do you have drive-up units?', answer: 'Most of our ground-floor units are drive-up accessible for easy loading.' },
  { question: 'What are your office hours?', answer: 'Our office is open 9am-6pm daily; gate access is 24/7 for tenants.' },
  { question: 'Is renters insurance required?', answer: null },
  { question: 'Do you offer month-to-month contracts?', answer: null },
]

const ASKERS = ['Riley T.', 'Jamie C.', 'Quinn D.', 'Drew M.', 'Cameron S.']

function buildQuestionsForFacility(facility, rng) {
  const count = 3 + Math.floor(rng() * 3)
  const questions = []
  const shuffled = [...QUESTION_TEMPLATES].sort(() => rng() - 0.5)
  for (let i = 0; i < count && i < shuffled.length; i++) {
    const template = shuffled[i]
    const askedOffset = Math.floor(rng() * 60) + 1
    const askedDate = addDays(ANCHOR_DATE, -askedOffset)
    const answered = template.answer !== null && rng() > 0.15
    questions.push({
      name: `yelp-biz/${slug(facility)}/questions/${i + 1}`,
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

function fetchMediaReport() {
  return FACILITIES.flatMap((f) => buildPhotosForFacility(f, mulberry32(seedFromString(`yelp-media-${f}`))))
}
function fetchQuestionsReport() {
  return FACILITIES.flatMap((f) => buildQuestionsForFacility(f, mulberry32(seedFromString(`yelp-qna-${f}`))))
}

export const initialYelpPhotos = adaptPhotos(fetchMediaReport())
export const initialYelpQuestions = adaptQuestions(fetchQuestionsReport())
