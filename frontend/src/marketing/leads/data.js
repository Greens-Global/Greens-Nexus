import { FACILITIES } from '../shared/facilities'
import { DATA_START, DATA_END, addDays, daysBetween } from '../shared/utils'

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

const rng = mulberry32(5150)

export const STAFF = ['Pranshu P.', 'Maria G.', 'James K.', 'Devon R.']
export const UNASSIGNED = 'Unassigned'

export const ALL_SOURCES = 'All Sources'
export const SOURCES = ['Google Ads', 'Direct', 'Organic Search', 'Referral', 'Social Media', 'Google Business Profile']
// Google Business Profile leads come from someone taking an identifying
// action on the listing (a call or a website click-through) - see
// reputation/profileAggregate.ts for the anonymous view/impression side of
// that same funnel, which never includes identity.
const SOURCE_WEIGHTS = [0.42, 0.24, 0.14, 0.05, 0.03, 0.12]

const STAGES = ['New', 'Contacted', 'Toured', 'Move-In', 'Lost']
const STAGE_WEIGHTS = [0.26, 0.22, 0.14, 0.22, 0.16]

const FIRST_NAMES = [
  'Olivia', 'Liam', 'Noah', 'Emma', 'Ava', 'Sophia', 'Mason', 'Isabella', 'Lucas', 'Mia',
  'Ethan', 'Harper', 'James', 'Evelyn', 'Benjamin', 'Abigail', 'Henry', 'Ella', 'Alexander', 'Grace',
  'Daniel', 'Chloe', 'Matthew', 'Victoria', 'Samuel', 'Zoey', 'Andrew', 'Riley', 'Joseph', 'Nora',
]
const LAST_NAMES = [
  'Anderson', 'Brooks', 'Carter', 'Diaz', 'Edwards', 'Foster', 'Garcia', 'Howard', 'Jenkins', 'Kelly',
  'Lopez', 'Mitchell', 'Nguyen', 'Ortiz', 'Parker', 'Reyes', 'Simmons', 'Torres', 'Vargas', 'Ward',
]

function pick(items) {
  return items[Math.floor(rng() * items.length)]
}

function weightedPick(items, weights) {
  const r = rng()
  let acc = 0
  for (let i = 0; i < items.length; i++) {
    acc += weights[i]
    if (r <= acc) return items[i]
  }
  return items[items.length - 1]
}

function randomDateInRange() {
  const span = daysBetween(DATA_START, DATA_END)
  return addDays(DATA_START, Math.floor(rng() * span))
}

const NOTE_TEMPLATES = {
  New: ['Submitted inquiry via website form.', 'Called in asking about unit availability.'],
  Contacted: ['Left voicemail with pricing info.', 'Emailed unit size guide and pricing.', 'Spoke with lead, scheduling a tour.'],
  Toured: ['Completed in-person tour of the facility.', 'Toured climate-controlled units, very interested.'],
  'Move-In': ['Signed lease and completed move-in.', 'Move-in scheduled, deposit received.'],
  Lost: ['Went with a competitor closer to home.', 'No longer needs storage.', 'Stopped responding after initial contact.'],
}

// A Google Business Profile lead only exists because they took an
// identifying action on the listing - distinct from the anonymous
// view/impression counts shown in Reputation's Business Profile Insights.
const GBP_NEW_NOTES = [
  'Called our number listed on the Google Business Profile.',
  'Clicked through from our Google Business Profile and submitted a website inquiry.',
]

function buildNotes(stage, capturedDate, assignedTo, source) {
  const notes = []
  const stageOrder = ['New', 'Contacted', 'Toured', 'Move-In']
  const upTo = stage === 'Lost' ? 1 + Math.floor(rng() * 2) : stageOrder.indexOf(stage) + 1
  let date = capturedDate
  for (let i = 0; i < upTo; i++) {
    const templateStage = stage === 'Lost' ? 'Contacted' : stageOrder[i]
    const text = templateStage === 'New' && source === 'Google Business Profile' ? pick(GBP_NEW_NOTES) : pick(NOTE_TEMPLATES[templateStage])
    notes.push({
      id: `note-${i}`,
      date,
      author: assignedTo === UNASSIGNED ? 'System' : assignedTo,
      text,
    })
    date = addDays(date, 1 + Math.floor(rng() * 3))
  }
  if (stage === 'Lost') {
    notes.push({ id: `note-${notes.length}`, date, author: assignedTo === UNASSIGNED ? 'System' : assignedTo, text: pick(NOTE_TEMPLATES.Lost) })
  }
  return notes
}

function buildLeads(count) {
  const leads = []
  for (let i = 0; i < count; i++) {
    const capturedDate = randomDateInRange()
    const stage = weightedPick(STAGES, STAGE_WEIGHTS)
    const source = weightedPick(SOURCES, SOURCE_WEIGHTS)
    const assignedTo = stage === 'New' && rng() < 0.4 ? UNASSIGNED : pick(STAFF)
    const notes = buildNotes(stage, capturedDate, assignedTo, source)
    const stageChangedDate = notes[notes.length - 1]?.date ?? capturedDate

    leads.push({
      id: `lead-${i + 1}`,
      name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
      email: `lead${i + 1}@example.com`,
      phone: `(916) 555-${String(1000 + Math.floor(rng() * 9000)).slice(0, 4)}`,
      facility: pick(FACILITIES),
      source,
      stage,
      capturedDate,
      stageChangedDate,
      assignedTo,
      notes,
    })
  }
  return leads.sort((a, b) => (a.capturedDate < b.capturedDate ? 1 : -1))
}

export const initialLeads = buildLeads(54)
